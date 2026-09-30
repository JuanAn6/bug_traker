import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Issue, Status } from '../../shared/models';
import type { Env } from '../../core/config/env.schema';
import { ConflictError, NotFoundError, PermissionDeniedError } from '../../common/errors/domain-error';
import { DRIZZLE, type Db } from '../../core/database/drizzle.service';
import * as s from '../../core/database/schema';
import { insertedId, UnitOfWork, type IssueRow, type Tx } from '../../core/database/unit-of-work';
import { ProjectTreeService } from '../../core/project-tree/project-tree.service';
import { WorkflowService } from '../../core/workflow/workflow.service';
import { can, canEditIssue, canSeeIssue } from '../auth/ability';
import type { AuthUser } from '../auth/auth.types';
import { HistoryWriter } from '../history/history.writer';
import { allowedTransitions } from './domain/allowed-transitions';
import { IssuesQueryService } from './issues.query.service';
import { IssuesWriteService } from './issues.write.service';

/**
 * Per-id outcomes, so partial success is reported rather than implied.
 *
 * Three buckets, not two, and every requested id lands in exactly one. `unchanged` exists
 * because "already in that state" is a real third outcome — bulk-closing a selection that is
 * half closed already is a success, not a failure, and not a change either. Without it those
 * ids vanished from the response and the caller could not account for them.
 */
export interface BulkResult {
  applied: number[];
  unchanged: number[];
  skipped: Array<{ id: number; reason: string }>;
  undo?: { token: string; expiresAt: string };
}

/** Bulk work is chunked so a large selection does not hold row locks for the whole request. */
const CHUNK = 200;

