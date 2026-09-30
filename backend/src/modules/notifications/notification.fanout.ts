import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AccessLevel, NotifyEvent, Status } from '../../shared/models';
import * as s from '../../core/database/schema';
import type { Tx } from '../../core/database/unit-of-work';
import { ProjectTreeService } from '../../core/project-tree/project-tree.service';
import { WorkflowService } from '../../core/workflow/workflow.service';
import { canSeeIssue } from '../auth/ability';

export interface NotificationDraft {
  type: NotifyEvent;
  issueId: number;
  projectId: number;
  /** Candidates. Narrowed below by preferences, account state and visibility. */
  recipients: number[];
  subject: string;
  excerpt?: string;
  /** True when the excerpt came from a private note. */
  excerptPrivate?: boolean;
  fromStatus?: Status;
  toStatus?: Status;
  commentId?: number;
}

/** Maps a NotifyEvent to the userPrefs column that mutes it. */
const PREF_COLUMN: Record<NotifyEvent, string> = {
  assigned: 'notifyAssigned',
  mentioned: 'notifyMentioned',
  status: 'notifyStatus',
  note: 'notifyNote',
  attachment: 'notifyAttachment',
};

/**
 * Creates notifications, inside the caller's transaction.
 *
 * Recipients survive four filters, resolved in ONE query rather than a lookup per candidate:
 *
 *   1. never the actor — you are not told about your own action;
 *   2. the account is enabled and not deleted;
 *   3. the user has not muted this event type;
 *   4. the user can actually SEE the issue.
 *
 * The fourth is a correction, not a port: the frontend never checks it, so today a user can be
 * notified about an issue in a project they cannot open. It arrives here through the same
 * decision that moved every other permission check to the server.
 */
@Injectable()
export class NotificationFanout {
  constructor(
    private readonly tree: ProjectTreeService,
    private readonly workflow: WorkflowService,
  ) {}

  async emit(tx: Tx, actorId: number, drafts: NotificationDraft[]): Promise<number> {
    let created = 0;
    for (const draft of drafts) {
      const recipients = [...new Set(draft.recipients)].filter((id) => id !== actorId);
      if (!recipients.length) continue;

      const allowed = await this.allowedRecipients(tx, draft, recipients);
      if (!allowed.length) continue;

      const now = new Date();
      await tx.insert(s.notifications).values(
        allowed.map((userId) => ({
          userId,
          issueId: draft.issueId,
          actorId,
          type: draft.type,
          read: false,
          date: now,
          fromStatus: draft.fromStatus ?? null,
          toStatus: draft.toStatus ?? null,
          commentId: draft.commentId ?? null,
          attachmentId: null,
          subject: draft.subject.slice(0, 255),
          excerpt: draft.excerpt?.slice(0, 160) ?? null,
          excerptPrivate: draft.excerptPrivate ?? false,
          // Denormalized English fallback. The structured columns above are what a client
          // should render, so the reader's language wins instead of the actor's being frozen in.
          text: this.fallbackText(draft).slice(0, 255),
        })),
      );
      created += allowed.length;
    }
    return created;
  }

  /**
   * Filters 1-3 in SQL (cheap, set-based), filter 4 in TypeScript.
   *
   * Visibility deliberately does NOT get reimplemented as a WHERE clause. levelIn() gives a
   * non-member their global level and a member the membership level, on top of a project
   * visibility check of its own — expressing all of that in SQL means a second copy of the
   * rule that can drift from ability.ts. The candidate set here is the watcher list (monitors
   * plus reporter and handler), so it is a handful of rows and the loop costs nothing.
   */
  private async allowedRecipients(
    tx: Tx,
    draft: NotificationDraft,
    recipients: number[],
  ): Promise<number[]> {
    const prefColumn = PREF_COLUMN[draft.type];

    const candidates = await tx
      .select({
        id: s.users.id,
        accessLevel: s.users.accessLevel,
        muted: sql<number>`NOT ${sql.identifier(prefColumn)}`,
      })
      .from(s.users)
      .innerJoin(s.userPrefs, eq(s.userPrefs.userId, s.users.id))
      .where(and(
        inArray(s.users.id, recipients),
        eq(s.users.enabled, true),
        isNull(s.users.deletedAt),
      ));

    const [issue] = await tx
      .select({
        projectId: s.issues.projectId,
        viewState: s.issues.viewState,
        reporterId: s.issues.reporterId,
        handlerId: s.issues.handlerId,
      })
      .from(s.issues)
      .where(eq(s.issues.id, draft.issueId))
      .limit(1);
    if (!issue) return [];

    const [wf, project] = await Promise.all([
      this.workflow.get(),
      this.tree.get(issue.projectId),
    ]);

    return candidates
      .filter((c) => !Number(c.muted))
      .filter((c) =>
        canSeeIssue({ id: c.id, accessLevel: c.accessLevel as AccessLevel }, issue, project, wf),
      )
      .map((c) => c.id);
  }

  private fallbackText(draft: NotificationDraft): string {
    switch (draft.type) {
      case 'status':
        return `${draft.fromStatus ?? '?'} → ${draft.toStatus ?? '?'}: ${draft.subject}`;
      case 'note':
      case 'mentioned':
        return draft.excerpt ?? draft.subject;
      default:
        return draft.subject;
    }
  }
}
