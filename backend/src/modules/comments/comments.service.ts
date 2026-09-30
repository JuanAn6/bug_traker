import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { RichText } from '../../shared/models';
import { mentionedUserIds, plainText } from '../../shared/rich';
import { NotFoundError, PermissionDeniedError } from '../../common/errors/domain-error';
import { DRIZZLE, type Db } from '../../core/database/drizzle.service';
import * as s from '../../core/database/schema';
import { insertedId, UnitOfWork, type Tx } from '../../core/database/unit-of-work';
import { ProjectTreeService } from '../../core/project-tree/project-tree.service';
import { WorkflowService } from '../../core/workflow/workflow.service';
import { can, canEditNote, canSeeNote } from '../auth/ability';
import type { AuthUser } from '../auth/auth.types';
import { HistoryWriter } from '../history/history.writer';
import { NotificationFanout } from '../notifications/notification.fanout';
import { AttachmentsService } from '../attachments/attachments.service';
import { commentSearchNorm } from '../issues/domain/search-text';
import { IssuesQueryService } from '../issues/issues.query.service';

export interface NoteView {
  id: number;
  issueId: number;
  authorId: number;
  authorName: string;
  authorColor: string;
  body: RichText;
  private: boolean;
  timeSpent: number;
  created: string;
  edited: string | null;
  /** Whether THIS caller may edit or delete it — the UI renders its buttons from this. */
  canEdit: boolean;
}

/** Excerpt lengths the frontend uses: 120 for history rows, 140 for notification text. */
const HISTORY_EXCERPT = 120;
const NOTIFY_EXCERPT = 140;

