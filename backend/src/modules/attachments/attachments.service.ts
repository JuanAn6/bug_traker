import { Readable } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Env } from '../../core/config/env.schema';
import {
  ConflictError, NotFoundError, PermissionDeniedError, ValidationError,
} from '../../common/errors/domain-error';
import { DRIZZLE, type Db } from '../../core/database/drizzle.service';
import * as s from '../../core/database/schema';
import { insertedId, UnitOfWork, type Tx } from '../../core/database/unit-of-work';
import { ProjectTreeService } from '../../core/project-tree/project-tree.service';
import { WorkflowService } from '../../core/workflow/workflow.service';
import { STORAGE_PORT, BlobTooLargeError, type StoragePort } from '../../core/ports/storage.port';
import { can, canDeleteAttachment, canSeeNote } from '../auth/ability';
import type { AuthUser } from '../auth/auth.types';
import { HistoryWriter } from '../history/history.writer';
import { NotificationFanout } from '../notifications/notification.fanout';
import { IssuesQueryService } from '../issues/issues.query.service';
import {
  isDangerousSniffedType, kindOf, MAX_FILE_SIZE, sniffType, validateName,
} from './attachment-validation';

export interface AttachmentView {
  id: number;
  documentId: number;
  issueId: number;
  /** null for a ticket document; set when the file arrived with a note. */
  commentId: number | null;
  name: string;
  description: string;
  mimeType: string;
  size: number;
  uploaderId: number;
  uploaderName: string;
  date: string;
  version: number;
  kind: ReturnType<typeof kindOf>;
  /** True for rows imported from a Db export, which carries metadata but no bytes. */
  blobMissing: boolean;
  canDelete: boolean;
  /** Older versions, newest first. Only present on the current one. */
  versions?: Array<{ id: number; name: string; size: number; date: string; version: number; uploaderId: number }>;
}

