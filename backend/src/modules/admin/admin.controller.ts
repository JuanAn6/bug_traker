import { statfs } from 'node:fs/promises';
import {
  Body, Controller, Get, Headers, HttpCode, Inject, Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { hash } from '@node-rs/argon2';
import { createSeed } from '../../shared/seed';
import type { Db as DbJson } from '../../shared/models';
import type { Env } from '../../core/config/env.schema';
import { PermissionDeniedError, ValidationError } from '../../common/errors/domain-error';
import { Requires } from '../../common/decorators/requires.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DRIZZLE, type Db } from '../../core/database/drizzle.service';
import { ProjectTreeService } from '../../core/project-tree/project-tree.service';
import { WorkflowService } from '../../core/workflow/workflow.service';
import type { AuthUser } from '../auth/auth.types';
import { exportDb } from './db-export';
import { ingestDb } from './db-import';

@Controller('admin')
export class AdminController {
  private readonly demoMode: boolean;
  private readonly seedPassword: string;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly tree: ProjectTreeService,
    private readonly workflow: WorkflowService,
    private readonly config: ConfigService<Env, true>,
  ) {
    this.demoMode = config.get('DEMO_MODE', { infer: true });
    this.seedPassword = config.get('SEED_PASSWORD', { infer: true });
  }

  /**
   * The whole database in the frontend's own `Db` shape.
   *
   * This is the contract test for the schema: the output must load in the running Angular app
   * through Settings → Import without modification. If the normalized tables cannot be
   * reassembled into the browser's model, something was lost on the way in.
   */
  @Get('export')
  @Requires('manageUsers')
  export() {
    return exportDb(this.db);
  }

  /**
   * Replaces the database with an uploaded `Db` JSON.
   *
   * Destructive, so it needs `manageUsers` AND either DEMO_MODE or an explicit confirmation
   * header — a misplaced curl should not be able to wipe a real deployment.
   */
  @Post('import')
  @HttpCode(200)
  @Requires('manageUsers')
  async import(
    @Body() body: DbJson,
    @Headers('x-admin-import') confirm?: string,
  ) {
    this.assertDestructiveAllowed(confirm);
    if (!body || typeof body !== 'object') {
      throw new ValidationError('errors.validation', 'A Db JSON body is required');
    }
    const counts = await ingestDb(this.db, body, { mode: 'replace', source: 'api' });
    await this.invalidateCaches();
    return { counts };
  }

  /** Back to the demo dataset. Same guard as import, for the same reason. */
  @Post('reset')
  @HttpCode(200)
  @Requires('manageUsers')
  async reset(@Headers('x-admin-import') confirm?: string) {
    this.assertDestructiveAllowed(confirm);
    const seedNow = this.config.get('SEED_NOW', { infer: true });
    const counts = await ingestDb(this.db, createSeed(new Date(seedNow).getTime()), {
      mode: 'replace',
      passwordHash: await hash(this.seedPassword, { algorithm: 2 }),
      source: 'api-reset',
    });
    await this.invalidateCaches();
    return { counts };
  }

  /**
   * Recomputes every denormalized column from the source rows.
   *
   * These are maintained incrementally on every write, so a mismatch means a bug — which is why
   * this reports what it changed rather than silently repairing it.
   */
  @Post('recount')
  @HttpCode(200)
  @Requires('manageUsers')
  async recount() {
    const before = await this.integrityCheck();
    await this.db.execute(sql`
      UPDATE issues i SET
        noteCount = (SELECT COUNT(*) FROM comments c WHERE c.issueId = i.id AND c.deletedAt IS NULL),
        attachmentCount = (SELECT COUNT(*) FROM attachments a
                           WHERE a.issueId = i.id AND a.current = 1 AND a.deletedAt IS NULL),
        historyCount = (SELECT COUNT(*) FROM historyEntries h WHERE h.issueId = i.id),
        tagsSorted = COALESCE((SELECT GROUP_CONCAT(t.tag ORDER BY t.sortOrder)
                               FROM issueTags t WHERE t.issueId = i.id), '')
    `);
    return { repaired: before };
  }

  /** What the settings page shows: row counts, disk usage and the integrity report. */
  @Get('storage')
  @Requires('manageUsers')
  async storage(@CurrentUser() _actor: AuthUser) {
    const [counts] = await this.db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM issues WHERE deletedAt IS NULL) AS issues,
        (SELECT COUNT(*) FROM comments WHERE deletedAt IS NULL) AS comments,
        (SELECT COUNT(*) FROM attachments WHERE deletedAt IS NULL) AS attachments,
        (SELECT COALESCE(SUM(size), 0) FROM blobs) AS blobBytes,
        (SELECT COUNT(*) FROM historyEntries) AS historyRows,
        (SELECT COUNT(*) FROM outbox WHERE dispatchedAt IS NULL) AS pendingEvents
    `);

    const [sizes] = await this.db.execute(sql`
      SELECT COALESCE(SUM(data_length + index_length), 0) AS bytes
      FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
    `);

    let disk: { freeBytes: number; totalBytes: number } | null = null;
    try {
      const fs = await statfs(this.config.get('STORAGE_ROOT', { infer: true }));
      disk = { freeBytes: Number(fs.bsize) * Number(fs.bavail), totalBytes: Number(fs.bsize) * Number(fs.blocks) };
    } catch {
      // The storage root does not exist until the first upload; not an error to report here.
    }

    const rows = (counts as unknown as Array<Record<string, unknown>>)[0] ?? {};
    const size = (sizes as unknown as Array<Record<string, unknown>>)[0] ?? {};
    return {
      counts: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, Number(v)])),
      databaseBytes: Number(size['bytes'] ?? 0),
      disk,
      integrity: await this.integrityCheck(),
    };
  }

  /**
   * The invariants the schema relies on but cannot enforce.
   *
   * Relationship symmetry is maintained transactionally in one repository method rather than by a
   * constraint, and the denormalized counters are maintained incrementally — so both deserve an
   * auditable check. Every figure here should be zero.
   */
  private async integrityCheck() {
    const [rows] = await this.db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM issueRelationships a
         LEFT JOIN issueRelationships b ON b.issueId = a.otherIssueId AND b.otherIssueId = a.issueId
         WHERE b.issueId IS NULL) AS asymmetricRelationships,
        (SELECT COUNT(*) FROM issues i LEFT JOIN projectCategories c
           ON c.projectId = i.projectId AND c.name = i.category
         WHERE c.name IS NULL AND i.deletedAt IS NULL) AS orphanCategories,
        (SELECT COUNT(*) FROM issues i WHERE i.deletedAt IS NULL AND i.noteCount <>
           (SELECT COUNT(*) FROM comments c WHERE c.issueId = i.id AND c.deletedAt IS NULL)) AS wrongNoteCounts,
        (SELECT COUNT(*) FROM issues i WHERE i.deletedAt IS NULL AND i.historyCount <>
           (SELECT COUNT(*) FROM historyEntries h WHERE h.issueId = i.id)) AS wrongHistoryCounts,
        (SELECT COUNT(*) FROM blobs b WHERE b.refCount <>
           (SELECT COUNT(*) FROM attachments a WHERE a.blobHash = b.hash AND a.deletedAt IS NULL)) AS wrongBlobRefCounts
    `);
    const row = (rows as unknown as Array<Record<string, unknown>>)[0] ?? {};
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
  }

  private assertDestructiveAllowed(confirm?: string): void {
    if (this.demoMode) return;
    if (confirm === 'confirm') return;
    throw new PermissionDeniedError('admin.destructive');
  }

  /** Both caches hold data the import just replaced wholesale. */
  private async invalidateCaches(): Promise<void> {
    await this.workflow.invalidate();
    await this.tree.invalidate();
  }
}
