import { relations, sql } from 'drizzle-orm';
import {
  boolean, check, float, index, int, longtext, mysqlTable, primaryKey, smallint, tinyint, varchar,
} from 'drizzle-orm/mysql-core';
import type { RichText } from '../../../shared/models';
import {
  PRIORITIES, RELATIONSHIPS, REPRODUCIBILITY, RESOLUTIONS, SEVERITIES, STATUSES, VIEW_STATES,
} from './enums';
import { day, enumCol, jsonLongtext, ts } from '../types/columns';
import { customFields } from './custom-fields';
import { projects, sprints } from './projects';
import { users } from './users';

export const issues = mysqlTable(
  'issues',
  {
    id: int('id').primaryKey().autoincrement(),
    projectId: int('projectId')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    sprintId: int('sprintId').references(() => sprints.id, { onDelete: 'set null' }),
    /** Name, not an FK — see the note on projectCategories. */
    category: varchar('category', { length: 64 }).notNull().default(''),
    summary: varchar('summary', { length: 255 }).notNull(),

    description: jsonLongtext<RichText>('description'),
    stepsToReproduce: jsonLongtext<RichText>('stepsToReproduce'),
    additionalInfo: jsonLongtext<RichText>('additionalInfo'),

    // Each enum is paired with its canonical-array index. The ranks exist because
    // `hideStatus` needs `<` rather than `IN`, and because sortValue() orders enums by
    // index, not alphabetically. Written by domain/rank.ts in the same statement.
    status: enumCol('status', STATUSES).notNull(),
    statusRank: tinyint('statusRank').notNull(),
    resolution: enumCol('resolution', RESOLUTIONS).notNull(),
    resolutionRank: tinyint('resolutionRank').notNull(),
    priority: enumCol('priority', PRIORITIES).notNull(),
    priorityRank: tinyint('priorityRank').notNull(),
    severity: enumCol('severity', SEVERITIES).notNull(),
    severityRank: tinyint('severityRank').notNull(),
    reproducibility: enumCol('reproducibility', REPRODUCIBILITY).notNull(),
    reproducibilityRank: tinyint('reproducibilityRank').notNull(),

    platform: varchar('platform', { length: 64 }).notNull().default(''),
    os: varchar('os', { length: 64 }).notNull().default(''),
    osBuild: varchar('osBuild', { length: 64 }).notNull().default(''),
    /** '' means "none" — which is why these are not FKs to projectVersions. */
    productVersion: varchar('productVersion', { length: 64 }).notNull().default(''),
    targetVersion: varchar('targetVersion', { length: 64 }).notNull().default(''),
    fixedInVersion: varchar('fixedInVersion', { length: 64 }).notNull().default(''),

    reporterId: int('reporterId')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    handlerId: int('handlerId').references(() => users.id, { onDelete: 'set null' }),
    viewState: enumCol('viewState', VIEW_STATES).notNull().default('public'),
    /** Floats to the top of every sort, above the user's own sort keys. */
    sticky: boolean('sticky').notNull().default(false),

    dueDate: day('dueDate'),
    estimate: float('estimate'),
    storyPoints: smallint('storyPoints'),

    created: ts('created').notNull(),
    updated: ts('updated').notNull(),

    // ── denormalized, all maintained inside the same transaction as the write ──
    /**
     * norm(summary + plainText of the three rich fields + tags), i.e. byte-identical to
     * the haystack issue-filter.ts builds. Stored already normalized (NFD-stripped,
     * lowercased) so accent-insensitivity is a property of the data rather than a hope
     * about how InnoDB's FULLTEXT tokenizer handles diacritics.
     */
    searchNorm: longtext('searchNorm').notNull(),
    /** tags joined by ',' in insertion order — only so `ORDER BY tags` can match the UI. */
    tagsSorted: varchar('tagsSorted', { length: 255 }).notNull().default(''),
    noteCount: smallint('noteCount').notNull().default(0),
    /** Counts only current, non-pending attachments — what `hasAttachments` filters on. */
    attachmentCount: smallint('attachmentCount').notNull().default(0),
    /** Drives /summary's `mostActive`, which ranks by history-row count. */
    historyCount: smallint('historyCount').notNull().default(0),

    /** Replaces resolvedDates()'s full history scan. NULL while unresolved. */
    resolvedAt: ts('resolvedAt'),
    /** Never cleared once set: MTTR and "was ever resolved" need it after a reopen. */
    firstResolvedAt: ts('firstResolvedAt'),
    reopenedAt: ts('reopenedAt'),
    reopenCount: smallint('reopenCount').notNull().default(0),
    /** True when resolvedAt was inferred by the importer instead of observed. */
    resolvedAtEstimated: boolean('resolvedAtEstimated').notNull().default(false),

    deletedAt: ts('deletedAt'),
    /** Optimistic concurrency: a stale read-modify-write loses instead of clobbering. */
    rowVersion: int('rowVersion').notNull().default(0),
  },
  (t) => [
    index('idx_issues_list').on(t.projectId, t.statusRank, t.priorityRank),
    index('idx_issues_sprint').on(t.projectId, t.sprintId),
    index('idx_issues_handler').on(t.handlerId, t.statusRank),
    index('idx_issues_reporter').on(t.reporterId, t.statusRank),
    index('idx_issues_updated').on(t.projectId, t.updated),
    index('idx_issues_sticky').on(t.sticky, t.updated),
    index('idx_issues_due').on(t.dueDate, t.statusRank),
    index('idx_issues_target').on(t.projectId, t.targetVersion),
    index('idx_issues_fixed').on(t.projectId, t.fixedInVersion),
    index('idx_issues_category').on(t.projectId, t.category),
    index('idx_issues_view').on(t.viewState),
    index('idx_issues_deleted').on(t.deletedAt),
    // FULLTEXT(searchNorm) is added by hand in the migration: the DSL cannot express it.
  ],
);

