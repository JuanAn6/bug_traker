import { relations } from 'drizzle-orm';
import { boolean, index, int, longtext, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { NOTIFY_EVENTS, STATUSES } from './enums';
import { enumCol, ts } from '../types/columns';
import { comments } from './comments';
import { issues } from './issues';
import { projects } from './projects';
import { users } from './users';

/**
 * In-app notifications.
 *
 * The frontend renders a `text` that was already translated into the ACTOR's language
 * (`${t('status.'+old)} → ${t('status.'+new)}: ${summary}`), freezing the language at write
 * time. The structured columns let the reader's own language win; `text` stays as a
 * fallback for rows that came in through an import.
 */
export const notifications = mysqlTable(
  'notifications',
  {
    id: int('id').primaryKey().autoincrement(),
    userId: int('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    issueId: int('issueId')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    actorId: int('actorId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: enumCol('type', NOTIFY_EVENTS).notNull(),
    read: boolean('read').notNull().default(false),
    date: ts('date').notNull(),

    fromStatus: enumCol('fromStatus', STATUSES),
    toStatus: enumCol('toStatus', STATUSES),
    commentId: int('commentId').references(() => comments.id, { onDelete: 'set null' }),
    attachmentId: int('attachmentId'),
    /** Snapshot of the issue summary at notification time. */
    subject: varchar('subject', { length: 255 }).notNull().default(''),
    /** 140-char excerpt of a note or mention body. */
    excerpt: varchar('excerpt', { length: 160 }),
    /**
     * Marks an excerpt taken from a private note. Parity with the frontend means it is
     * still sent today; flipping to suppression at read time is then a one-line change in
     * the reader with no migration.
     */
    excerptPrivate: boolean('excerptPrivate').notNull().default(false),
    text: varchar('text', { length: 255 }).notNull().default(''),
  },
  (t) => [
    index('idx_notif_user').on(t.userId, t.read, t.date),
    index('idx_notif_issue').on(t.issueId),
  ],
);

/**
 * Saved filters. `criteria` holds only the non-default keys, exactly as criteriaToParams
 * serializes them. MariaDB has no partial unique index, so "one default per owner" is
 * enforced inside the transaction — the same way the frontend does it.
 */
export const savedFilters = mysqlTable(
  'savedFilters',
  {
    id: int('id').primaryKey().autoincrement(),
    name: varchar('name', { length: 128 }).notNull(),
    ownerId: int('ownerId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    shared: boolean('shared').notNull().default(false),
    projectId: int('projectId').references(() => projects.id, { onDelete: 'set null' }),
    isDefault: boolean('isDefault').notNull().default(false),
    criteria: longtext('criteria').notNull(),
    /** Ordered ColumnId CSV. */
    columns: varchar('columns', { length: 512 }).notNull().default(''),
    /** "priority:desc,id:desc" */
    sort: varchar('sort', { length: 255 }).notNull().default(''),
    deletedAt: ts('deletedAt'),
  },
  (t) => [
    index('idx_filters_owner').on(t.ownerId),
    index('idx_filters_shared').on(t.shared),
  ],
);

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id], relationName: 'receivedNotifications' }),
  actor: one(users, { fields: [notifications.actorId], references: [users.id], relationName: 'sentNotifications' }),
  issue: one(issues, { fields: [notifications.issueId], references: [issues.id] }),
  comment: one(comments, { fields: [notifications.commentId], references: [comments.id] }),
}));

export const savedFiltersRelations = relations(savedFilters, ({ one }) => ({
  owner: one(users, { fields: [savedFilters.ownerId], references: [users.id] }),
}));
