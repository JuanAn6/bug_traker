import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { isResolved } from '../../shared/config';
import type { Issue, RichText, Status } from '../../shared/models';
import { mentionedUserIds, plainText } from '../../shared/rich';
import {
  ConflictError, NotFoundError, PermissionDeniedError, TransitionNotAllowedError,
  ValidationError,
} from '../../common/errors/domain-error';
import { DRIZZLE, type Db } from '../../core/database/drizzle.service';
import * as s from '../../core/database/schema';
import { insertedId, UnitOfWork, type IssueRow, type Tx } from '../../core/database/unit-of-work';
import { ProjectTreeService } from '../../core/project-tree/project-tree.service';
import { WorkflowService } from '../../core/workflow/workflow.service';
import { can, canEditIssue, canSeeProject } from '../auth/ability';
import type { AuthUser } from '../auth/auth.types';
import { HistoryWriter } from '../history/history.writer';
import { NotificationFanout, type NotificationDraft } from '../notifications/notification.fanout';
import { allowedTransitions } from './domain/allowed-transitions';
import { applyPatch, type IssueAggregate } from './domain/apply-patch';
import { rankColumns } from './domain/rank';
import { commentSearchNorm, issueSearchNorm, tagsSorted } from './domain/search-text';
import { IssuesQueryService } from './issues.query.service';

export interface CreateIssueInput {
  projectId: number;
  category: string;
  summary: string;
  description?: RichText;
  stepsToReproduce?: RichText;
  additionalInfo?: RichText;
  status?: Status;
  resolution?: Issue['resolution'];
  priority?: Issue['priority'];
  severity?: Issue['severity'];
  reproducibility?: Issue['reproducibility'];
  platform?: string;
  os?: string;
  osBuild?: string;
  productVersion?: string;
  targetVersion?: string;
  fixedInVersion?: string;
  sprintId?: number | null;
  handlerId?: number | null;
  viewState?: Issue['viewState'];
  dueDate?: string | null;
  estimate?: number | null;
  storyPoints?: number | null;
  tags?: string[];
  customFields?: Record<number, string>;
  /**
   * Reporting on behalf of somebody else. Honoured only for callers holding `manageUsers`;
   * the frontend takes `draft.reporterId ?? me` from the client unconditionally, which lets
   * anyone forge a reporter.
   */
  reporterId?: number;
}

export interface StatusChangeInput {
  status: Status;
  resolution?: Issue['resolution'];
  fixedInVersion?: string;
  handlerId?: number | null;
}

/** Bulk operations report per-id outcomes rather than pretending everything worked. */
export interface BulkResult {
  applied: number[];
  skipped: Array<{ id: number; reason: string }>;
}

/** The fields a generic PATCH may touch, each with the threshold that governs it. */
const PATCHABLE: Record<string, 'update' | 'assign' | 'move' | 'changeStatus'> = {
  summary: 'update', description: 'update', stepsToReproduce: 'update', additionalInfo: 'update',
  category: 'update', priority: 'update', severity: 'update', reproducibility: 'update',
  platform: 'update', os: 'update', osBuild: 'update', productVersion: 'update',
  targetVersion: 'update', fixedInVersion: 'update', dueDate: 'update', estimate: 'update',
  storyPoints: 'update', viewState: 'update', sticky: 'update', sprintId: 'update',
  handlerId: 'assign',
  projectId: 'move',
  status: 'changeStatus',
};

