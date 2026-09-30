import { Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { REVERSE_RELATIONSHIP } from '../../shared/config';
import type { RelationshipType } from '../../shared/models';
import {
  ConflictError, NotFoundError, PermissionDeniedError, ValidationError,
} from '../../common/errors/domain-error';
import * as s from '../../core/database/schema';
import { UnitOfWork, type Tx } from '../../core/database/unit-of-work';
import { ProjectTreeService } from '../../core/project-tree/project-tree.service';
import { WorkflowService } from '../../core/workflow/workflow.service';
import { can, canMonitorFor } from '../auth/ability';
import type { AuthUser } from '../auth/auth.types';
import { HistoryWriter } from '../history/history.writer';
import { normalizeTag } from './issues.write.service';
import { issueSearchNorm, tagsSorted } from './domain/search-text';
import { IssuesQueryService } from './issues.query.service';

/**
 * Relationships, monitors and tags.
 *
 * Grouped because they share a shape — each is a join table whose edits produce their own
 * history type rather than a `field` row — and because all three are places where the frontend
 * performs no permission check at all. `removeRelationship`, `addTag` and `removeTag` are
 * simply callable there; the UI only hides the controls. Every one of them is gated here.
 */
@Injectable()
export class IssueLinksService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly issues: IssuesQueryService,
    private readonly tree: ProjectTreeService,
    private readonly workflow: WorkflowService,
    private readonly history: HistoryWriter,
  ) {}

  // ───────────────────────── relationships ─────────────────────────

  /**
   * Creates a link and its mirror image in one transaction.
   *
   * Both rows are written because the frontend stores relationships on both issues, which makes
   * "show me this issue's links" a one-sided indexed read. The composite primary key
   * (issueId, otherIssueId) then enforces the "at most one link per pair" rule for free — a
   * second link of any type fails with ER_DUP_ENTRY, mapped to 409 errors.relationExists.
   */
  async addRelationship(
    actor: AuthUser,
    issueId: number,
    type: RelationshipType,
    targetId: number,
  ): Promise<void> {
    const issue = await this.issues.requireVisible(actor, issueId);
    await this.assertCan(actor, issue.projectId, 'manageRelationships');

    if (issueId === targetId) {
      throw new ValidationError('errors.selfRelation', 'An issue cannot relate to itself');
    }
    // Must be visible, not merely existent: otherwise linking is a way to discover private ids.
    await this.issues.requireVisible(actor, targetId);

    await this.uow.transaction(async (tx) => {
      const existing = await tx
        .select({ type: s.issueRelationships.type })
        .from(s.issueRelationships)
        .where(and(
          eq(s.issueRelationships.issueId, issueId),
          eq(s.issueRelationships.otherIssueId, targetId),
        ))
        .limit(1);
      if (existing.length) throw new ConflictError('errors.relationExists', { id: targetId });

      const now = new Date();
      const reverse = REVERSE_RELATIONSHIP[type];
      await tx.insert(s.issueRelationships).values([
        { issueId, otherIssueId: targetId, type, created: now },
        { issueId: targetId, otherIssueId: issueId, type: reverse, created: now },
      ]);

      // Both issues change, so both get touched and both get a history row.
      await tx.update(s.issues).set({ updated: now })
        .where(sql`${s.issues.id} IN (${issueId}, ${targetId})`);

      await this.history.writeMany(tx, actor.id, [
        { issueId, type: 'relationship_added', field: type, new: String(targetId) },
        { issueId: targetId, type: 'relationship_added', field: reverse, new: String(issueId) },
      ], now);

      await this.uow.outbox(tx, 'issue.relationshipAdded', { issueId, targetId, type, actorId: actor.id });
    });
  }

  /** Removes both directions. Needs `manageRelationships`, which the frontend never checks. */
  async removeRelationship(actor: AuthUser, issueId: number, targetId: number): Promise<void> {
    const issue = await this.issues.requireVisible(actor, issueId);
    await this.assertCan(actor, issue.projectId, 'manageRelationships');

    await this.uow.transaction(async (tx) => {
      const [link] = await tx
        .select({ type: s.issueRelationships.type })
        .from(s.issueRelationships)
        .where(and(
          eq(s.issueRelationships.issueId, issueId),
          eq(s.issueRelationships.otherIssueId, targetId),
        ))
        .limit(1);
      if (!link) throw new NotFoundError('relationship', targetId);

      await tx.delete(s.issueRelationships).where(sql`
        (${s.issueRelationships.issueId} = ${issueId} AND ${s.issueRelationships.otherIssueId} = ${targetId})
        OR (${s.issueRelationships.issueId} = ${targetId} AND ${s.issueRelationships.otherIssueId} = ${issueId})
      `);

      // removeRelationship() does not bump `updated` in the frontend, but it does log both
      // sides; the history rows are the part that matters for an audit trail.
      await this.history.writeMany(tx, actor.id, [
        { issueId, type: 'relationship_deleted', field: link.type, old: String(targetId) },
        {
          issueId: targetId,
          type: 'relationship_deleted',
          field: REVERSE_RELATIONSHIP[link.type],
          old: String(issueId),
        },
      ]);

      await this.uow.outbox(tx, 'issue.relationshipRemoved', { issueId, targetId, actorId: actor.id });
    });
  }

  // ───────────────────────── monitors ─────────────────────────

  /**
   * Subscribes or unsubscribes a user.
   *
   * Doing it on somebody else's behalf needs `monitorOthers`, evaluated WITHOUT a project —
   * matching setMonitor's global `can("monitorOthers")`, so a project membership cannot grant it.
   */
  async setMonitor(actor: AuthUser, issueId: number, userId: number, on: boolean): Promise<void> {
    await this.issues.requireVisible(actor, issueId);
    const wf = await this.workflow.get();
    if (!canMonitorFor(actor, userId, wf)) throw new PermissionDeniedError('monitorOthers');

    await this.uow.transaction(async (tx) => {
      const existing = await tx
        .select({ userId: s.issueMonitors.userId })
        .from(s.issueMonitors)
        .where(and(eq(s.issueMonitors.issueId, issueId), eq(s.issueMonitors.userId, userId)))
        .limit(1);
      // Idempotent, as setMonitor is: no history row when nothing changes.
      if (existing.length === (on ? 1 : 0)) return;

      if (on) {
        await tx.insert(s.issueMonitors).values({ issueId, userId });
      } else {
        await tx
          .delete(s.issueMonitors)
          .where(and(eq(s.issueMonitors.issueId, issueId), eq(s.issueMonitors.userId, userId)));
      }

      await this.history.write(tx, actor.id, {
        issueId,
        type: on ? 'monitor_added' : 'monitor_removed',
        field: 'monitor',
        ...(on ? { new: String(userId) } : { old: String(userId) }),
      });

      // `updated` is deliberately left alone: setMonitor does not touch it, so subscribing does
      // not move an issue up the "recently modified" list. Parity, documented in the README.
      await this.uow.outbox(tx, 'issue.monitorChanged', { issueId, userId, on, actorId: actor.id });
    });
  }

  // ───────────────────────── tags ─────────────────────────

  /** Adds a tag, normalized. Needs `manageTags`, which the frontend does not check. */
  async addTag(actor: AuthUser, issueId: number, rawTag: string): Promise<{ tag: string } | null> {
    const issue = await this.issues.requireVisible(actor, issueId);
    await this.assertCan(actor, issue.projectId, 'manageTags');

    const tag = normalizeTag(rawTag);
    if (!tag) return null;

    return this.uow.transaction(async (tx) => {
      const existing = await tx
        .select({ tag: s.issueTags.tag })
        .from(s.issueTags)
        .where(and(eq(s.issueTags.issueId, issueId), eq(s.issueTags.tag, tag)))
        .limit(1);
      if (existing.length) return null;

      // Appended at the end: insertion order is what `ORDER BY tags` compares against.
      const [maxOrder] = await tx
        .select({ next: sql<number>`COALESCE(MAX(${s.issueTags.sortOrder}), -1) + 1` })
        .from(s.issueTags)
        .where(eq(s.issueTags.issueId, issueId));

      await tx.insert(s.issueTags).values({ issueId, tag, sortOrder: Number(maxOrder?.next ?? 0) });
      await this.refreshTagDerived(tx, issueId);
      await this.history.write(tx, actor.id, {
        issueId, type: 'tag_added', field: 'tag', new: tag,
      });
      await this.uow.outbox(tx, 'issue.tagAdded', { issueId, tag, actorId: actor.id });
      return { tag };
    });
  }

  async removeTag(actor: AuthUser, issueId: number, rawTag: string): Promise<void> {
    const issue = await this.issues.requireVisible(actor, issueId);
    await this.assertCan(actor, issue.projectId, 'manageTags');

    const tag = normalizeTag(rawTag);
    await this.uow.transaction(async (tx) => {
      const existing = await tx
        .select({ tag: s.issueTags.tag })
        .from(s.issueTags)
        .where(and(eq(s.issueTags.issueId, issueId), eq(s.issueTags.tag, tag)))
        .limit(1);
      if (!existing.length) return;

      await tx
        .delete(s.issueTags)
        .where(and(eq(s.issueTags.issueId, issueId), eq(s.issueTags.tag, tag)));
      await this.refreshTagDerived(tx, issueId);
      await this.history.write(tx, actor.id, {
        issueId, type: 'tag_removed', field: 'tag', old: tag,
      });
      await this.uow.outbox(tx, 'issue.tagRemoved', { issueId, tag, actorId: actor.id });
    });
  }

  /**
   * Rebuilds the two denormalized columns a tag change invalidates.
   *
   * `tagsSorted` backs `ORDER BY tags` and `searchNorm` includes the tags in the search
   * haystack, so both have to move with the tag set or the list view and the search silently
   * disagree with the data. `updated` IS bumped here, because addTag/removeTag do.
   */
  private async refreshTagDerived(tx: Tx, issueId: number): Promise<void> {
    const [issue] = await tx
      .select({
        summary: s.issues.summary,
        description: s.issues.description,
        stepsToReproduce: s.issues.stepsToReproduce,
        additionalInfo: s.issues.additionalInfo,
      })
      .from(s.issues)
      .where(eq(s.issues.id, issueId))
      .limit(1);
    if (!issue) return;

    const tags = (
      await tx
        .select({ tag: s.issueTags.tag })
        .from(s.issueTags)
        .where(eq(s.issueTags.issueId, issueId))
        .orderBy(asc(s.issueTags.sortOrder))
    ).map((t) => t.tag);

    await tx
      .update(s.issues)
      .set({
        tagsSorted: tagsSorted(tags),
        searchNorm: issueSearchNorm({ ...issue, tags }),
        updated: new Date(),
      })
      .where(eq(s.issues.id, issueId));
  }

  private async assertCan(
    actor: AuthUser,
    projectId: number,
    action: 'manageRelationships' | 'manageTags',
  ): Promise<void> {
    const [wf, project] = await Promise.all([
      this.workflow.get(),
      this.tree.get(projectId),
    ]);
    if (!can(actor, action, project, wf)) throw new PermissionDeniedError(action, projectId);
  }
}
