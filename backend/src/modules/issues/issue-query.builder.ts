import {
  and, asc, desc, eq, exists, gte, inArray, isNotNull, isNull, like, lt, lte, ne, or, sql,
  type SQL,
} from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/mysql-core';
import { emptyCriteria, STATUSES } from '../../shared/config';
import type { ColumnId, FilterCriteria, SortKey } from '../../shared/models';
import { issueIdShortcut, searchWords } from '../../shared/norm';
import * as s from '../../core/database/schema';

/** A standalone builder, so EXISTS subqueries need no database connection. */
const qb = new QueryBuilder();

/**
 * Which projects this actor may see, and where they may see private issues.
 * Computed once per request by VisibilityService and folded into every query.
 */
export interface VisibilityScope {
  visibleProjectIds: number[];
  privateIssueProjectIds: number[];
  isAdmin: boolean;
}

export interface QueryContext {
  meId: number;
  /** Injected so tests can pin "today" for overdueOnly. */
  now: Date;
  /** Omit only in tests that isolate the filter translation from access control. */
  scope?: VisibilityScope;
}

const utcDay = (d: Date): string => d.toISOString().slice(0, 10);
/** Half-open upper bound: `<= to` on a date means `< to + 1 day` on an instant. */
const nextDay = (isoDate: string): Date => {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
};
const startOfDay = (isoDate: string): Date => new Date(`${isoDate}T00:00:00.000Z`);

