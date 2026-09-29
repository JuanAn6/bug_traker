import { relations } from 'drizzle-orm';
import {
  boolean, char, index, int, mysqlTable, smallint, tinyint, varchar,
} from 'drizzle-orm/mysql-core';
import { DENSITIES, THEMES } from './enums';
import { enumCol, ts } from '../types/columns';

export const users = mysqlTable(
  'users',
  {
    id: int('id').primaryKey().autoincrement(),
    /** Unique case-insensitively: the column collation is utf8mb4_unicode_ci. */
    username: varchar('username', { length: 64 }).notNull().unique(),
    realName: varchar('realName', { length: 128 }).notNull(),
    email: varchar('email', { length: 190 }).notNull().unique(),
    /**
     * NULL means "demo account": with DEMO_MODE=true the login accepts any password for
     * these, which is what the frontend's fake auth does. Users created through the API
     * always get a hash and always require it.
     */
    passwordHash: varchar('passwordHash', { length: 255 }),
    /** MantisBT levels 10|25|40|55|70|90. Validated against ACCESS_LEVELS in the DTO. */
    accessLevel: tinyint('accessLevel').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    avatarColor: varchar('avatarColor', { length: 16 }).notNull(),
    lastVisit: ts('lastVisit'),
    created: ts('created').notNull(),
    /**
     * Bumped on password change and on disable, and compared against the `ver` claim, so
     * access tokens already in flight stop working instead of living out their 15 minutes.
     */
    tokenVersion: int('tokenVersion').notNull().default(0),
    deletedAt: ts('deletedAt'),
  },
  (t) => [index('idx_users_enabled_level').on(t.enabled, t.accessLevel)],
);

/**
 * One row per user, not a JSON blob on `users`.
 *
 * The five notify* flags MUST be columns: the notification fan-out resolves recipients in
 * a single query that filters on `prefs.notify[type]` (issue-actions.service.ts:57-66), so
 * it has to be a SQL predicate. `homeWidgets` stays a CSV because its order is
 * user-visible and it is never queried.
 */
export const userPrefs = mysqlTable('userPrefs', {
  userId: int('userId')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  language: varchar('language', { length: 8 }).notNull().default('en'),
  theme: enumCol('theme', THEMES).notNull().default('system'),
  density: enumCol('density', DENSITIES).notNull().default('compact'),
  /**
   * No FK on purpose: `projects` already references `users` (members, default handlers),
   * and adding the reverse edge would make the two schema modules circular. It is cleared
   * in application code when a project is deleted, exactly as Projects.remove does today.
   */
  defaultProjectId: int('defaultProjectId'),
  pageSize: smallint('pageSize').notNull().default(25),
  notesNewestFirst: boolean('notesNewestFirst').notNull().default(false),
  homeWidgets: varchar('homeWidgets', { length: 255 }).notNull(),
  notifyAssigned: boolean('notifyAssigned').notNull().default(true),
  notifyMentioned: boolean('notifyMentioned').notNull().default(true),
  notifyStatus: boolean('notifyStatus').notNull().default(true),
  notifyNote: boolean('notifyNote').notNull().default(true),
  notifyAttachment: boolean('notifyAttachment').notNull().default(true),
});

/**
 * Rotating refresh tokens. Only the sha256 is stored. Presenting a token that has already
 * been rotated away revokes the whole `family`, which is how token theft surfaces.
 */
export const refreshTokens = mysqlTable(
  'refreshTokens',
  {
    id: int('id').primaryKey().autoincrement(),
    userId: int('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: char('tokenHash', { length: 64 }).notNull().unique(),
    family: char('family', { length: 36 }).notNull(),
    userAgent: varchar('userAgent', { length: 255 }),
    ip: varchar('ip', { length: 45 }),
    expiresAt: ts('expiresAt').notNull(),
    revokedAt: ts('revokedAt'),
    created: ts('created').notNull(),
  },
  (t) => [
    index('idx_refresh_user').on(t.userId, t.expiresAt),
    index('idx_refresh_family').on(t.family),
  ],
);

export const usersRelations = relations(users, ({ one, many }) => ({
  prefs: one(userPrefs, { fields: [users.id], references: [userPrefs.userId] }),
  refreshTokens: many(refreshTokens),
}));

export const userPrefsRelations = relations(userPrefs, ({ one }) => ({
  user: one(users, { fields: [userPrefs.userId], references: [users.id] }),
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, { fields: [refreshTokens.userId], references: [users.id] }),
}));
