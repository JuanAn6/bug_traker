import { relations } from 'drizzle-orm';
import { boolean, int, mysqlTable, primaryKey, smallint, varchar } from 'drizzle-orm/mysql-core';
import { CUSTOM_FIELD_TYPES } from './enums';
import { enumCol } from '../types/columns';
import { projects } from './projects';

export const customFields = mysqlTable('customFields', {
  id: int('id').primaryKey().autoincrement(),
  name: varchar('name', { length: 64 }).notNull(),
  type: enumCol('type', CUSTOM_FIELD_TYPES).notNull(),
  /** Newline-joined, ordered. Only meaningful for type 'list'. */
  options: varchar('options', { length: 1024 }).notNull().default(''),
  required: boolean('required').notNull().default(false),
  defaultValue: varchar('defaultValue', { length: 255 }).notNull().default(''),
});

/** Which projects expose which custom fields (Project.customFieldIds). */
export const projectCustomFields = mysqlTable(
  'projectCustomFields',
  {
    projectId: int('projectId')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    customFieldId: int('customFieldId')
      .notNull()
      .references(() => customFields.id, { onDelete: 'cascade' }),
    sortOrder: smallint('sortOrder').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.customFieldId] })],
);

export const customFieldsRelations = relations(customFields, ({ many }) => ({
  projects: many(projectCustomFields),
}));

export const projectCustomFieldsRelations = relations(projectCustomFields, ({ one }) => ({
  project: one(projects, { fields: [projectCustomFields.projectId], references: [projects.id] }),
  customField: one(customFields, {
    fields: [projectCustomFields.customFieldId],
    references: [customFields.id],
  }),
}));
