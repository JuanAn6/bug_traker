import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import type { NotifyEvent, Status } from '../../shared/models';
import { DRIZZLE, type Db } from '../../core/database/drizzle.service';
import * as s from '../../core/database/schema';
import { ProjectTreeService } from '../../core/project-tree/project-tree.service';
import { WorkflowService } from '../../core/workflow/workflow.service';
import { canSeeNote } from '../auth/ability';
import type { AuthUser } from '../auth/auth.types';

const actor = alias(s.users, 'actorUser');

export interface NotificationView {
  id: number;
  issueId: number;
  issueKey: string;
  actorId: number;
  actorName: string;
  actorColor: string;
  type: NotifyEvent;
  read: boolean;
  date: string;
  subject: string;
  /** Suppressed when it was taken from a private note this reader cannot see. */
  excerpt: string | null;
  fromStatus: Status | null;
  toStatus: Status | null;
  /** English fallback for rows imported from a Db export, which carry no structured payload. */
  text: string;
}

@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly tree: ProjectTreeService,
    private readonly workflow: WorkflowService,
  ) {}

  /**
   * The caller's own notifications, newest first.
   *
   * The excerpt gets a second look here rather than at write time. A mention inside a private
   * note is still delivered — faithful to the frontend, which sends the 140-character excerpt
   * regardless — but `excerptPrivate` marks where it came from, so the text is withheld from a
   * reader who could not open the note itself. That is the one-line change the schema was
   * shaped for; the notification still arrives, only without quoting what it cannot show.
   */
  async list(
    user: AuthUser,
    options: { unreadOnly?: boolean; type?: NotifyEvent; limit?: number } = {},
  ): Promise<NotificationView[]> {
    const conditions = [eq(s.notifications.userId, user.id)];
    if (options.unreadOnly) conditions.push(eq(s.notifications.read, false));
    if (options.type) conditions.push(eq(s.notifications.type, options.type));

    const rows = await this.db
      .select({
        id: s.notifications.id,
        issueId: s.notifications.issueId,
        projectKey: s.projects.key,
        projectId: s.projects.id,
        actorId: s.notifications.actorId,
        actorName: actor.realName,
        actorColor: actor.avatarColor,
        type: s.notifications.type,
        read: s.notifications.read,
        date: s.notifications.date,
        subject: s.notifications.subject,
        excerpt: s.notifications.excerpt,
        excerptPrivate: s.notifications.excerptPrivate,
        fromStatus: s.notifications.fromStatus,
        toStatus: s.notifications.toStatus,
        text: s.notifications.text,
        commentId: s.notifications.commentId,
      })
      .from(s.notifications)
      .innerJoin(s.issues, eq(s.issues.id, s.notifications.issueId))
      .innerJoin(s.projects, eq(s.projects.id, s.issues.projectId))
      .innerJoin(actor, eq(actor.id, s.notifications.actorId))
      // A notification about an issue that has since been deleted is noise, not history.
      .where(and(...conditions, isNull(s.issues.deletedAt)))
      .orderBy(desc(s.notifications.date))
      .limit(options.limit ?? 100);

    const wf = await this.workflow.get();
    return Promise.all(
      rows.map(async (r) => {
        let excerpt = r.excerpt;
        if (excerpt && r.excerptPrivate) {
          const project = await this.tree.get(r.projectId);
          const visible = canSeeNote(user, { authorId: r.actorId, private: true }, project, wf);
          if (!visible) excerpt = null;
        }
        return {
          id: r.id,
          issueId: r.issueId,
          issueKey: `${r.projectKey}-${r.issueId}`,
          actorId: r.actorId,
          actorName: r.actorName,
          actorColor: r.actorColor,
          type: r.type,
          read: r.read,
          date: r.date.toISOString(),
          subject: r.subject,
          excerpt,
          fromStatus: r.fromStatus,
          toStatus: r.toStatus,
          text: r.text,
        };
      }),
    );
  }

  async unreadCount(user: AuthUser): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(s.notifications)
      .innerJoin(s.issues, eq(s.issues.id, s.notifications.issueId))
      .where(and(
        eq(s.notifications.userId, user.id),
        eq(s.notifications.read, false),
        isNull(s.issues.deletedAt),
      ));
    return Number(row?.n ?? 0);
  }

  /**
   * Marks notifications read or unread.
   *
   * Scoped to the caller's own rows. The frontend's markRead takes a list of ids and trusts
   * them, so over HTTP it would let anyone flip somebody else's bell — the filter on `userId`
   * is what closes that.
   */
  async markRead(user: AuthUser, ids: number[], read = true): Promise<{ updated: number }> {
    if (!ids.length) return { updated: 0 };
    const result = await this.db
      .update(s.notifications)
      .set({ read })
      .where(and(inArray(s.notifications.id, ids), eq(s.notifications.userId, user.id)));
    return { updated: affected(result) };
  }

  async markAllRead(user: AuthUser): Promise<{ updated: number }> {
    const result = await this.db
      .update(s.notifications)
      .set({ read: true })
      .where(and(eq(s.notifications.userId, user.id), eq(s.notifications.read, false)));
    return { updated: affected(result) };
  }

  async remove(user: AuthUser, ids: number[]): Promise<{ deleted: number }> {
    if (!ids.length) return { deleted: 0 };
    const result = await this.db
      .delete(s.notifications)
      .where(and(inArray(s.notifications.id, ids), eq(s.notifications.userId, user.id)));
    return { deleted: affected(result) };
  }

  /** "Delete read" in the notifications page. */
  async removeRead(user: AuthUser): Promise<{ deleted: number }> {
    const result = await this.db
      .delete(s.notifications)
      .where(and(eq(s.notifications.userId, user.id), eq(s.notifications.read, true)));
    return { deleted: affected(result) };
  }
}

const affected = (result: unknown): number => {
  const header = Array.isArray(result) ? (result[0] as { affectedRows?: number }) : undefined;
  return Number(header?.affectedRows ?? 0);
};