export interface UploadTarget {
  /** 0 or undefined means a pending upload, not yet attached to anything. */
  issueId?: number;
  commentId?: number | null;
  description?: string;
}

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);
  private readonly pendingMaxFiles: number;
  private readonly pendingMaxBytes: number;
  private readonly retentionDays: number;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    private readonly uow: UnitOfWork,
    private readonly issues: IssuesQueryService,
    private readonly tree: ProjectTreeService,
    private readonly workflow: WorkflowService,
    private readonly history: HistoryWriter,
    private readonly fanout: NotificationFanout,
    config: ConfigService<Env, true>,
  ) {
    this.pendingMaxFiles = config.get('PENDING_UPLOAD_MAX_FILES', { infer: true });
    this.pendingMaxBytes = config.get('PENDING_UPLOAD_MAX_BYTES', { infer: true });
    this.retentionDays = config.get('ATTACHMENT_RETENTION_DAYS', { infer: true });
  }

  /**
   * Stores an uploaded file.
   *
   * The bytes go to disk first, hashed as they stream, and only then does a row appear — so a
   * failed or oversized upload cannot leave metadata pointing at nothing. If the content was
   * already stored, the reference count goes up and no second copy is written.
   */
  async upload(
    actor: AuthUser,
    file: {
      filename: string;
      mimetype: string;
      stream: Readable;
      /** True once the multipart layer cut the stream at its own size limit. */
      wasTruncated?: () => boolean;
    },
    target: UploadTarget,
  ): Promise<{ id: number }> {
    const nameError = validateName(file.filename);
    if (nameError) throw new ValidationError(nameError, `Rejected file ${file.filename}`);

    const projectId = target.issueId ? await this.assertCanUpload(actor, target.issueId) : null;
    if (!target.issueId) await this.assertPendingQuota(actor);

    let stored;
    let sniffed: string | undefined;
    try {
      // The first bytes are tapped for type sniffing on the way past, so the file is not read
      // twice and never has to be buffered whole.
      const head: Buffer[] = [];
      let headBytes = 0;
      const tapped = async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          if (headBytes < 4100) {
            head.push(chunk);
            headBytes += chunk.length;
          }
          yield chunk;
        }
      };
      const tappedStream = Readable.from(tapped(file.stream as AsyncIterable<Buffer>));
      stored = await this.storage.put(tappedStream, { maxBytes: MAX_FILE_SIZE });
      sniffed = await sniffType(Buffer.concat(head));
    } catch (e) {
      if (e instanceof BlobTooLargeError) {
        throw new ValidationError('files.tooLarge', `Maximum ${MAX_FILE_SIZE} bytes`);
      }
      throw e;
    }

    /**
     * Fastify's multipart layer enforces its own `limits.fileSize` by TRUNCATING the stream, not by
     * throwing — so an oversized upload arrives as a complete-looking file of exactly maxBytes and
     * `size > maxBytes` never fires. Storing that would mean a silently corrupted file presented as
     * whole, which is worse than rejecting it.
     */
    if (file.wasTruncated?.()) {
      throw new ValidationError('files.tooLarge', `Maximum ${MAX_FILE_SIZE} bytes`);
    }

    // The extension check is bypassed by renaming, so the magic bytes have the final say. Bailing
    // out here can leave the bytes on disk with no row referencing them; the purge job collects
    // those, which is why it sweeps the disk and not only the blobs table.
    if (isDangerousSniffedType(sniffed)) {
      throw new ValidationError('files.blockedType', `Detected ${sniffed ?? 'executable'} content`);
    }

    const id = await this.uow.transaction(async (tx) => {
      await this.retainBlob(tx, stored.hash, stored.size);

      const now = new Date();
      const attachmentId = insertedId(
        await tx.insert(s.attachments).values({
          documentId: 0,
          issueId: target.issueId ?? null,
          commentId: target.commentId ?? null,
          name: file.filename.slice(0, 255),
          description: (target.description ?? '').slice(0, 512),
          mimeType: file.mimetype || 'application/octet-stream',
          sniffedMimeType: sniffed ?? null,
          size: stored.size,
          uploaderId: actor.id,
          date: now,
          version: 1,
          previousVersionId: null,
          current: true,
          blobHash: stored.hash,
          blobMissing: false,
        }),
      );
      // The first version of a document IS the document, so the chain root is its own id.
      await tx.update(s.attachments).set({ documentId: attachmentId })
        .where(eq(s.attachments.id, attachmentId));

      if (target.issueId) {
        await this.bumpCount(tx, target.issueId, 1);
        await this.history.write(tx, actor.id, {
          issueId: target.issueId, type: 'attachment_added', field: 'file', new: file.filename,
        });
        await this.notifyWatchers(tx, actor, target.issueId, projectId!, file.filename);
        await this.uow.outbox(tx, 'attachment.added', {
          issueId: target.issueId, attachmentId, actorId: actor.id,
        });
      }
      return attachmentId;
    });

    return { id };
  }

  /**
   * Attaches pending uploads to an issue or a note.
   *
   * Called from inside the create transaction of an issue or a note. Each id is verified to be a
   * pending row belonging to THIS caller — otherwise a client could adopt somebody else's upload by
   * guessing an id, which the frontend's silent skip would hide.
   */
  async adopt(
    tx: Tx,
    actor: AuthUser,
    attachmentIds: number[],
    target: { issueId: number; commentId?: number | null },
  ): Promise<void> {
    if (!attachmentIds.length) return;

    const rows = await tx
      .select()
      .from(s.attachments)
      .where(and(
        inArray(s.attachments.id, attachmentIds),
        isNull(s.attachments.issueId),
        eq(s.attachments.uploaderId, actor.id),
        isNull(s.attachments.deletedAt),
      ));

    if (rows.length !== attachmentIds.length) {
      // Rejected rather than skipped: silently dropping an attachment the user thinks they
      // attached is worse than an error they can act on.
      throw new ConflictError('files.adoptFailed', { expected: attachmentIds.length, found: rows.length });
    }

    await tx
      .update(s.attachments)
      .set({ issueId: target.issueId, commentId: target.commentId ?? null })
      .where(inArray(s.attachments.id, rows.map((r) => r.id)));

    await this.bumpCount(tx, target.issueId, rows.length);
    await this.history.writeMany(
      tx,
      actor.id,
      rows.map((r) => ({
        issueId: target.issueId, type: 'attachment_added' as const, field: 'file', new: r.name,
      })),
    );
  }

  /**
   * Uploads a replacement, keeping the old one as history.
   *
   * The previous row loses `current` and the new one inherits its `documentId`, so the chain is a
   * single indexed lookup instead of the backwards walk through `previousVersionId` that the
   * frontend has to do.
   */
  async addVersion(
    actor: AuthUser,
    attachmentId: number,
    file: {
      filename: string;
      mimetype: string;
      stream: Readable;
      wasTruncated?: () => boolean;
    },
  ): Promise<{ id: number; version: number }> {
    const referenced = await this.requireAttachment(actor, attachmentId);
    if (!referenced.issueId) {
      throw new ValidationError('errors.validation', 'A pending upload has no versions');
    }
    const projectId = await this.assertCanUpload(actor, referenced.issueId);

    /**
     * Versions stack on the HEAD of the document, not on whatever id the caller happened to send.
     *
     * A client holding a stale listing can easily pass an older version's id; basing the new
     * version on that row would number it after the old one and produce two rows claiming the same
     * version, with two rows marked current.
     */
    const current = await this.documentHead(referenced.documentId);

    const nameError = validateName(file.filename);
    if (nameError) throw new ValidationError(nameError, `Rejected file ${file.filename}`);

    let stored;
    let sniffed: string | undefined;
    try {
      const head: Buffer[] = [];
      let headBytes = 0;
      const tapped = async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          if (headBytes < 4100) { head.push(chunk); headBytes += chunk.length; }
          yield chunk;
        }
      };
      stored = await this.storage.put(
        Readable.from(tapped(file.stream as AsyncIterable<Buffer>)),
        { maxBytes: MAX_FILE_SIZE },
      );
      sniffed = await sniffType(Buffer.concat(head));
    } catch (e) {
      if (e instanceof BlobTooLargeError) {
        throw new ValidationError('files.tooLarge', `Maximum ${MAX_FILE_SIZE} bytes`);
      }
      throw e;
    }
    if (file.wasTruncated?.()) {
      throw new ValidationError('files.tooLarge', `Maximum ${MAX_FILE_SIZE} bytes`);
    }
    if (isDangerousSniffedType(sniffed)) {
      throw new ValidationError('files.blockedType', `Detected ${sniffed ?? 'executable'} content`);
    }

    return this.uow.transaction(async (tx) => {
      await this.retainBlob(tx, stored.hash, stored.size);

      const now = new Date();
      await tx.update(s.attachments).set({ current: false }).where(eq(s.attachments.id, current.id));

      const version = current.version + 1;
      const newId = insertedId(
        await tx.insert(s.attachments).values({
          documentId: current.documentId,
          issueId: current.issueId,
          commentId: current.commentId,
          name: file.filename.slice(0, 255),
          description: current.description,
          mimeType: file.mimetype || 'application/octet-stream',
          sniffedMimeType: sniffed ?? null,
          size: stored.size,
          uploaderId: actor.id,
          date: now,
          version,
          previousVersionId: current.id,
          current: true,
          blobHash: stored.hash,
          blobMissing: false,
        }),
      );

      // The count follows current documents, and the document count has not changed.
      await this.history.write(tx, actor.id, {
        issueId: current.issueId!,
        type: 'attachment_version',
        field: 'file',
        old: current.name,
        new: `${file.filename} (v${version})`,
      });
      await this.notifyWatchers(tx, actor, current.issueId!, projectId, file.filename);
      await this.uow.outbox(tx, 'attachment.version', {
        issueId: current.issueId, attachmentId: newId, actorId: actor.id,
      });

      return { id: newId, version };
    });
  }

  /** The current row of a version chain — the one a new version stacks on. */
  private async documentHead(documentId: number) {
    const [head] = await this.db
      .select()
      .from(s.attachments)
      .where(and(eq(s.attachments.documentId, documentId), isNull(s.attachments.deletedAt)))
      .orderBy(desc(s.attachments.version))
      .limit(1);
    if (!head) throw new NotFoundError('attachment', documentId);
    return head;
  }

  async rename(
    actor: AuthUser,
    attachmentId: number,
    changes: { name?: string; description?: string },
  ): Promise<void> {
    const attachment = await this.requireAttachment(actor, attachmentId);
    if (!attachment.issueId) throw new NotFoundError('attachment', attachmentId);
    await this.assertCanDelete(actor, attachment);

    if (changes.name !== undefined) {
      const nameError = validateName(changes.name);
      if (nameError) throw new ValidationError(nameError, `Rejected name ${changes.name}`);
    }

    await this.uow.transaction(async (tx) => {
      await tx
        .update(s.attachments)
        .set({
          ...(changes.name !== undefined ? { name: changes.name.slice(0, 255) } : {}),
          ...(changes.description !== undefined ? { description: changes.description.slice(0, 512) } : {}),
        })
        .where(eq(s.attachments.id, attachmentId));

      if (changes.name !== undefined && changes.name !== attachment.name) {
        await this.history.write(tx, actor.id, {
          issueId: attachment.issueId!,
          type: 'attachment_renamed',
          field: 'file',
          old: attachment.name,
          new: changes.name,
        });
      }
    });
  }

  /**
   * Soft-deletes the whole version chain.
   *
   * The chain goes together because the older versions only exist as history of the current one —
   * keeping them after the document is gone would leave rows nothing can reach. The blobs stay
   * until the purge job finds them unreferenced, so a restore is possible and a shared blob is
   * never pulled out from under another attachment.
   */
  async remove(actor: AuthUser, attachmentId: number): Promise<{ removed: number }> {
    const attachment = await this.requireAttachment(actor, attachmentId);
    await this.assertCanDelete(actor, attachment);

    return this.uow.transaction(async (tx) => {
      const chain = await tx
        .select({ id: s.attachments.id, name: s.attachments.name, version: s.attachments.version })
        .from(s.attachments)
        .where(and(eq(s.attachments.documentId, attachment.documentId), isNull(s.attachments.deletedAt)));

      const now = new Date();
      await tx
        .update(s.attachments)
        .set({ deletedAt: now, current: false })
        .where(inArray(s.attachments.id, chain.map((c) => c.id)));

      if (attachment.issueId) {
        await this.bumpCount(tx, attachment.issueId, -1);
        await this.history.write(tx, actor.id, {
          issueId: attachment.issueId,
          type: 'attachment_deleted',
          field: 'file',
          // The version count is in the message: deleting a document with a history is a bigger
          // act than deleting a single file, and the log should say so.
          old: chain.length > 1 ? `${attachment.name} (${chain.length} versions)` : attachment.name,
        });
        await this.uow.outbox(tx, 'attachment.deleted', {
          issueId: attachment.issueId, attachmentId, actorId: actor.id,
        });
      }
      return { removed: chain.length };
    });
  }

  /**
   * Every current document on an issue, ticket files and note files together.
   *
   * One list, because a note file is just an attachment with `commentId` set — the same decision
   * the frontend made. A note file's visibility is DERIVED from the note's `private` flag at read
   * time, never copied onto the attachment row, so changing a note's privacy moves its files with it.
   */
  async listForIssue(actor: AuthUser, issueId: number): Promise<AttachmentView[]> {
    const issue = await this.issues.requireVisible(actor, issueId);
    const [wf, project] = await Promise.all([
      this.workflow.get(),
      this.tree.get(issue.projectId),
    ]);

    const rows = await this.db
      .select({
        attachment: s.attachments,
        uploaderName: s.users.realName,
        notePrivate: s.comments.private,
        noteAuthorId: s.comments.authorId,
      })
      .from(s.attachments)
      .innerJoin(s.users, eq(s.users.id, s.attachments.uploaderId))
      .leftJoin(s.comments, eq(s.comments.id, s.attachments.commentId))
      .where(and(eq(s.attachments.issueId, issueId), isNull(s.attachments.deletedAt)))
      .orderBy(desc(s.attachments.date));

    const visible = rows.filter((r) =>
      r.attachment.commentId === null ||
      canSeeNote(actor, { authorId: r.noteAuthorId ?? 0, private: r.notePrivate ?? false }, project, wf));

    const chains = new Map<number, typeof visible>();
    for (const row of visible) {
      const list = chains.get(row.attachment.documentId);
      if (list) list.push(row);
      else chains.set(row.attachment.documentId, [row]);
    }

    const out: AttachmentView[] = [];
    for (const chain of chains.values()) {
      const sorted = [...chain].sort((a, b) => b.attachment.version - a.attachment.version);
      const head = sorted.find((r) => r.attachment.current) ?? sorted[0]!;
      const older = sorted.filter((r) => r.attachment.id !== head.attachment.id);

      out.push({
        ...this.toView(head.attachment, head.uploaderName, actor, project, wf),
        ...(older.length
          ? {
              versions: older.map((r) => ({
                id: r.attachment.id,
                name: r.attachment.name,
                size: r.attachment.size,
                date: r.attachment.date.toISOString(),
                version: r.attachment.version,
                uploaderId: r.attachment.uploaderId,
              })),
            }
          : {}),
      });
    }
    return out.sort((a, b) => b.date.localeCompare(a.date));
  }

  /** Resolves one attachment for download, after the same visibility checks. */
  async forDownload(actor: AuthUser, attachmentId: number) {
    const attachment = await this.requireAttachment(actor, attachmentId);
    if (attachment.blobMissing) {
      // Imported from a Db export, which carries metadata but no bytes.
      throw new ConflictError('files.contentMissing', { id: attachmentId });
    }
    const info = await this.storage.stat(attachment.blobHash);
    if (!info) throw new ConflictError('files.contentMissing', { id: attachmentId });
    return { attachment, size: info.size };
  }

  openBlob(hash: string, range?: { start: number; end: number }): Promise<Readable> {
    return this.storage.open(hash, range);
  }

  /** Current, visible documents on an issue — what the zip download packs. */
  async zipManifest(actor: AuthUser, issueId: number) {
    const documents = await this.listForIssue(actor, issueId);
    const usable = documents.filter((d) => !d.blobMissing);

    const rows = await this.db
      .select({ id: s.attachments.id, blobHash: s.attachments.blobHash })
      .from(s.attachments)
      .where(inArray(s.attachments.id, usable.length ? usable.map((d) => d.id) : [-1]));
    const hashById = new Map(rows.map((r) => [r.id, r.blobHash]));

    // Two files can legitimately share a name — one from a note, one from the ticket — so the
    // second gets a suffix rather than silently overwriting the first inside the archive.
    const used = new Map<string, number>();
    return usable.map((d) => {
      const seen = used.get(d.name) ?? 0;
      used.set(d.name, seen + 1);
      const name = seen === 0 ? d.name : suffixName(d.name, seen + 1);
      return { name, hash: hashById.get(d.id)!, size: d.size };
    });
  }

  /**
   * Reclaims storage.
   *
   * Three passes, in this order: abandoned pending uploads, then metadata past its retention, then
   * blobs nothing references. The order matters — deleting rows first is what makes their blobs
   * collectable in the same run.
   */
  async purgeOrphans(): Promise<{
    pendingRemoved: number;
    rowsRemoved: number;
    blobsRemoved: number;
    bytesReclaimed: number;
    danglingReferences: number;
  }> {
    const pendingCutoff = new Date(Date.now() - 86_400_000);
    const retentionCutoff = new Date(Date.now() - this.retentionDays * 86_400_000);

    const pending = await this.db
      .select({ id: s.attachments.id })
      .from(s.attachments)
      .where(and(isNull(s.attachments.issueId), lt(s.attachments.date, pendingCutoff)));
    if (pending.length) {
      await this.db.delete(s.attachments).where(inArray(s.attachments.id, pending.map((p) => p.id)));
    }

    const expired = await this.db
      .select({ id: s.attachments.id })
      .from(s.attachments)
      .where(lt(s.attachments.deletedAt, retentionCutoff));
    if (expired.length) {
      await this.db.delete(s.attachments).where(inArray(s.attachments.id, expired.map((e) => e.id)));
    }

    // Recomputed rather than trusted: refCount is maintained incrementally, and this job is the
    // one place that can notice it drifted.
    await this.db.execute(sql`
      UPDATE blobs b SET refCount =
        (SELECT COUNT(*) FROM attachments a WHERE a.blobHash = b.hash)
    `);

    const unreferenced = await this.db
      .select({ hash: s.blobs.hash, size: s.blobs.size })
      .from(s.blobs)
      .where(eq(s.blobs.refCount, 0));

    let blobsRemoved = 0;
    let bytesReclaimed = 0;
    for (const blob of unreferenced) {
      if (await this.storage.delete(blob.hash)) {
        blobsRemoved += 1;
        bytesReclaimed += blob.size;
      }
      await this.db.delete(s.blobs).where(eq(s.blobs.hash, blob.hash));
    }

    /**
     * And bytes on disk with no row at all.
     *
     * A validation failure after the stream has been written — a renamed executable, a truncated
     * upload — leaves the file in place but never creates the `blobs` row, so the refCount sweep
     * above cannot see it. This is the only pass that can.
     */
    const known = new Set(
      (await this.db.select({ hash: s.blobs.hash }).from(s.blobs)).map((b) => b.hash),
    );
    for await (const hash of this.storage.listHashes()) {
      if (known.has(hash)) continue;
      const info = await this.storage.stat(hash);
      if (await this.storage.delete(hash)) {
        blobsRemoved += 1;
        bytesReclaimed += info?.size ?? 0;
      }
    }

    const dangling = await this.countDanglingReferences();
    if (dangling) {
      // Rich text can embed `attachment:<id>`, and nothing stops an attachment being deleted while
      // a note still points at it — the frontend has the same gap, and the images simply break.
      // Reported rather than repaired: the fix is a product decision.
      this.logger.warn(`${dangling} rich-text reference(s) point at a deleted attachment`);
    }

    return {
      pendingRemoved: pending.length,
      rowsRemoved: expired.length,
      blobsRemoved,
      bytesReclaimed,
      danglingReferences: dangling,
    };
  }

  async usage() {
    const [row] = await this.db
      .select({
        documents: sql<number>`COUNT(*)`,
        bytes: sql<number>`COALESCE(SUM(${s.attachments.size}), 0)`,
      })
      .from(s.attachments)
      .where(and(eq(s.attachments.current, true), isNull(s.attachments.deletedAt)));
    return { ...(await this.storage.usage()), documents: Number(row?.documents ?? 0) };
  }

  // ───────────────────────────── internals ─────────────────────────────

  /** Adds a reference, inserting the blob row the first time those bytes are seen. */
  private async retainBlob(tx: Tx, hash: string, size: number): Promise<void> {
    await tx
      .insert(s.blobs)
      .values({ hash, size, refCount: 1, created: new Date() })
      .onDuplicateKeyUpdate({ set: { refCount: sql`${s.blobs.refCount} + 1` } });
  }

  private async bumpCount(tx: Tx, issueId: number, delta: number): Promise<void> {
    await tx
      .update(s.issues)
      .set({
        attachmentCount: delta > 0
          ? sql`${s.issues.attachmentCount} + ${delta}`
          : sql`GREATEST(${s.issues.attachmentCount} + ${delta}, 0)`,
      })
      .where(eq(s.issues.id, issueId));
  }

  private async requireAttachment(actor: AuthUser, id: number) {
    const [row] = await this.db
      .select()
      .from(s.attachments)
      .where(and(eq(s.attachments.id, id), isNull(s.attachments.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundError('attachment', id);

    if (row.issueId) {
      // 404s for an attachment on an issue the caller cannot see.
      const issue = await this.issues.requireVisible(actor, row.issueId);
      if (row.commentId) {
        const [note] = await this.db
          .select({ private: s.comments.private, authorId: s.comments.authorId })
          .from(s.comments)
          .where(eq(s.comments.id, row.commentId))
          .limit(1);
        const [wf, project] = await Promise.all([
          this.workflow.get(),
          this.tree.get(issue.projectId),
        ]);
        // A note file inherits the note's visibility, derived here rather than stored.
        if (note && !canSeeNote(actor, note, project, wf)) throw new NotFoundError('attachment', id);
      }
    } else if (row.uploaderId !== actor.id) {
      // A pending upload belongs to whoever started it and nobody else.
      throw new NotFoundError('attachment', id);
    }
    return row;
  }

  private async assertCanUpload(actor: AuthUser, issueId: number): Promise<number> {
    const issue = await this.issues.requireVisible(actor, issueId);
    const [wf, project] = await Promise.all([
      this.workflow.get(),
      this.tree.get(issue.projectId),
    ]);
    if (!can(actor, 'uploadFile', project, wf)) {
      throw new PermissionDeniedError('uploadFile', issue.projectId);
    }
    return issue.projectId;
  }

  private async assertCanDelete(actor: AuthUser, attachment: typeof s.attachments.$inferSelect) {
    if (!attachment.issueId) return; // own pending upload
    const issue = await this.issues.requireVisible(actor, attachment.issueId);
    const [wf, project] = await Promise.all([
      this.workflow.get(),
      this.tree.get(issue.projectId),
    ]);
    if (!canDeleteAttachment(actor, attachment, project, wf)) {
      throw new PermissionDeniedError('deleteOthersFiles', issue.projectId);
    }
  }

  /**
   * Caps what one account can leave lying around unattached.
   *
   * A pending upload has no issue, so there is no project to check `uploadFile` against — only the
   * global threshold applies, which almost everyone clears. Without a cap that is a way to fill the
   * disk, and the frontend has no defence at all.
   */
  private async assertPendingQuota(actor: AuthUser): Promise<void> {
    const [row] = await this.db
      .select({
        files: sql<number>`COUNT(*)`,
        bytes: sql<number>`COALESCE(SUM(${s.attachments.size}), 0)`,
      })
      .from(s.attachments)
      .where(and(
        isNull(s.attachments.issueId),
        eq(s.attachments.uploaderId, actor.id),
        isNull(s.attachments.deletedAt),
      ));

    if (Number(row?.files ?? 0) >= this.pendingMaxFiles) {
      throw new ConflictError('files.pendingLimit', { limit: this.pendingMaxFiles });
    }
    if (Number(row?.bytes ?? 0) >= this.pendingMaxBytes) {
      throw new ConflictError('files.pendingLimit', { limit: this.pendingMaxBytes });
    }
  }

  private async notifyWatchers(
    tx: Tx,
    actor: AuthUser,
    issueId: number,
    projectId: number,
    filename: string,
  ): Promise<void> {
    const [issue] = await tx
      .select({ summary: s.issues.summary, reporterId: s.issues.reporterId, handlerId: s.issues.handlerId })
      .from(s.issues)
      .where(eq(s.issues.id, issueId))
      .limit(1);
    if (!issue) return;

    const monitors = await tx
      .select({ userId: s.issueMonitors.userId })
      .from(s.issueMonitors)
      .where(eq(s.issueMonitors.issueId, issueId));

    await this.fanout.emit(tx, actor.id, [{
      type: 'attachment',
      issueId,
      projectId,
      recipients: [
        ...monitors.map((m) => m.userId),
        issue.reporterId,
        ...(issue.handlerId ? [issue.handlerId] : []),
      ],
      subject: issue.summary,
      excerpt: filename,
    }]);
  }

  /** `attachment:<id>` images in rich text whose attachment is gone. */
  private async countDanglingReferences(): Promise<number> {
    const [row] = await this.db.execute(sql`
      SELECT COUNT(*) AS n FROM (
        SELECT i.id FROM issues i
        WHERE i.deletedAt IS NULL AND (
          i.description LIKE '%attachment:%' OR
          i.stepsToReproduce LIKE '%attachment:%' OR
          i.additionalInfo LIKE '%attachment:%')
        UNION ALL
        SELECT c.id FROM comments c
        WHERE c.deletedAt IS NULL AND c.body LIKE '%attachment:%'
      ) refs
    `) as unknown as Array<Array<{ n: number }>>;
    return Number(row?.[0]?.n ?? 0);
  }

  private toView(
    attachment: typeof s.attachments.$inferSelect,
    uploaderName: string,
    actor: AuthUser,
    project: Awaited<ReturnType<ProjectTreeService['get']>>,
    wf: Awaited<ReturnType<WorkflowService['get']>>,
  ): AttachmentView {
    return {
      id: attachment.id,
      documentId: attachment.documentId,
      issueId: attachment.issueId ?? 0,
      commentId: attachment.commentId,
      name: attachment.name,
      description: attachment.description,
      mimeType: attachment.mimeType,
      size: attachment.size,
      uploaderId: attachment.uploaderId,
      uploaderName,
      date: attachment.date.toISOString(),
      version: attachment.version,
      kind: kindOf(attachment.sniffedMimeType ?? attachment.mimeType, attachment.name),
      blobMissing: attachment.blobMissing,
      canDelete: canDeleteAttachment(actor, attachment, project, wf),
    };
  }
}

const suffixName = (name: string, n: number): string => {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? `${name} (${n})` : `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
};
