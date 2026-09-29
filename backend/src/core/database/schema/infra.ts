import { bigint, char, index, int, longtext, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { ts } from '../types/columns';
import { users } from './users';

/**
 * Transactional outbox. Domain events are appended in the same transaction as the write and
 * published only after it commits, so a rolled-back write can never emit an event. The
 * dispatcher claims rows with a conditional UPDATE, which makes delivery at-least-once —
 * subscribers must be idempotent.
 */
export const outbox = mysqlTable(
  'outbox',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().autoincrement(),
    topic: varchar('topic', { length: 64 }).notNull(),
    payload: longtext('payload').notNull(),
    created: ts('created').notNull(),
    dispatchedAt: ts('dispatchedAt'),
    attempts: int('attempts').notNull().default(0),
    lastError: varchar('lastError', { length: 512 }),
  },
  (t) => [index('idx_outbox_pending').on(t.dispatchedAt, t.id)],
);

/**
 * Replaces the frontend's whole-database snapshot undo, which cannot survive a move to the
 * server — restoring it would discard concurrent users' work. Each destructive operation
 * stores its compensating payload here instead, single-use and short-lived, and refuses if
 * the affected rows have changed since (compared on rowVersion), returning 409 undo.stale
 * rather than clobbering someone else's edit.
 */
export const undoTokens = mysqlTable(
  'undoTokens',
  {
    token: char('token', { length: 36 }).primaryKey(),
    userId: int('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    operation: varchar('operation', { length: 48 }).notNull(),
    payload: longtext('payload').notNull(),
    created: ts('created').notNull(),
    expiresAt: ts('expiresAt').notNull(),
    usedAt: ts('usedAt'),
  },
  (t) => [index('idx_undo_expiry').on(t.expiresAt)],
);

/** Audit of Db JSON imports, so a partial or surprising load can be traced afterwards. */
export const importRuns = mysqlTable('importRuns', {
  id: int('id').primaryKey().autoincrement(),
  schemaVersion: int('schemaVersion').notNull(),
  source: varchar('source', { length: 128 }).notNull(),
  mode: varchar('mode', { length: 16 }).notNull(),
  startedAt: ts('startedAt').notNull(),
  finishedAt: ts('finishedAt'),
  counts: longtext('counts'),
  error: varchar('error', { length: 1024 }),
});