@Injectable()
export class IssuesWriteService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly queries: IssuesQueryService,
    private readonly tree: ProjectTreeService,
    private readonly workflow: WorkflowService,
    private readonly history: HistoryWriter,
    private readonly fanout: NotificationFanout,
  ) {}

  // ─────────────────────────── create ───────────────────────────

  async create(actor: AuthUser, input: CreateIssueInput): Promise<{ id: number }> {
    const wf = await this.workflow.get();
    const project = await this.tree.get(input.projectId);
    if (!project) throw new NotFoundError('project', input.projectId);

    // Visibility first, and as a 404: `report` has a threshold of 25, which almost everyone
    // clears, so checking it alone let any authenticated user file an issue into a private
    // project they cannot even open. The frontend never reaches this because its project
    // switcher only lists visible projects — over HTTP it was one request away.
    if (!canSeeProject(actor, project)) throw new NotFoundError('project', input.projectId);
    if (!can(actor, 'report', project, wf)) throw new PermissionDeniedError('report', input.projectId);

    // Reporting as somebody else is an administrative act, not a client-supplied field.
    if (input.reporterId !== undefined && input.reporterId !== actor.id) {
      if (!can(actor, 'manageUsers', project, wf)) throw new PermissionDeniedError('manageUsers');
    }
    const reporterId = input.reporterId ?? actor.id;

    const category = await this.resolveCategory(input.projectId, input.category);
    // The category's default handler applies only when the caller did not name one — matching
    // report()'s `draft.handlerId ?? category.defaultHandlerId ?? null`.
    const handlerId = input.handlerId ?? category.defaultHandlerId ?? null;

    const requested: Status = input.status ?? 'new';
    // Auto-assign on creation is narrower than on patch: only from 'new'.
    const status: Status =
      handlerId && requested === 'new' && wf.autoAssignStatus ? 'assigned' : requested;

    const now = new Date();
    const tags = [...new Set((input.tags ?? []).map(normalizeTag).filter(Boolean))];
    const resolution = input.resolution ?? 'open';

    const id = await this.uow.transaction(async (tx) => {
      const values = {
        projectId: input.projectId,
        sprintId: input.sprintId ?? null,
        category: category.name,
        summary: input.summary.slice(0, 128),
        description: input.description ?? null,
        stepsToReproduce: input.stepsToReproduce ?? null,
        additionalInfo: input.additionalInfo ?? null,
        status,
        resolution,
        priority: input.priority ?? 'normal',
        severity: input.severity ?? 'minor',
        reproducibility: input.reproducibility ?? 'have_not_tried',
        ...rankColumns({
          status,
          resolution,
          priority: input.priority ?? 'normal',
          severity: input.severity ?? 'minor',
          reproducibility: input.reproducibility ?? 'have_not_tried',
        }),
        platform: input.platform ?? '',
        os: input.os ?? '',
        osBuild: input.osBuild ?? '',
        productVersion: input.productVersion ?? '',
        targetVersion: input.targetVersion ?? '',
        fixedInVersion: input.fixedInVersion ?? '',
        reporterId,
        handlerId,
        viewState: input.viewState ?? 'public',
        sticky: false,
        dueDate: input.dueDate ?? null,
        estimate: input.estimate ?? null,
        storyPoints: input.storyPoints ?? null,
        created: now,
        updated: now,
        searchNorm: issueSearchNorm({
          summary: input.summary,
          description: input.description ?? null,
          stepsToReproduce: input.stepsToReproduce ?? null,
          additionalInfo: input.additionalInfo ?? null,
          tags,
        }),
        tagsSorted: tagsSorted(tags),
        resolvedAt: isResolved(status) ? now : null,
        firstResolvedAt: isResolved(status) ? now : null,
      };

      const newId = insertedId(await tx.insert(s.issues).values(values));

      if (tags.length) {
        await tx.insert(s.issueTags).values(
          tags.map((tag, sortOrder) => ({ issueId: newId, tag, sortOrder })),
        );
      }

      // Reporter and handler are monitored from the start, deduplicated.
      const monitors = [...new Set([reporterId, ...(handlerId ? [handlerId] : [])])];
      await tx.insert(s.issueMonitors).values(monitors.map((userId) => ({ issueId: newId, userId })));

      if (input.customFields) {
        const entries = Object.entries(input.customFields).filter(([, v]) => v !== undefined);
        if (entries.length) {
          await tx.insert(s.issueCustomValues).values(
            entries.map(([fieldId, value]) => ({
              issueId: newId,
              customFieldId: Number(fieldId),
              value: String(value),
            })),
          );
        }
      }

      // Exactly one 'created' row — no per-field history on creation.
      await this.history.writeMany(tx, actor.id, [{ issueId: newId, type: 'created' }], now);

      const drafts: NotificationDraft[] = [];
      if (handlerId) {
        drafts.push({
          type: 'assigned', issueId: newId, projectId: input.projectId,
          recipients: [handlerId], subject: values.summary,
        });
      }
      const mentioned = [
        ...mentionedUserIds(input.description ?? null),
        ...mentionedUserIds(input.stepsToReproduce ?? null),
        ...mentionedUserIds(input.additionalInfo ?? null),
      ];
      if (mentioned.length) {
        drafts.push({
          type: 'mentioned', issueId: newId, projectId: input.projectId,
          recipients: mentioned, subject: values.summary,
        });
      }
      await this.fanout.emit(tx, actor.id, drafts);
      await this.uow.outbox(tx, 'issue.created', { issueId: newId, actorId: actor.id });
      return newId;
    });

    return { id };
  }

  // ─────────────────────────── update ───────────────────────────

  async update(
    actor: AuthUser,
    id: number,
    patch: Partial<Issue>,
    expectedVersion?: number,
  ): Promise<{ changed: boolean }> {
    // Loaded through the visibility-scoped reader first, so an issue the actor cannot see
    // 404s before anything is locked.
    await this.queries.requireVisible(actor, id);

    return this.uow.transaction(async (tx) => {
      const row = await this.uow.lockIssue(tx, id);
      if (!row) throw new NotFoundError('issue', id);
      if (expectedVersion !== undefined && row.rowVersion !== expectedVersion) {
        throw new ConflictError('errors.stale', { id });
      }

      const wf = await this.workflow.get();
      const project = await this.tree.get(row.projectId);
      if (!canEditIssue(actor, row, project, wf)) {
        throw new PermissionDeniedError('update', row.projectId);
      }
      await this.assertPatchAllowed(actor, row, patch);

      if (patch.status !== undefined && patch.status !== row.status) {
        // assertPatchAllowed already required `changeStatus`, so reaching here means the
        // threshold is held and any rejection below is genuinely the workflow's.
        const allowed = allowedTransitions(row, wf, {
          can: (action) => can(actor, action, project, wf),
          meId: actor.id,
        });
        if (!allowed.includes(patch.status)) {
          throw new TransitionNotAllowedError(row.status, patch.status);
        }
      }
      // A project change has to carry the name-based fields with it, or they become orphans
      // that no longer exist in the destination.
      if (patch.projectId !== undefined && patch.projectId !== row.projectId) {
        Object.assign(patch, await this.remapForProject(patch.projectId, row, patch));
      } else if (patch.category !== undefined) {
        patch.category = (await this.resolveCategory(row.projectId, patch.category)).name;
      }

      return this.applyAndPersist(tx, actor, row, patch);
    });
  }

  // ───────────────────────── change status ─────────────────────────

  /**
   * The single entry point for resolve, close and reopen.
   *
   * There are no separate methods for those in the frontend either: they are all a status
   * change, and the resolution that goes with them is derived by applyPatch — 'fixed' on
   * crossing into resolved, 'reopened' on crossing back out.
   *
   * An optional note is written in the SAME transaction, which is what makes "resolve with a
   * comment" atomic rather than two requests that can half-fail.
   */
  async changeStatus(
    actor: AuthUser,
    id: number,
    input: StatusChangeInput & { note?: RichText; notePrivate?: boolean; timeSpent?: number },
  ): Promise<{ changed: boolean; noteId?: number }> {
    await this.queries.requireVisible(actor, id);

    return this.uow.transaction(async (tx) => {
      const row = await this.uow.lockIssue(tx, id);
      if (!row) throw new NotFoundError('issue', id);

      const wf = await this.workflow.get();
      const project = await this.tree.get(row.projectId);

      // Same-status calls skip validation, matching changeStatus's `status !== issue.status &&`.
      if (input.status !== row.status) {
        if (!can(actor, 'changeStatus', project, wf)) {
          // Distinguished from the 409 below on purpose: allowedTransitions() returns [] both
          // for "you lack the threshold" and for "the workflow has no such edge", and the
          // frontend shows one toast for both. A client should be able to tell them apart.
          throw new PermissionDeniedError('changeStatus', row.projectId);
        }
        const allowed = allowedTransitions(row, wf, {
          can: (action) => can(actor, action, project, wf),
          meId: actor.id,
        });
        if (!allowed.includes(input.status)) {
          throw new TransitionNotAllowedError(row.status, input.status);
        }
      }

      const patch: Partial<Issue> = { status: input.status };
      if (input.resolution) patch.resolution = input.resolution;
      if (input.fixedInVersion !== undefined) patch.fixedInVersion = input.fixedInVersion;
      if (input.handlerId !== undefined) {
        if (!can(actor, 'assign', project, wf)) throw new PermissionDeniedError('assign', row.projectId);
        patch.handlerId = input.handlerId;
      }

      const result = await this.applyAndPersist(tx, actor, row, patch);

      let noteId: number | undefined;
      if (input.note && plainText(input.note).trim()) {
        if (!can(actor, 'addNote', project, wf)) throw new PermissionDeniedError('addNote', row.projectId);
        noteId = await this.insertNote(tx, actor, row, {
          body: input.note,
          private: input.notePrivate ?? false,
          timeSpent: input.timeSpent ?? 0,
        });
      }

      return noteId === undefined ? result : { ...result, noteId };
    });
  }

  /**
   * Inserts a note inside an existing transaction.
   *
   * Also does what pushNote does beyond the insert: subscribes the author, bumps the issue's
   * `updated`, logs `note_added`, and notifies mentions first so the general 'note' fan-out
   * does not tell the same person twice.
   */
  private async insertNote(
    tx: Tx,
    actor: AuthUser,
    row: IssueRow,
    note: { body: RichText; private: boolean; timeSpent: number },
  ): Promise<number> {
    const now = new Date();
    const noteId = insertedId(await tx.insert(s.comments).values({
      issueId: row.id,
      authorId: actor.id,
      body: note.body,
      bodyNorm: commentSearchNorm(note.body),
      private: note.private,
      timeSpent: note.timeSpent,
      created: now,
    }));

    await tx
      .insert(s.issueMonitors)
      .values({ issueId: row.id, userId: actor.id })
      .onDuplicateKeyUpdate({ set: { issueId: row.id } });

    await tx
      .update(s.issues)
      .set({ noteCount: sql`${s.issues.noteCount} + 1`, updated: now })
      .where(eq(s.issues.id, row.id));

    await this.history.writeMany(
      tx,
      actor.id,
      [{ issueId: row.id, type: 'note_added', field: 'note', new: String(noteId) }],
      now,
    );

    const excerpt = plainText(note.body).slice(0, 140);
    const mentioned = mentionedUserIds(note.body);
    const monitors = await tx
      .select({ userId: s.issueMonitors.userId })
      .from(s.issueMonitors)
      .where(eq(s.issueMonitors.issueId, row.id));

    const watcherIds = [
      ...monitors.map((m) => m.userId),
      row.reporterId,
      ...(row.handlerId ? [row.handlerId] : []),
    ];

    await this.fanout.emit(tx, actor.id, [
      ...(mentioned.length
        ? [{
            type: 'mentioned' as const, issueId: row.id, projectId: row.projectId,
            recipients: mentioned, subject: row.summary, excerpt,
            excerptPrivate: note.private, commentId: noteId,
          }]
        : []),
      {
        type: 'note' as const, issueId: row.id, projectId: row.projectId,
        // Minus the mentioned: they already heard about it.
        recipients: watcherIds.filter((u) => !mentioned.includes(u)),
        subject: row.summary, excerpt, excerptPrivate: note.private, commentId: noteId,
      },
    ]);

    await this.uow.outbox(tx, 'note.added', { issueId: row.id, noteId, actorId: actor.id });
    return noteId;
  }

  /** The shared tail of update / changeStatus / bulk: run the domain, then persist its output. */
  private async applyAndPersist(
    tx: Tx,
    actor: AuthUser,
    row: IssueRow,
    patch: Partial<Issue>,
    extraHistory: Parameters<HistoryWriter['writeMany']>[2] = [],
  ): Promise<{ changed: boolean }> {
    const wf = await this.workflow.get();
    const aggregate = await this.hydrate(tx, row);
    const result = applyPatch(aggregate, patch, wf, { actorId: actor.id, now: new Date() });

    if (!result.changed) {
      if (extraHistory.length) await this.history.writeMany(tx, actor.id, extraHistory);
      return { changed: false };
    }

    const next = result.next;
    await this.uow.updateIssueGuarded(tx, row.id, row.rowVersion, {
      projectId: next.projectId,
      sprintId: next.sprintId,
      category: next.category,
      summary: next.summary,
      description: next.description,
      stepsToReproduce: next.stepsToReproduce,
      additionalInfo: next.additionalInfo,
      status: next.status,
      resolution: next.resolution,
      priority: next.priority,
      severity: next.severity,
      reproducibility: next.reproducibility,
      statusRank: next.statusRank,
      resolutionRank: next.resolutionRank,
      priorityRank: next.priorityRank,
      severityRank: next.severityRank,
      reproducibilityRank: next.reproducibilityRank,
      platform: next.platform,
      os: next.os,
      osBuild: next.osBuild,
      productVersion: next.productVersion,
      targetVersion: next.targetVersion,
      fixedInVersion: next.fixedInVersion,
      reporterId: next.reporterId,
      handlerId: next.handlerId,
      viewState: next.viewState,
      sticky: next.sticky,
      dueDate: next.dueDate,
      estimate: next.estimate,
      storyPoints: next.storyPoints,
      updated: new Date(next.updated),
      resolvedAt: next.resolvedAt,
      firstResolvedAt: next.firstResolvedAt,
      reopenedAt: next.reopenedAt,
      reopenCount: next.reopenCount,
      ...(result.searchDirty
        ? {
            searchNorm: issueSearchNorm({
              summary: next.summary,
              description: next.description,
              stepsToReproduce: next.stepsToReproduce,
              additionalInfo: next.additionalInfo,
              tags: next.tags,
            }),
          }
        : {}),
    });

    if (result.monitorsToAdd.length) {
      await tx
        .insert(s.issueMonitors)
        .values(result.monitorsToAdd.map((userId) => ({ issueId: row.id, userId })))
        .onDuplicateKeyUpdate({ set: { issueId: row.id } });
    }

    await this.history.writeMany(tx, actor.id, [
      ...result.history.map((h) => ({ issueId: row.id, type: h.type, field: h.field, old: h.old, new: h.new })),
      ...extraHistory,
    ]);

    await this.fanout.emit(
      tx,
      actor.id,
      result.notifications.map((n) => ({
        type: n.type,
        issueId: row.id,
        projectId: next.projectId,
        recipients: n.recipients,
        subject: n.subject,
        ...(n.fromStatus ? { fromStatus: n.fromStatus } : {}),
        ...(n.toStatus ? { toStatus: n.toStatus } : {}),
      })),
    );

    await this.uow.outbox(tx, 'issue.updated', {
      issueId: row.id,
      actorId: actor.id,
      fields: result.history.map((h) => h.field),
    });

    return { changed: true };
  }

  /** Builds the IssueAggregate the pure domain expects from a database row. */
  private async hydrate(tx: Tx, row: IssueRow): Promise<IssueAggregate> {
    const [tags, monitors] = await Promise.all([
      tx.select({ tag: s.issueTags.tag }).from(s.issueTags)
        .where(eq(s.issueTags.issueId, row.id)).orderBy(asc(s.issueTags.sortOrder)),
      tx.select({ userId: s.issueMonitors.userId }).from(s.issueMonitors)
        .where(eq(s.issueMonitors.issueId, row.id)),
    ]);

    return {
      ...row,
      created: row.created.toISOString(),
      updated: row.updated.toISOString(),
      tags: tags.map((t) => t.tag),
      monitorIds: monitors.map((m) => m.userId),
      // Not needed by applyPatch (relationships and customFields are untracked), and loading
      // them would be two more queries per write.
      relationships: [],
      customFields: {},
    } as IssueAggregate;
  }

  /**
   * A generic PATCH must not be a way around the dedicated endpoints' thresholds.
   *
   * The frontend's bulkUpdate takes an arbitrary Partial<Issue>; only its own callers keep it
   * honest. Over HTTP, `{ projectId: 2 }` would be a move without `move`, and
   * `{ handlerId: 9 }` an assignment without `assign`.
   */
  private async assertPatchAllowed(
    actor: AuthUser,
    row: IssueRow,
    patch: Partial<Issue>,
  ): Promise<void> {
    const wf = await this.workflow.get();
    const project = await this.tree.get(row.projectId);
    for (const field of Object.keys(patch)) {
      const action = PATCHABLE[field];
      if (!action) {
        throw new ValidationError('errors.validation', `Field '${field}' is not patchable`);
      }
      // `update` is already covered by canEditIssue, which also lets the reporter through.
      if (action !== 'update' && !can(actor, action, project, wf)) {
        throw new PermissionDeniedError(action, row.projectId);
      }
    }
  }

  /**
   * Repairs the name-based fields when an issue moves to another project.
   *
   * Categories and versions are matched by NAME, not by id, so a move leaves whatever the
   * source project happened to call things — names the destination may not have. The category
   * falls back to the destination's first one; a version that does not exist there is cleared.
   *
   * All THREE version columns are remapped, not just `targetVersion`. The frontend's move()
   * only handles targetVersion, which leaves `productVersion` and `fixedInVersion` pointing at
   * versions of a project the issue no longer belongs to — one of the three bugs the plan
   * decided to fix rather than reproduce (§12.2). Projects.save() already remaps all three,
   * so this also makes the two paths consistent with each other.
   *
   * The sprint is always cleared: sprints belong to a project.
   */
  private async remapForProject(
    targetProjectId: number,
    row: IssueRow,
    patch: Partial<Issue>,
  ): Promise<Partial<Issue>> {
    const wanted = patch.category ?? row.category;
    const category = await this.resolveCategory(targetProjectId, wanted);

    const versions = await this.db
      .select({ name: s.projectVersions.name })
      .from(s.projectVersions)
      .where(eq(s.projectVersions.projectId, targetProjectId));
    const available = new Set(versions.map((v) => v.name));
    const keep = (value: string) => (value && available.has(value) ? value : '');

    return {
      category: category.name,
      sprintId: null,
      productVersion: keep(patch.productVersion ?? row.productVersion),
      targetVersion: keep(patch.targetVersion ?? row.targetVersion),
      fixedInVersion: keep(patch.fixedInVersion ?? row.fixedInVersion),
    };
  }

  private async resolveCategory(projectId: number, name: string) {
    const [row] = await this.db
      .select()
      .from(s.projectCategories)
      .where(and(eq(s.projectCategories.projectId, projectId), eq(s.projectCategories.name, name)))
      .limit(1);
    if (row) return row;

    // Fall back to the project's first category rather than accepting a name that does not
    // exist — the same repair move() makes, and better than storing an orphan string.
    const [first] = await this.db
      .select()
      .from(s.projectCategories)
      .where(eq(s.projectCategories.projectId, projectId))
      .orderBy(asc(s.projectCategories.sortOrder))
      .limit(1);
    if (!first) throw new ValidationError('errors.validation', `Project ${projectId} has no categories`);
    return first;
  }
}

/** trim + lowercase + hyphenate, exactly as addTag does. */
export const normalizeTag = (tag: string): string =>
  tag.trim().toLowerCase().replace(/\s+/g, '-');
