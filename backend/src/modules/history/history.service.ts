import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { HistoryType } from '../../shared/models';
import { plainText } from '../../shared/rich';
import { DRIZZLE, type Db } from '../../core/database/drizzle.service';
import * as s from '../../core/database/schema';
import { VisibilityService } from '../auth/visibility.service';
import type { AuthUser } from '../auth/auth.types';
import { IssuesQueryService } from '../issues/issues.query.service';
import { CommentsService } from '../comments/comments.service';

export interface HistoryRowView {
  id: number;
  issueId: number;
  userId: number;
  userName: string;
  date: string;
  type: HistoryType;
  field: string;
  old: string;
  new: string;
}

export interface TimelineEntry {
  kind: 'history' | 'note';
  date: string;
  userId: number;
  userName: string;
  /** Present for kind 'history'. */
  type?: HistoryType;
  field?: string;
  old?: string;
  new?: string;
  /** Present for kind 'note'. */
  noteId?: number;
  excerpt?: string;
  private?: boolean;
}

@Injectable()
export class HistoryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly issues: IssuesQueryService,
    private readonly comments: CommentsService,
    private readonly visibility: VisibilityService,
  ) {}

  async forIssue(actor: AuthUser, issueId: number): Promise<HistoryRowView[]> {
    // Visibility is checked on the ISSUE: history rows carry no privacy of their own.
    await this.issues.requireVisible(actor, issueId);
    const rows = await this.db
      .select({
        id: s.historyEntries.id,
        issueId: s.historyEntries.issueId,
        userId: s.historyEntries.userId,
        userName: s.users.realName,
        date: s.historyEntries.date,
        type: s.historyEntries.type,
        field: s.historyEntries.field,
        old: s.historyEntries.oldValue,
        new: s.historyEntries.newValue,
      })
      .from(s.historyEntries)
      .innerJoin(s.users, eq(s.users.id, s.historyEntries.userId))
      .where(eq(s.historyEntries.issueId, issueId))
      .orderBy(desc(s.historyEntries.date), desc(s.historyEntries.id));

    return rows.map((r) => ({ ...r, date: r.date.toISOString() }));
  }

  /**
   * History and notes interleaved, newest first.
   *
   * `note_added` rows are dropped because the note itself is in the list — keeping both would
   * show every comment twice, once as an event and once as content. The frontend's combined
   * timeline does the same.
   */
  async timeline(actor: AuthUser, issueId: number): Promise<TimelineEntry[]> {
    const [history, notes] = await Promise.all([
      this.forIssue(actor, issueId),
      // Goes through CommentsService so private notes are filtered by the same predicate that
      // governs the Notes tab, rather than a second copy of the rule.
      this.comments.list(actor, issueId),
    ]);

    const entries: TimelineEntry[] = [
      ...history
        .filter((h) => h.type !== 'note_added')
        .map((h) => ({
          kind: 'history' as const,
          date: h.date,
          userId: h.userId,
          userName: h.userName,
          type: h.type,
          field: h.field,
          old: h.old,
          new: h.new,
        })),
      ...notes.map((n) => ({
        kind: 'note' as const,
        date: n.created,
        userId: n.authorId,
        userName: n.authorName,
        noteId: n.id,
        excerpt: plainText(n.body).slice(0, 200),
        private: n.private,
      })),
    ];

    return entries.sort((a, b) => b.date.localeCompare(a.date));
  }

  /**
   * The global activity feed behind the home page.
   *
   * Scoped to visible projects, and private issues are excluded unless the reader is entitled to
   * them — a history row's `old`/`new` can carry a private issue's summary.
   */
  async activity(
    actor: AuthUser,
    options: { projectId?: number; limit?: number } = {},
  ): Promise<Array<HistoryRowView & { issueKey: string; summary: string }>> {
    const scope = await this.visibility.scope(actor);
    if (!scope.visibleProjectIds.length) return [];

    const projectIds = options.projectId
      ? scope.visibleProjectIds.filter((id) => id === options.projectId)
      : scope.visibleProjectIds;
    if (!projectIds.length) return [];

    const rows = await this.db
      .select({
        id: s.historyEntries.id,
        issueId: s.historyEntries.issueId,
        userId: s.historyEntries.userId,
        userName: s.users.realName,
        date: s.historyEntries.date,
        type: s.historyEntries.type,
        field: s.historyEntries.field,
        old: s.historyEntries.oldValue,
        new: s.historyEntries.newValue,
        projectKey: s.projects.key,
        summary: s.issues.summary,
      })
      .from(s.historyEntries)
      .innerJoin(s.issues, eq(s.issues.id, s.historyEntries.issueId))
      .innerJoin(s.projects, eq(s.projects.id, s.issues.projectId))
      .innerJoin(s.users, eq(s.users.id, s.historyEntries.userId))
      .where(and(
        inArray(s.issues.projectId, projectIds),
        isNull(s.issues.deletedAt),
        scope.isAdmin
          ? undefined
          : sql`(${s.issues.viewState} = 'public'
                 OR ${s.issues.reporterId} = ${actor.id}
                 OR ${s.issues.handlerId} = ${actor.id}
                 OR ${s.issues.projectId} IN (${sql.join(
                   (scope.privateIssueProjectIds.length ? scope.privateIssueProjectIds : [-1]).map(
                     (id) => sql`${id}`,
                   ),
                   sql`, `,
                 )}))`,
      ))
      .orderBy(desc(s.historyEntries.date), desc(s.historyEntries.id))
      .limit(Math.min(options.limit ?? 30, 200));

    return rows.map((r) => ({
      ...r,
      date: r.date.toISOString(),
      issueKey: `${r.projectKey}-${r.issueId}`,
    }));
  }
}