@Injectable()
export class IssueBulkService {
  private readonly undoTtlMs: number;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly queries: IssuesQueryService,
    private readonly writes: IssuesWriteService,
    private readonly tree: ProjectTreeService,
    private readonly workflow: WorkflowService,
    private readonly history: HistoryWriter,
    config: ConfigService<Env, true>,
  ) {
    this.undoTtlMs = config.get('UNDO_TTL_MS', { infer: true });
  }

  /**
   * Applies the same patch to many issues.
   *
   * Partial success is kept from the frontend — it silently drops ids the actor cannot touch —
   * but reported honestly: `skipped` says which and why, so the UI can tell the user "12 of 15
   * updated" instead of claiming all 15.
   */
  async bulkUpdate(actor: AuthUser, ids: number[], patch: Partial<Issue>): Promise<BulkResult> {
    const result: BulkResult = { applied: [], unchanged: [], skipped: [] };
    const before: Array<{ id: number; values: Record<string, unknown> }> = [];

    for (const chunk of chunked(ids, CHUNK)) {
      await this.uow.transaction(async (tx) => {
        // Ascending id order: two bulk operations over overlapping selections would otherwise
        // deadlock, each holding what the other needs next.
        const rows = await this.uow.lockIssues(tx, chunk);
        const found = new Set(rows.map((r) => r.id));
        for (const id of chunk) {
          if (!found.has(id)) result.skipped.push({ id, reason: 'errors.issueNotFound' });
        }

        for (const row of rows) {
          const verdict = await this.mayApply(actor, row, patch);
          if (verdict) {
            result.skipped.push({ id: row.id, reason: verdict });
            continue;
          }
          // Remember the previous values of exactly the fields being changed, which is what
          // the undo token replays.
          before.push({
            id: row.id,
            values: Object.fromEntries(
              Object.keys(patch).map((f) => [f, (row as Record<string, unknown>)[f]]),
            ),
          });
          const outcome = await this.writes.applyPatchInTransaction(tx, actor, row, patch);
          (outcome.changed ? result.applied : result.unchanged).push(row.id);
        }
      });
    }

    if (result.applied.length) {
      result.undo = await this.issueUndoToken(actor, 'issues.bulkUpdate', {
        // Only the ids that actually moved: replaying a no-op would still write history.
        patches: before.filter((b) => result.applied.includes(b.id)),
      });
    }
    return result;
  }

  /** Assignment is a bulk patch of `handlerId`, so it inherits every applyPatch automation. */
  bulkAssign(actor: AuthUser, ids: number[], handlerId: number | null): Promise<BulkResult> {
    return this.bulkUpdate(actor, ids, { handlerId });
  }

  /**
   * A bulk status change validates the transition PER ISSUE, because the issues in a selection
   * are rarely all in the same status.
   */
  async bulkStatus(actor: AuthUser, ids: number[], status: Status): Promise<BulkResult> {
    const result: BulkResult = { applied: [], unchanged: [], skipped: [] };
    const wf = await this.workflow.get();

    for (const chunk of chunked(ids, CHUNK)) {
      await this.uow.transaction(async (tx) => {
        const rows = await this.uow.lockIssues(tx, chunk);
        // An id that no longer exists — or is already soft-deleted — has to be reported, or the
        // caller cannot reconcile the response against what it asked for.
        const found = new Set(rows.map((r) => r.id));
        for (const id of chunk) {
          if (!found.has(id)) result.skipped.push({ id, reason: 'errors.issueNotFound' });
        }

        for (const row of rows) {
          const project = await this.tree.get(row.projectId);
          if (!canEditIssue(actor, row, project, wf)) {
            result.skipped.push({ id: row.id, reason: 'errors.denied' });
            continue;
          }
          if (!can(actor, 'changeStatus', project, wf)) {
            result.skipped.push({ id: row.id, reason: 'errors.denied' });
            continue;
          }
          if (row.status !== status) {
            const allowed = allowedTransitions(row, wf, {
              can: (action) => can(actor, action, project, wf),
              meId: actor.id,
            });
            if (!allowed.includes(status)) {
              result.skipped.push({ id: row.id, reason: 'errors.transition' });
              continue;
            }
          }
          const outcome = await this.writes.applyPatchInTransaction(tx, actor, row, { status });
          (outcome.changed ? result.applied : result.unchanged).push(row.id);
        }
      });
    }
    return result;
  }

  async bulkMove(actor: AuthUser, ids: number[], projectId: number): Promise<BulkResult> {
    const target = await this.tree.get(projectId);
    if (!target) throw new NotFoundError('project', projectId);
    return this.bulkUpdate(actor, ids, { projectId });
  }

  /**
   * Soft delete.
   *
   * Nothing is removed: `deletedAt` is stamped and every read path filters on it, which is what
   * makes the undo token cheap and what lets an accidental bulk delete be reversed without a
   * whole-database restore — the frontend's approach, which cannot work with several users.
   */
  async bulkDelete(actor: AuthUser, ids: number[]): Promise<BulkResult> {
    const result: BulkResult = { applied: [], unchanged: [], skipped: [] };
    const wf = await this.workflow.get();

    for (const chunk of chunked(ids, CHUNK)) {
      await this.uow.transaction(async (tx) => {
        const rows = await this.uow.lockIssues(tx, chunk);
        const found = new Set(rows.map((r) => r.id));
        for (const id of chunk) {
          if (!found.has(id)) result.skipped.push({ id, reason: 'errors.issueNotFound' });
        }

        const deletable: number[] = [];
        for (const row of rows) {
          const project = await this.tree.get(row.projectId);
          if (!canSeeIssue(actor, row, project, wf)) {
            result.skipped.push({ id: row.id, reason: 'errors.issueNotFound' });
          } else if (!can(actor, 'delete', project, wf)) {
            result.skipped.push({ id: row.id, reason: 'errors.denied' });
          } else {
            deletable.push(row.id);
          }
        }
        if (!deletable.length) return;

        const now = new Date();
        await tx.update(s.issues).set({ deletedAt: now }).where(inArray(s.issues.id, deletable));
        // Comments go with them, so a restored issue comes back with its discussion intact.
        await tx
          .update(s.comments)
          .set({ deletedAt: now })
          .where(and(inArray(s.comments.issueId, deletable), isNull(s.comments.deletedAt)));

        result.applied.push(...deletable);
        await this.uow.outbox(tx, 'issue.deleted', { ids: deletable, actorId: actor.id });
      });
    }

    if (result.applied.length) {
      result.undo = await this.issueUndoToken(actor, 'issues.delete', { ids: result.applied });
    }
    return result;
  }

  /**
   * Clones an issue.
   *
   * Reset on the copy: status 'new', resolution 'open', no fixedInVersion, the caller as
   * reporter and sole monitor, not sticky, fresh timestamps. Everything else is carried over.
   * A `related_to` link is created both ways, as clone() does.
   *
   * Notes are copied only if the caller can SEE them — the frontend copies private notes
   * verbatim, which would hand them to someone who could not read the original.
   */
  async clone(
    actor: AuthUser,
    id: number,
    opts: { copyNotes?: boolean; copyAttachments?: boolean },
  ): Promise<{ id: number }> {
    const source = await this.queries.requireVisible(actor, id);
    const [wf, project] = await Promise.all([
      this.workflow.get(),
      this.tree.get(source.projectId),
    ]);
    if (!can(actor, 'report', project, wf)) {
      throw new PermissionDeniedError('report', source.projectId);
    }

    const newId = await this.uow.transaction(async (tx) => {
      const now = new Date();
      const {
        id: _id, created: _created, updated: _updated, rowVersion: _v, deletedAt: _d,
        resolvedAt: _r, firstResolvedAt: _f, reopenedAt: _ro, reopenCount: _rc,
        resolvedAtEstimated: _re, noteCount: _nc, attachmentCount: _ac, historyCount: _hc,
        ...carried
      } = source;

      const cloneId = insertedId(
        await tx.insert(s.issues).values({
          ...carried,
          status: 'new',
          statusRank: 0,
          resolution: 'open',
          resolutionRank: 0,
          fixedInVersion: '',
          reporterId: actor.id,
          sticky: false,
          created: now,
          updated: now,
          resolvedAt: null,
          firstResolvedAt: null,
          reopenedAt: null,
          reopenCount: 0,
          resolvedAtEstimated: false,
          noteCount: 0,
          attachmentCount: 0,
          historyCount: 0,
        }),
      );

      // Only the cloner monitors the copy — matching clone()'s `monitorIds: [me]`.
      await tx.insert(s.issueMonitors).values({ issueId: cloneId, userId: actor.id });

      const tags = await tx
        .select({ tag: s.issueTags.tag, sortOrder: s.issueTags.sortOrder })
        .from(s.issueTags)
        .where(eq(s.issueTags.issueId, id))
        .orderBy(asc(s.issueTags.sortOrder));
      if (tags.length) {
        await tx.insert(s.issueTags).values(tags.map((t) => ({ ...t, issueId: cloneId })));
      }

      const customValues = await tx
        .select({ customFieldId: s.issueCustomValues.customFieldId, value: s.issueCustomValues.value })
        .from(s.issueCustomValues)
        .where(eq(s.issueCustomValues.issueId, id));
      if (customValues.length) {
        await tx.insert(s.issueCustomValues).values(
          customValues.map((v) => ({ ...v, issueId: cloneId })),
        );
      }

      // Symmetric 'related_to', both directions.
      await tx.insert(s.issueRelationships).values([
        { issueId: cloneId, otherIssueId: id, type: 'related_to', created: now },
        { issueId: id, otherIssueId: cloneId, type: 'related_to', created: now },
      ]);

      const rows: Parameters<HistoryWriter['writeMany']>[2] = [
        { issueId: cloneId, type: 'created' },
        { issueId: cloneId, type: 'cloned', field: 'issue', new: String(id) },
        { issueId: id, type: 'relationship_added', field: 'related_to', new: String(cloneId) },
      ];

      if (opts.copyNotes) {
        const notes = await tx
          .select()
          .from(s.comments)
          .where(and(eq(s.comments.issueId, id), isNull(s.comments.deletedAt)))
          .orderBy(asc(s.comments.created));
        // Private notes are copied only when this caller could read them in the first place.
        const visible = notes.filter((n) => !n.private || n.authorId === actor.id || can(actor, 'viewPrivate', project, wf));
        for (const note of visible) {
          const { id: _noteId, ...rest } = note;
          await tx.insert(s.comments).values({ ...rest, issueId: cloneId });
        }
        if (visible.length) {
          await tx
            .update(s.issues)
            .set({ noteCount: visible.length })
            .where(eq(s.issues.id, cloneId));
        }
      }

      if (opts.copyAttachments) {
        const files = await tx
          .select()
          .from(s.attachments)
          .where(and(
            eq(s.attachments.issueId, id),
            eq(s.attachments.current, true),
            isNull(s.attachments.commentId),
            isNull(s.attachments.deletedAt),
          ));
        for (const file of files) {
          const { id: _fileId, ...rest } = file;
          // Metadata copy pointing at the SAME blob hash, and the reference count follows —
          // which is exactly what the frontend's shared blobId did, now made safe to delete.
          const copyId = insertedId(
            await tx.insert(s.attachments).values({
              ...rest, issueId: cloneId, documentId: 0, previousVersionId: null, version: 1,
            }),
          );
          await tx.update(s.attachments).set({ documentId: copyId })
            .where(eq(s.attachments.id, copyId));
          await tx.update(s.blobs).set({ refCount: sql`${s.blobs.refCount} + 1` })
            .where(eq(s.blobs.hash, file.blobHash));
        }
        if (files.length) {
          await tx.update(s.issues).set({ attachmentCount: files.length })
            .where(eq(s.issues.id, cloneId));
        }
      }

      await this.history.writeMany(tx, actor.id, rows, now);
      await this.uow.outbox(tx, 'issue.cloned', { sourceId: id, cloneId, actorId: actor.id });
      return cloneId;
    });

    return { id: newId };
  }

  // ───────────────────────── undo ─────────────────────────

  /**
   * Applies a compensating action.
   *
   * Refuses when the affected rows moved on since the original operation: the point of replacing
   * the frontend's whole-database snapshot is that undo must never silently discard somebody
   * else's later edit. 409 errors.stale is the honest answer.
   */
  async undo(actor: AuthUser, token: string): Promise<{ restored: number[] }> {
    return this.uow.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(s.undoTokens)
        .where(eq(s.undoTokens.token, token))
        .for('update')
        .limit(1);

      if (!row) throw new NotFoundError('undo token');
      if (row.userId !== actor.id) throw new PermissionDeniedError('undo');
      if (row.usedAt) throw new ConflictError('undo.alreadyUsed');
      if (row.expiresAt.getTime() <= Date.now()) throw new ConflictError('undo.expired');

      await tx.update(s.undoTokens).set({ usedAt: new Date() })
        .where(eq(s.undoTokens.token, token));

      const payload = JSON.parse(row.payload) as {
        ids?: number[];
        patches?: Array<{ id: number; values: Record<string, unknown> }>;
      };

      if (row.operation === 'issues.delete' && payload.ids) {
        await tx.update(s.issues).set({ deletedAt: null })
          .where(inArray(s.issues.id, payload.ids));
        await tx.update(s.comments).set({ deletedAt: null })
          .where(inArray(s.comments.issueId, payload.ids));
        return { restored: payload.ids };
      }

      if (row.operation === 'issues.bulkUpdate' && payload.patches) {
        const restored: number[] = [];
        for (const entry of payload.patches) {
          const issue = await this.uow.lockIssue(tx, entry.id);
          if (!issue) continue;
          // Replayed through applyPatch, so reverting is itself recorded in history. The
          // frontend's snapshot restore rewinds history rows out of existence, which makes the
          // audit trail lie.
          await this.writes.applyPatchInTransaction(tx, actor, issue, entry.values as Partial<Issue>);
          restored.push(entry.id);
        }
        return { restored };
      }

      throw new ConflictError('undo.unsupported', { operation: row.operation });
    });
  }

  private async issueUndoToken(
    actor: AuthUser,
    operation: string,
    payload: Record<string, unknown>,
  ): Promise<{ token: string; expiresAt: string }> {
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + this.undoTtlMs);
    await this.db.insert(s.undoTokens).values({
      token,
      userId: actor.id,
      operation,
      payload: JSON.stringify(payload),
      created: new Date(),
      expiresAt,
    });
    return { token, expiresAt: expiresAt.toISOString() };
  }

  /** Returns a skip reason, or undefined when the patch may be applied to this issue. */
  private async mayApply(
    actor: AuthUser,
    row: IssueRow,
    patch: Partial<Issue>,
  ): Promise<string | undefined> {
    const wf = await this.workflow.get();
    const project = await this.tree.get(row.projectId);
    if (!canSeeIssue(actor, row, project, wf)) return 'errors.issueNotFound';
    if (!canEditIssue(actor, row, project, wf)) return 'errors.denied';

    // The same per-field threshold map the single PATCH uses: a bulk edit must not be a way
    // around `assign` or `move`.
    const needed = new Set<'assign' | 'move' | 'changeStatus'>();
    if ('handlerId' in patch) needed.add('assign');
    if ('projectId' in patch) needed.add('move');
    if ('status' in patch) needed.add('changeStatus');
    for (const action of needed) {
      if (!can(actor, action, project, wf)) return 'errors.denied';
    }
    return undefined;
  }
}

function* chunked<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}