/** LIKE with the wildcards escaped, so a summary containing '%' cannot widen the match. */
const contains = (column: SQL | Parameters<typeof like>[0], value: string) =>
  like(column, `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);

/**
 * Translates a FilterCriteria into a single WHERE condition.
 *
 * The defaults matter as much as the fields: filterIssues() starts from
 * `{ ...emptyCriteria(), ...partial }`, so a bare GET /issues must hide closed issues
 * (`hideStatus: 'closed'`) and include subprojects. Skipping that merge is the easiest way
 * to make this endpoint quietly disagree with the UI.
 *
 * `descendantIds` is resolved by the caller (ProjectTreeService) because the parent map is
 * cached there and reused by /roadmap, /summary and the navigator counts.
 */
export function buildIssueWhere(
  partial: Partial<FilterCriteria>,
  ctx: QueryContext,
  descendantIds: (ids: number[]) => number[],
): SQL {
  const c = { ...emptyCriteria(), ...partial };
  const today = utcDay(ctx.now);
  const parts: (SQL | undefined)[] = [isNull(s.issues.deletedAt)];

  // ── access control, never optional in production ──────────────────────────
  if (ctx.scope) {
    parts.push(inArray(s.issues.projectId, nonEmpty(ctx.scope.visibleProjectIds)));
    if (!ctx.scope.isAdmin) {
      parts.push(
        or(
          eq(s.issues.viewState, 'public'),
          eq(s.issues.reporterId, ctx.meId),
          eq(s.issues.handlerId, ctx.meId),
          inArray(s.issues.projectId, nonEmpty(ctx.scope.privateIssueProjectIds)),
        ),
      );
    }
  }

  // ── project scope ─────────────────────────────────────────────────────────
  if (c.projectIds.length) {
    const ids = c.includeSubprojects ? descendantIds(c.projectIds) : c.projectIds;
    parts.push(inArray(s.issues.projectId, nonEmpty(ids)));
  }

  // 'none' is the sentinel for the backlog.
  if (c.sprintIds.length) {
    const numeric = c.sprintIds.filter((x): x is number => x !== 'none');
    const backlog = c.sprintIds.includes('none');
    parts.push(
      backlog
        ? (numeric.length
            ? or(inArray(s.issues.sprintId, numeric), isNull(s.issues.sprintId))
            : isNull(s.issues.sprintId))
        : inArray(s.issues.sprintId, nonEmpty(numeric)),
    );
  }

  if (c.categories.length) parts.push(inArray(s.issues.category, c.categories));

  // ── status, and the rank threshold that hides the tail ────────────────────
  if (c.statuses.length) {
    parts.push(inArray(s.issues.status, c.statuses));
  } else if (c.hideStatus) {
    // A THRESHOLD, not an equality: hideStatus:'closed' hides closed, and 'resolved' would
    // hide resolved AND closed. Suppressed entirely when `statuses` is given.
    parts.push(lt(s.issues.statusRank, STATUSES.indexOf(c.hideStatus)));
  }

  if (c.resolutions.length) parts.push(inArray(s.issues.resolution, c.resolutions));
  if (c.priorities.length) parts.push(inArray(s.issues.priority, c.priorities));
  if (c.severities.length) parts.push(inArray(s.issues.severity, c.severities));
  if (c.reproducibility.length) parts.push(inArray(s.issues.reproducibility, c.reproducibility));

  // ── people, with the -1 / 0 sentinels ─────────────────────────────────────
  if (c.reporterIds.length) {
    parts.push(inArray(s.issues.reporterId, resolveMe(c.reporterIds, ctx.meId)));
  }
  if (c.handlerIds.length) {
    // -1 means "me"; 0 means "unassigned", because the frontend compares `handlerId ?? 0`.
    const ids = resolveMe(c.handlerIds, ctx.meId).filter((id) => id !== 0);
    const unassigned = c.handlerIds.includes(0);
    parts.push(
      unassigned
        ? (ids.length
            ? or(inArray(s.issues.handlerId, ids), isNull(s.issues.handlerId))
            : isNull(s.issues.handlerId))
        : inArray(s.issues.handlerId, nonEmpty(ids)),
    );
  }
  // `if (monitor && ...)` in the frontend: a literal 0 is ignored, not treated as a user.
  const monitor = c.monitorId === -1 ? ctx.meId : c.monitorId;
  if (monitor) {
    parts.push(
      exists(
        qb.select({ n: sql`1` }).from(s.issueMonitors)
          .where(and(eq(s.issueMonitors.issueId, s.issues.id), eq(s.issueMonitors.userId, monitor))),
      ),
    );
  }

  // ── tags: any = OR, all = one EXISTS per tag ───────────────────────────────
  if (c.tags.length) {
    const hasTag = (tag: string) =>
      exists(
        qb.select({ n: sql`1` }).from(s.issueTags)
          .where(and(eq(s.issueTags.issueId, s.issues.id), eq(s.issueTags.tag, tag))),
      );
    parts.push(
      c.tagsMode === 'all'
        ? and(...c.tags.map(hasTag))
        : exists(
            qb.select({ n: sql`1` }).from(s.issueTags)
              .where(and(eq(s.issueTags.issueId, s.issues.id), inArray(s.issueTags.tag, c.tags))),
          ),
    );
  }

  // ── versions, platform, visibility ────────────────────────────────────────
  if (c.targetVersion) parts.push(eq(s.issues.targetVersion, c.targetVersion));
  if (c.fixedInVersion) parts.push(eq(s.issues.fixedInVersion, c.fixedInVersion));
  // Substring, case- and accent-insensitive via the utf8mb4_unicode_ci collation — which is
  // what norm() buys the frontend for free.
  if (c.platform) parts.push(contains(s.issues.platform, c.platform));
  if (c.os) parts.push(contains(s.issues.os, c.os));
  if (c.viewState) parts.push(eq(s.issues.viewState, c.viewState));

  // ── dates, all in UTC because the frontend slices toISOString() ────────────
  if (c.createdFrom) parts.push(gte(s.issues.created, startOfDay(c.createdFrom)));
  if (c.createdTo) parts.push(lt(s.issues.created, nextDay(c.createdTo)));
  if (c.updatedFrom) parts.push(gte(s.issues.updated, startOfDay(c.updatedFrom)));
  if (c.updatedTo) parts.push(lt(s.issues.updated, nextDay(c.updatedTo)));
  // Guarded as a pair: a null dueDate only excludes when a bound was actually given.
  if (c.dueFrom) parts.push(gte(s.issues.dueDate, c.dueFrom));
  if (c.dueTo) parts.push(lte(s.issues.dueDate, c.dueTo));

  if (c.overdueOnly) {
    parts.push(
      and(
        isNotNull(s.issues.dueDate),
        lt(s.issues.dueDate, today),
        lt(s.issues.statusRank, STATUSES.indexOf('resolved')),
      ),
    );
  }

  // Tri-state, answered from the denormalized counter (current && issueId != 0).
  if (c.hasAttachments !== null) {
    parts.push(c.hasAttachments ? sql`${s.issues.attachmentCount} > 0` : eq(s.issues.attachmentCount, 0));
  }

  if (c.relationship) {
    parts.push(
      exists(
        qb.select({ n: sql`1` }).from(s.issueRelationships)
          .where(and(
            eq(s.issueRelationships.issueId, s.issues.id),
            eq(s.issueRelationships.type, c.relationship),
          )),
      ),
    );
  }

  if (c.customFieldId !== null) {
    // Without a value the test is "the field is set to something non-empty" — the frontend's
    // `!v` rejects both a missing key and ''.
    const valueCond = c.customFieldValue
      ? contains(s.issueCustomValues.value, c.customFieldValue)
      : ne(s.issueCustomValues.value, '');
    parts.push(
      exists(
        qb.select({ n: sql`1` }).from(s.issueCustomValues)
          .where(and(
            eq(s.issueCustomValues.issueId, s.issues.id),
            eq(s.issueCustomValues.customFieldId, c.customFieldId),
            valueCond,
          )),
      ),
    );
  }

  // ── free text ─────────────────────────────────────────────────────────────
  if (c.text.trim()) {
    const shortcut = issueIdShortcut(c.text);
    if (shortcut !== null) {
      // #123 and KEY-123 short-circuit to an exact id and ignore every other text rule.
      parts.push(eq(s.issues.id, shortcut));
    } else {
      for (const word of searchWords(c.text)) {
        const inIssue = contains(s.issues.searchNorm, word);
        parts.push(
          c.searchNotes
            ? or(inIssue, exists(
                qb.select({ n: sql`1` }).from(s.comments)
                  .where(and(
                    eq(s.comments.issueId, s.issues.id),
                    isNull(s.comments.deletedAt),
                    contains(s.comments.bodyNorm, word),
                    // Visibility of note text, which filterIssues() does NOT apply: its
                    // noteText map is built from every comment, so a private note is
                    // searchable by anyone. The backend must not reproduce that.
                    noteVisibility(ctx),
                  )),
              ))
            : inIssue,
        );
      }
    }
  }

  return and(...parts.filter((p): p is SQL => p !== undefined))!;
}

/** A note is searchable when it is public, yours, or you can see private notes here. */
function noteVisibility(ctx: QueryContext): SQL | undefined {
  if (!ctx.scope) return undefined;
  if (ctx.scope.isAdmin) return undefined;
  return or(
    eq(s.comments.private, false),
    eq(s.comments.authorId, ctx.meId),
    inArray(s.issues.projectId, nonEmpty(ctx.scope.privateIssueProjectIds)),
  );
}

const resolveMe = (ids: number[], meId: number): number[] =>
  [...new Set(ids.map((id) => (id === -1 ? meId : id)))];

/** `IN ()` is a syntax error; an empty set must match nothing instead. */
const nonEmpty = (ids: number[]): number[] => (ids.length ? ids : [-1]);

/** Columns that sort by their canonical rank rather than their string value. */
const RANK_COLUMN = {
  status: s.issues.statusRank,
  priority: s.issues.priorityRank,
  severity: s.issues.severityRank,
  resolution: s.issues.resolutionRank,
  reproducibility: s.issues.reproducibilityRank,
} as const;

const SCALAR_COLUMN = {
  id: s.issues.id,
  summary: s.issues.summary,
  category: s.issues.category,
  created: s.issues.created,
  updated: s.issues.updated,
  targetVersion: s.issues.targetVersion,
  fixedInVersion: s.issues.fixedInVersion,
  viewState: s.issues.viewState,
  tags: s.issues.tagsSorted,
  storyPoints: s.issues.storyPoints,
  dueDate: s.issues.dueDate,
  notes: s.issues.noteCount,
  attachments: s.issues.attachmentCount,
} as const;

/**
 * Builds the ORDER BY.
 *
 * Three invariants from sortIssues(): sticky floats to the top ABOVE the user's keys and is
 * never inverted by their direction; the default is `updated DESC`; and the final tiebreak
 * is `id DESC`.
 *
 * Nulls need explicit handling because MariaDB sorts them first ascending, while the
 * frontend maps `dueDate` to '9999' (always last) and `storyPoints` to -1 (always first).
 */
export function buildIssueOrderBy(keys: SortKey[]): SQL[] {
  const out: SQL[] = [sql`${s.issues.sticky} DESC`];
  const effective: SortKey[] = keys.length ? keys : [{ column: 'updated', dir: 'desc' }];

  for (const key of effective) {
    const dir = key.dir === 'asc' ? sql`ASC` : sql`DESC`;

    // sortValue() substitutes a sentinel for null rather than asking for "nulls last", so
    // the direction flips where the nulls land. COALESCE reproduces that exactly, while a
    // separate `IS NULL` key would pin them to one end in both directions.
    if (key.column === 'dueDate') {
      // '9999' is the LARGEST value, so nulls sort last ascending and FIRST descending.
      out.push(sql`COALESCE(${s.issues.dueDate}, '9999-12-31') ${dir}`);
      continue;
    }
    if (key.column === 'storyPoints') {
      // -1 is the smallest, so unpointed issues sort first ascending and last descending.
      out.push(sql`COALESCE(${s.issues.storyPoints}, -1) ${dir}`);
      continue;
    }
    const rank = RANK_COLUMN[key.column as keyof typeof RANK_COLUMN];
    if (rank) {
      out.push(sql`${rank} ${dir}`);
      continue;
    }
    const scalar = SCALAR_COLUMN[key.column as keyof typeof SCALAR_COLUMN];
    if (scalar) {
      out.push(sql`${scalar} ${dir}`);
      continue;
    }
    // project / reporter / handler / sprint resolve through joined names; the caller adds
    // the joins and passes the alias in. Unknown columns are ignored rather than throwing,
    // matching sortValue()'s `?? ''` fallback.
  }

  out.push(sql`${s.issues.id} DESC`);
  return out;
}

/** Sort columns that need a join before buildIssueOrderBy can order by them. */
export const JOINED_SORT_COLUMNS: readonly ColumnId[] = ['project', 'reporter', 'handler', 'sprint'];
