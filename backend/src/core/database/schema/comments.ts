import { relations } from 'drizzle-orm';
import { boolean, index, int, longtext, mysqlTable, smallint } from 'drizzle-orm/mysql-core';
import type { RichText } from '../../../shared/models';
import { jsonLongtext, ts } from '../types/columns';
import { issues } from './issues';
import { users } from './users';

/**
 * Notes. Note text is deliberately NOT folded into issues.searchNorm: a private note must
 * not be searchable by someone who cannot read it, so `searchNotes` joins this table with
 * a visibility predicate instead. (The frontend builds its noteText map from every comment
 * without consulting canSeeNote, which is the one place the backend is stricter.)
 */
export const comments = mysqlTable(
  'comments',
  {
    id: int('id').primaryKey().autoincrement(),
    issueId: int('issueId')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    authorId: int('authorId')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    body: jsonLongtext<RichText>('body'),
    /** norm(plainText(body)) — FULLTEXT index added by hand in the migration. */
    bodyNorm: longtext('bodyNorm').notNull(),
    private: boolean('private').notNull().default(false),
    /** Minutes. Summed per author by GET /issues/:id/time. */
    timeSpent: smallint('timeSpent').notNull().default(0),
    created: ts('created').notNull(),
    edited: ts('edited'),
    deletedAt: ts('deletedAt'),
  },
  (t) => [
    index('idx_comments_issue').on(t.issueId, t.created),
    index('idx_comments_author').on(t.authorId),
    index('idx_comments_private').on(t.issueId, t.private),
    index('idx_comments_deleted').on(t.deletedAt),
  ],
);

export const commentsRelations = relations(comments, ({ one }) => ({
  issue: one(issues, { fields: [comments.issueId], references: [issues.id] }),
  author: one(users, { fields: [comments.authorId], references: [users.id] }),
}));
