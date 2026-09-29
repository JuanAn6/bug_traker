import { relations } from 'drizzle-orm';
import { boolean, char, index, int, mysqlTable, smallint, varchar } from 'drizzle-orm/mysql-core';
import { ts } from '../types/columns';
import { comments } from './comments';
import { issues } from './issues';
import { users } from './users';

/**
 * Content-addressed blob registry. One row per distinct byte sequence, with a reference
 * count, so cloning an issue or re-uploading the same file shares a single file on disk.
 *
 * This is what reproduces the frontend's shared `blobId` for free — and the reference count
 * is what makes deletion safe, which the frontend's naive orphan scan gets away with only
 * because its blobId is one-to-one.
 */
export const blobs = mysqlTable('blobs', {
  hash: char('hash', { length: 64 }).primaryKey(),
  size: int('size').notNull(),
  refCount: int('refCount').notNull().default(0),
  created: ts('created').notNull(),
});

/**
 * One entity for ticket documents and note files alike; `commentId` records the origin.
 * A note file's visibility is DERIVED at read time from the note's `private` flag and is
 * never copied onto this row.
 */
export const attachments = mysqlTable(
  'attachments',
  {
    id: int('id').primaryKey().autoincrement(),
    /**
     * Stable id of the whole version chain (the first version's id). The frontend has no
     * such column and pays an O(n) backwards walk through previousVersionId for every
     * listing; with this, the chain is one indexed lookup.
     */
    documentId: int('documentId').notNull(),
    /**
     * NULL = pending upload, not yet attached to anything. The API translates NULL to the
     * `0` the frontend's model uses. Adopted inside the create transaction of an issue or
     * a note.
     */
    issueId: int('issueId').references(() => issues.id, { onDelete: 'cascade' }),
    commentId: int('commentId').references(() => comments.id, { onDelete: 'set null' }),
    name: varchar('name', { length: 255 }).notNull(),
    description: varchar('description', { length: 512 }).notNull().default(''),
    /** As declared by the client; kept for the Db round trip. */
    mimeType: varchar('mimeType', { length: 128 }).notNull(),
    /** As detected from the magic bytes. This is what gets served. */
    sniffedMimeType: varchar('sniffedMimeType', { length: 128 }),
    size: int('size').notNull(),
    uploaderId: int('uploaderId')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    date: ts('date').notNull(),
    version: smallint('version').notNull().default(1),
    /** Kept so GET /admin/export can rebuild the frontend's Db shape unchanged. */
    previousVersionId: int('previousVersionId'),
    current: boolean('current').notNull().default(true),
    blobHash: char('blobHash', { length: 64 }).notNull(),
    /** True for rows imported from a Db export, which carries metadata but no bytes. */
    blobMissing: boolean('blobMissing').notNull().default(false),
    deletedAt: ts('deletedAt'),
  },
  (t) => [
    index('idx_att_issue_current').on(t.issueId, t.current),
    index('idx_att_document').on(t.documentId, t.version),
    index('idx_att_comment').on(t.commentId),
    index('idx_att_blob').on(t.blobHash),
    index('idx_att_pending').on(t.issueId, t.uploaderId, t.date),
    index('idx_att_deleted').on(t.deletedAt),
  ],
);

export const attachmentsRelations = relations(attachments, ({ one }) => ({
  issue: one(issues, { fields: [attachments.issueId], references: [issues.id] }),
  comment: one(comments, { fields: [attachments.commentId], references: [comments.id] }),
  uploader: one(users, { fields: [attachments.uploaderId], references: [users.id] }),
  blob: one(blobs, { fields: [attachments.blobHash], references: [blobs.hash] }),
}));
