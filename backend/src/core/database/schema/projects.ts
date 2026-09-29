import { relations } from 'drizzle-orm';
import {
  boolean, index, int, mysqlTable, primaryKey, smallint, tinyint, varchar,
} from 'drizzle-orm/mysql-core';
import type { RichText } from '../../../shared/models';
import { PROJECT_STATUSES, SPRINT_STATES, VIEW_STATES } from './enums';
import { day, enumCol, jsonLongtext, ts } from '../types/columns';
import { users } from './users';

export const projects = mysqlTable(
  'projects',
  {
    id: int('id').primaryKey().autoincrement(),
    name: varchar('name', { length: 128 }).notNull(),
    /** Display form, e.g. `WEB`. Validated as /^[A-Za-z][A-Za-z0-9]{1,9}$/ in the DTO. */
    key: varchar('key', { length: 10 }).notNull(),
    /** Uppercased mirror of `key`, so keyTaken()'s case-insensitive uniqueness is a real constraint. */
    keyUpper: varchar('keyUpper', { length: 10 }).notNull().unique(),
    description: jsonLongtext<RichText>('description'),
    status: enumCol('status', PROJECT_STATUSES).notNull(),
    viewState: enumCol('viewState', VIEW_STATES).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** Subprojects. The descendant closure is cached in ProjectTreeService. */
    parentId: int('parentId'),
    created: ts('created').notNull(),
    deletedAt: ts('deletedAt'),
  },
  (t) => [index('idx_projects_parent').on(t.parentId)],
);

/**
 * The category vocabulary of a project.
 *
 * `issues.category` stays a denormalized name string with no FK to this table — the
 * frontend matches categories by name (move() remaps by name, the Db export is by name),
 * and a composite FK could not express the `''` that the version columns legitimately
 * hold. Integrity is asserted in CategoriesService on every write, and /admin/recount
 * reports orphans.
 */
export const projectCategories = mysqlTable(
  'projectCategories',
  {
    projectId: int('projectId')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 64 }).notNull(),
    defaultHandlerId: int('defaultHandlerId').references(() => users.id, { onDelete: 'set null' }),
    sortOrder: smallint('sortOrder').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.name] }),
    index('idx_categories_order').on(t.projectId, t.sortOrder),
  ],
);

/**
 * `sortOrder` is not cosmetic: in the frontend a version's position in the array IS its
 * order, and roadmap reads it forwards while changelog reads it backwards
 * (`.filter(released).reverse()`). Normalizing without a durable order would scramble
 * both pages.
 */
export const projectVersions = mysqlTable(
  'projectVersions',
  {
    projectId: int('projectId')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 64 }).notNull(),
    date: day('date'),
    released: boolean('released').notNull().default(false),
    obsolete: boolean('obsolete').notNull().default(false),
    description: varchar('description', { length: 512 }).notNull().default(''),
    sortOrder: smallint('sortOrder').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.name] }),
    index('idx_versions_order').on(t.projectId, t.sortOrder),
  ],
);

/** A membership REPLACES the user's global level for that project — it can raise or lower it. */
export const projectMembers = mysqlTable(
  'projectMembers',
  {
    projectId: int('projectId')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: int('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessLevel: tinyint('accessLevel').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index('idx_members_user').on(t.userId),
  ],
);

export const sprints = mysqlTable(
  'sprints',
  {
    id: int('id').primaryKey().autoincrement(),
    projectId: int('projectId')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 128 }).notNull(),
    goal: varchar('goal', { length: 512 }).notNull().default(''),
    start: day('start').notNull(),
    end: day('end').notNull(),
    state: enumCol('state', SPRINT_STATES).notNull(),
    capacity: smallint('capacity').notNull().default(0),
    deletedAt: ts('deletedAt'),
  },
  (t) => [index('idx_sprints_project_state').on(t.projectId, t.state, t.start)],
);

export const projectsRelations = relations(projects, ({ one, many }) => ({
  parent: one(projects, {
    fields: [projects.parentId],
    references: [projects.id],
    relationName: 'projectHierarchy',
  }),
  children: many(projects, { relationName: 'projectHierarchy' }),
  categories: many(projectCategories),
  versions: many(projectVersions),
  members: many(projectMembers),
  sprints: many(sprints),
}));

export const projectCategoriesRelations = relations(projectCategories, ({ one }) => ({
  project: one(projects, { fields: [projectCategories.projectId], references: [projects.id] }),
  defaultHandler: one(users, {
    fields: [projectCategories.defaultHandlerId],
    references: [users.id],
  }),
}));

export const projectVersionsRelations = relations(projectVersions, ({ one }) => ({
  project: one(projects, { fields: [projectVersions.projectId], references: [projects.id] }),
}));

export const projectMembersRelations = relations(projectMembers, ({ one }) => ({
  project: one(projects, { fields: [projectMembers.projectId], references: [projects.id] }),
  user: one(users, { fields: [projectMembers.userId], references: [users.id] }),
}));

export const sprintsRelations = relations(sprints, ({ one }) => ({
  project: one(projects, { fields: [sprints.projectId], references: [projects.id] }),
}));