@Injectable()
export class CommentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly issues: IssuesQueryService,
    private readonly tree: ProjectTreeService,
    private readonly workflow: WorkflowService,
    private readonly history: HistoryWriter,
    private readonly fanout: NotificationFanout,
    private readonly attachments: AttachmentsService,
  ) {}

  /** Notes on an issue, private ones filtered out, ordered by the caller's own preference. */
  async list(actor: AuthUser, issueId: number): Promise<NoteView[]> {
    const issue = await this.issues.requireVisible(actor, issueId);
    const [wf, project] = await Promise.all([
      this.workflow.get(),
      this.tree.get(issue.projectId),
    ]);

    const rows = await this.db
      .select({
        id: s.comments.id,
        issueId: s.comments.issueId,
        authorId: s.comments.authorId,
        authorName: s.users.realName,
        authorColor: s.users.avatarColor,
        body: s.comments.body,
        private: s.comments.private,
        timeSpent: s.comments.timeSpent,
        created: s.comments.created,
        edited: s.comments.edited,
      })
      .from(s.comments)
      .innerJoin(s.users, eq(s.users.id, s.comments.authorId))
      .where(and(eq(s.comments.issueId, issueId), isNull(s.comments.deletedAt)))
      .orderBy(actor.prefs.notesNewestFirst ? desc(s.comments.created) : asc(s.comments.created));

    return rows
      .filter((r) => canSeeNote(actor, r, project, wf))
      .map((r) => ({
        ...r,
        created: r.created.toISOString(),
        edited: r.edited?.toISOString() ?? null,
        canEdit: canEditNote(actor, r, project, wf),
      }));
  }

  /** Minutes per author plus the total, counting only notes this caller can see. */
  async timeSummary(actor: AuthUser, issueId: number) {
    const notes = await this.list(actor, issueId);
    const byUser = new Map<number, { userId: number; name: string; minutes: number }>();
    for (const note of notes) {
      if (!note.timeSpent) continue;
      const entry = byUser.get(note.authorId);
      if (entry) entry.minutes += note.timeSpent;
      else byUser.set(note.authorId, { userId: note.authorId, name: note.authorName, minutes: note.timeSpent });
    }
    const perUser = [...byUser.values()].sort((a, b) => b.minutes - a.minutes);
    return { perUser, total: perUser.reduce((sum, u) => sum + u.minutes, 0) };
  }

  async create(
    actor: AuthUser,
    issueId: number,
    input: { body: RichText; private?: boolean; timeSpent?: number; attachmentIds?: number[] },
  ): Promise<{ id: number }> {
    const issue = await this.issues.requireVisible(actor, issueId);
    const [wf, project] = await Promise.all([
      this.workflow.get(),
      this.tree.get(issue.projectId),
    ]);
    if (!can(actor, 'addNote', project, wf)) {
      throw new PermissionDeniedError('addNote', issue.projectId);
    }

    const id = await this.uow.transaction(async (tx) => {
      const now = new Date();
      const noteId = insertedId(
        await tx.insert(s.comments).values({
          issueId,
          authorId: actor.id,
          body: input.body,
          bodyNorm: commentSearchNorm(input.body),
          private: input.private ?? false,
          timeSpent: input.timeSpent ?? 0,
          created: now,
        }),
      );

      // Commenting subscribes you. No monitor_added history row — pushNote does not write one
      // either, unlike the explicit monitor endpoints.
      await tx
        .insert(s.issueMonitors)
        .values({ issueId, userId: actor.id })
        .onDuplicateKeyUpdate({ set: { issueId } });

      await tx
        .update(s.issues)
        .set({ noteCount: sql`${s.issues.noteCount} + 1`, updated: now })
        .where(eq(s.issues.id, issueId));

      await this.history.writeMany(
        tx,
        actor.id,
        [{ issueId, type: 'note_added', field: 'note', new: String(noteId) }],
        now,
      );

      // Attached with commentId set, so the documents panel can show which note they came from —
      // and so their visibility follows the note's private flag.
      if (input.attachmentIds?.length) {
        await this.attachments.adopt(tx, actor, input.attachmentIds, { issueId, commentId: noteId });
      }

      await this.notifyForNote(tx, actor, {
        issueId,
        projectId: issue.projectId,
        summary: issue.summary,
        reporterId: issue.reporterId,
        handlerId: issue.handlerId,
        noteId,
        body: input.body,
        private: input.private ?? false,
      });

      await this.uow.outbox(tx, 'note.added', { issueId, noteId, actorId: actor.id });
      return noteId;
    });

    return { id };
  }

  async update(
    actor: AuthUser,
    noteId: number,
    input: { body?: RichText; private?: boolean; timeSpent?: number },
  ): Promise<void> {
    const note = await this.requireEditable(actor, noteId);

    await this.uow.transaction(async (tx) => {
      const now = new Date();
      const nextBody = input.body ?? note.body;
      const nextPrivate = input.private ?? note.private;

      await tx
        .update(s.comments)
        .set({
          body: nextBody,
          bodyNorm: commentSearchNorm(nextBody),
          private: nextPrivate,
          timeSpent: input.timeSpent ?? note.timeSpent,
          edited: now,
        })
        .where(eq(s.comments.id, noteId));

      const rows: Parameters<HistoryWriter['writeMany']>[2] = [
        {
          issueId: note.issueId,
          type: 'note_edited',
          field: 'note',
          old: plainText(note.body).slice(0, HISTORY_EXCERPT),
          new: plainText(nextBody).slice(0, HISTORY_EXCERPT),
        },
      ];
      // A privacy flip is logged as a field change, because it changes who can read the note.
      if (nextPrivate !== note.private) {
        rows.push({
          issueId: note.issueId,
          type: 'field',
          field: 'notePrivate',
          old: String(note.private),
          new: String(nextPrivate),
        });
      }
      await this.history.writeMany(tx, actor.id, rows, now);

      // Only mentions that were not there before. editNote() does the same diff, so editing a
      // typo does not re-ping everyone named in the note.
      const before = new Set(mentionedUserIds(note.body));
      const added = mentionedUserIds(nextBody).filter((id) => !before.has(id));
      if (added.length) {
        await this.fanout.emit(tx, actor.id, [{
          type: 'mentioned',
          issueId: note.issueId,
          projectId: note.projectId,
          recipients: added,
          subject: note.summary,
          excerpt: plainText(nextBody).slice(0, NOTIFY_EXCERPT),
          excerptPrivate: nextPrivate,
          commentId: noteId,
        }]);
      }

      // Deliberately NOT bumping issues.updated: editNote() does not, so an edited note does
      // not move the issue up the "recently modified" list. Documented parity, not an oversight.
      await this.uow.outbox(tx, 'note.edited', { issueId: note.issueId, noteId, actorId: actor.id });
    });
  }

  /**
   * `keepFiles` decides what happens to the note's attachments.
   *
   * true detaches them (`commentId = null`) so they survive as ticket documents; false deletes
   * them. Detaching is a visibility change — a file that was private by inheriting the note's
   * flag becomes a public ticket document — so it is logged explicitly, which the frontend does
   * not do.
   */
  async remove(actor: AuthUser, noteId: number, keepFiles: boolean): Promise<void> {
    const note = await this.requireEditable(actor, noteId);

    await this.uow.transaction(async (tx) => {
      const now = new Date();

      await tx.update(s.comments).set({ deletedAt: now }).where(eq(s.comments.id, noteId));
      await tx
        .update(s.issues)
        .set({ noteCount: sql`GREATEST(${s.issues.noteCount} - 1, 0)` })
        .where(eq(s.issues.id, note.issueId));

      const files = await tx
        .select({ id: s.attachments.id, name: s.attachments.name })
        .from(s.attachments)
        .where(and(eq(s.attachments.commentId, noteId), isNull(s.attachments.deletedAt)));

      const rows: Parameters<HistoryWriter['writeMany']>[2] = [
        {
          issueId: note.issueId,
          type: 'note_deleted',
          field: 'note',
          old: plainText(note.body).slice(0, HISTORY_EXCERPT),
        },
      ];

      if (files.length) {
        if (keepFiles) {
          await tx
            .update(s.attachments)
            .set({ commentId: null })
            .where(eq(s.attachments.commentId, noteId));
          for (const file of files) {
            rows.push({
              issueId: note.issueId,
              type: 'attachment_renamed',
              field: 'visibility',
              old: `${file.name} (note ${noteId})`,
              new: `${file.name} (ticket document)`,
            });
          }
        } else {
          await tx
            .update(s.attachments)
            .set({ deletedAt: now })
            .where(eq(s.attachments.commentId, noteId));
          await tx
            .update(s.issues)
            .set({ attachmentCount: sql`GREATEST(${s.issues.attachmentCount} - ${files.length}, 0)` })
            .where(eq(s.issues.id, note.issueId));
          for (const file of files) {
            rows.push({ issueId: note.issueId, type: 'attachment_deleted', field: 'file', old: file.name });
          }
        }
      }

      await this.history.writeMany(tx, actor.id, rows, now);
      await this.uow.outbox(tx, 'note.deleted', {
        issueId: note.issueId, noteId, actorId: actor.id, keepFiles,
      });
    });
  }

  /**
   * Loads a note and asserts the caller may change it.
   *
   * `editOthersNotes` is enforced here. The frontend defines canEditNote() and then never calls
   * it on the write path, so in the browser any logged-in user can edit or delete somebody
   * else's note; the UI merely hides the buttons.
   */
  private async requireEditable(actor: AuthUser, noteId: number) {
    const [row] = await this.db
      .select({
        id: s.comments.id,
        issueId: s.comments.issueId,
        authorId: s.comments.authorId,
        body: s.comments.body,
        private: s.comments.private,
        timeSpent: s.comments.timeSpent,
        projectId: s.issues.projectId,
        summary: s.issues.summary,
      })
      .from(s.comments)
      .innerJoin(s.issues, eq(s.issues.id, s.comments.issueId))
      .where(and(eq(s.comments.id, noteId), isNull(s.comments.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundError('note', noteId);

    // The issue has to be visible too, or a 404 here would leak that the note exists.
    await this.issues.requireVisible(actor, row.issueId);

    const [wf, project] = await Promise.all([
      this.workflow.get(),
      this.tree.get(row.projectId),
    ]);
    if (!canEditNote(actor, row, project, wf)) {
      throw new PermissionDeniedError('editOthersNotes', row.projectId);
    }
    return row;
  }

  /** Mentions first, then the rest of the watchers — so nobody is told twice. */
  private async notifyForNote(
    tx: Tx,
    actor: AuthUser,
    note: {
      issueId: number; projectId: number; summary: string; reporterId: number;
      handlerId: number | null; noteId: number; body: RichText; private: boolean;
    },
  ): Promise<void> {
    const excerpt = plainText(note.body).slice(0, NOTIFY_EXCERPT);
    const mentioned = mentionedUserIds(note.body);
    const monitors = await tx
      .select({ userId: s.issueMonitors.userId })
      .from(s.issueMonitors)
      .where(eq(s.issueMonitors.issueId, note.issueId));

    const watchers = [
      ...monitors.map((m) => m.userId),
      note.reporterId,
      ...(note.handlerId ? [note.handlerId] : []),
    ];

    await this.fanout.emit(tx, actor.id, [
      ...(mentioned.length
        ? [{
            type: 'mentioned' as const, issueId: note.issueId, projectId: note.projectId,
            recipients: mentioned, subject: note.summary, excerpt,
            excerptPrivate: note.private, commentId: note.noteId,
          }]
        : []),
      {
        type: 'note' as const, issueId: note.issueId, projectId: note.projectId,
        recipients: watchers.filter((u) => !mentioned.includes(u)),
        subject: note.summary, excerpt, excerptPrivate: note.private, commentId: note.noteId,
      },
    ]);
  }
}
