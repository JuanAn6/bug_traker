import { boolean, int, mysqlTable, primaryKey, smallint, tinyint, varchar } from 'drizzle-orm/mysql-core';
import { ACTIONS, STATUSES } from './enums';
import { enumCol, ts } from '../types/columns';
import { users } from './users';

/**
 * The single global WorkflowConfig. One row, id = 1.
 *
 * Authorization is CONFIGURATION, not code: every permission check reads
 * thresholds[action] from here, and an administrator can change them at runtime from
 * /admin/workflow. That is why WorkflowService caches the whole thing keyed by `revision`
 * and invalidates on write — otherwise every request would pay for these reads.
 *
 * Child tables rather than JSON blobs so each edit is auditable at row level.
 */
export const workflowConfig = mysqlTable('workflowConfig', {
  id: int('id').primaryKey().default(1),
  /** Stored but unused, exactly as in the frontend: isResolved() is hardcoded to 'resolved'. */
  resolvedStatus: enumCol('resolvedStatus', STATUSES).notNull(),
  autoAssignStatus: boolean('autoAssignStatus').notNull().default(true),
  /** Ordered Status CSV. The default omits 'acknowledged'. */
  boardColumns: varchar('boardColumns', { length: 128 }).notNull(),
  /** Bumped on every write; the cache key includes it. */
  revision: int('revision').notNull().default(0),
  updatedAt: ts('updatedAt').notNull(),
  updatedById: int('updatedById').references(() => users.id, { onDelete: 'set null' }),
});

/** The 7×7 adjacency matrix. A missing row means the transition is forbidden. */
export const workflowTransitions = mysqlTable(
  'workflowTransitions',
  {
    fromStatus: enumCol('fromStatus', STATUSES).notNull(),
    toStatus: enumCol('toStatus', STATUSES).notNull(),
  },
  (t) => [primaryKey({ columns: [t.fromStatus, t.toStatus] })],
);

/** One row per Action: the minimum access level that may perform it. */
export const workflowThresholds = mysqlTable(
  'workflowThresholds',
  {
    action: enumCol('action', ACTIONS).notNull(),
    level: tinyint('level').notNull(),
  },
  (t) => [primaryKey({ columns: [t.action] })],
);

/** Hex colors the shell paints into --status-* CSS variables. */
export const workflowStatusColors = mysqlTable(
  'workflowStatusColors',
  {
    status: enumCol('status', STATUSES).notNull(),
    color: varchar('color', { length: 16 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.status] })],
);

/** Sparse by design — Partial<Record<Status, number>>; only 'assigned' has a default. */
export const workflowWipLimits = mysqlTable(
  'workflowWipLimits',
  {
    status: enumCol('status', STATUSES).notNull(),
    limitValue: smallint('limitValue').notNull(),
  },
  (t) => [primaryKey({ columns: [t.status] })],
);