export const issueTags = mysqlTable(
  'issueTags',
  {
    issueId: int('issueId')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    /** Already normalized on write: trim().toLowerCase().replace(/\s+/g, '-'). */
    tag: varchar('tag', { length: 64 }).notNull(),
    sortOrder: smallint('sortOrder').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.tag] }),
    index('idx_issuetags_tag').on(t.tag),
  ],
);

export const issueMonitors = mysqlTable(
  'issueMonitors',
  {
    issueId: int('issueId')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    userId: int('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.userId] }),
    index('idx_monitors_user').on(t.userId),
  ],
);

/**
 * Two symmetric rows per link, mirroring Issue.relationships on both issues.
 *
 * The composite primary key does double duty: it is the index for one-sided lookups AND it
 * enforces the frontend's "at most one relationship per issue pair" rule — a second link
 * of any type between the same pair fails with ER_DUP_ENTRY, which maps to
 * 409 errors.relationExists. Symmetry itself is written in one transaction and audited by
 * scripts/check-integrity.ts.
 */
export const issueRelationships = mysqlTable(
  'issueRelationships',
  {
    issueId: int('issueId')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    otherIssueId: int('otherIssueId')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    type: enumCol('type', RELATIONSHIPS).notNull(),
    created: ts('created').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.otherIssueId] }),
    index('idx_rel_other').on(t.otherIssueId),
    check('chk_rel_no_self', sql`${t.issueId} <> ${t.otherIssueId}`),
  ],
);

/** Every value is a string regardless of the declared CustomFieldType ('1'/'' for checkbox). */
export const issueCustomValues = mysqlTable(
  'issueCustomValues',
  {
    issueId: int('issueId')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    customFieldId: int('customFieldId')
      .notNull()
      .references(() => customFields.id, { onDelete: 'cascade' }),
    value: varchar('value', { length: 1024 }).notNull().default(''),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.customFieldId] }),
    index('idx_customvalues_field').on(t.customFieldId),
  ],
);

export const issuesRelations = relations(issues, ({ one, many }) => ({
  project: one(projects, { fields: [issues.projectId], references: [projects.id] }),
  sprint: one(sprints, { fields: [issues.sprintId], references: [sprints.id] }),
  reporter: one(users, { fields: [issues.reporterId], references: [users.id], relationName: 'reportedIssues' }),
  handler: one(users, { fields: [issues.handlerId], references: [users.id], relationName: 'handledIssues' }),
  tags: many(issueTags),
  monitors: many(issueMonitors),
  relationships: many(issueRelationships, { relationName: 'relationshipsFrom' }),
  customValues: many(issueCustomValues),
}));

export const issueTagsRelations = relations(issueTags, ({ one }) => ({
  issue: one(issues, { fields: [issueTags.issueId], references: [issues.id] }),
}));

export const issueMonitorsRelations = relations(issueMonitors, ({ one }) => ({
  issue: one(issues, { fields: [issueMonitors.issueId], references: [issues.id] }),
  user: one(users, { fields: [issueMonitors.userId], references: [users.id] }),
}));

export const issueRelationshipsRelations = relations(issueRelationships, ({ one }) => ({
  issue: one(issues, {
    fields: [issueRelationships.issueId],
    references: [issues.id],
    relationName: 'relationshipsFrom',
  }),
  other: one(issues, {
    fields: [issueRelationships.otherIssueId],
    references: [issues.id],
    relationName: 'relationshipsTo',
  }),
}));

export const issueCustomValuesRelations = relations(issueCustomValues, ({ one }) => ({
  issue: one(issues, { fields: [issueCustomValues.issueId], references: [issues.id] }),
  customField: one(customFields, {
    fields: [issueCustomValues.customFieldId],
    references: [customFields.id],
  }),
}));
