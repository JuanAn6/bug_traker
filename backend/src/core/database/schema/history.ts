import { relations } from 'drizzle-orm';
import { index, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { HISTORY_TYPES } from './enums';
import { enumCol, ts } from '../types/columns';
import { issues } from './issues';
import { users } from './users';

/**
 * The audit trail. `old`/`new` are always strings — the frontend's str() stringifies
 * scalars and truncates rich fields to a 120-character plain-text excerpt — so this table
 * never holds structured values.
 *
 * The (issueId, field) index exists for the importer, which derives resolvedAt from rows
 * where field='status', and for /summary's reopen count (field='resolution', new='reopened').
 */
export const historyEntries = mysqlTable(
  'historyEntries',
  {
    id: int('id').primaryKey().autoincrement(),
    issueId: int('issueId')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    userId: int('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    date: ts('date').notNull(),
    type: enumCol('type', HISTORY_TYPES).notNull(),
    field: varchar('field', { length: 32 }).notNull().default(''),
    oldValue: varchar('oldValue', { length: 255 }).notNull().default(''),
    newValue: varchar('newValue', { length: 255 }).notNull().default(''),
  },
  (t) => [
    index('idx_history_issue').on(t.issueId, t.date),
    index('idx_history_field').on(t.issueId, t.field),
    index('idx_history_date').on(t.date),
    index('idx_history_user').on(t.userId, t.date),
  ],
);

export const historyEntriesRelations = relations(historyEntries, ({ one }) => ({
  issue: one(issues, { fields: [historyEntries.issueId], references: [issues.id] }),
  user: one(users, { fields: [historyEntries.userId], references: [users.id] }),
}));
