import { ALL_COLUMNS } from '../../../shared/config';
import { paramsToCriteria } from '../../../shared/filter-semantics';
import type { ColumnId, FilterCriteria, SortDir, SortKey } from '../../../shared/models';

/**
 * Parses the issue-list query string.
 *
 * The criteria are decoded with the frontend's OWN paramsToCriteria(), not a reimplementation:
 * the URL shape is a contract (arrays comma-joined, `null` as the literal string, `-1` for
 * "me", `0` for unassigned, `'none'` for the backlog) and any divergence here would make
 * shared or bookmarked filter links resolve differently in the API than in the UI.
 *
 * It returns a PARTIAL: emptyCriteria()'s defaults are applied later, inside buildIssueWhere(),
 * so a bare `GET /issues` behaves like the UI's default view — closed issues hidden,
 * subprojects included.
 */
export interface ParsedIssueQuery {
  criteria: Partial<FilterCriteria>;
  sort: SortKey[];
  page: number;
  pageSize: number | undefined;
  /** Opt-in: the ordered id list the issue view needs for prev/next navigation. */
  withIds: boolean;
}

const COLUMN_SET = new Set<string>(ALL_COLUMNS);
const RESERVED = new Set(['sort', 'page', 'pageSize', 'withIds']);

/**
 * `sort=priority:desc,id:asc`.
 * Unknown columns are dropped rather than rejected, mirroring sortValue()'s `?? ''` fallback —
 * an old bookmark naming a renamed column should still return results, just ordered differently.
 */
export function parseSort(raw: string | undefined): SortKey[] {
  if (!raw) return [];
  const keys: SortKey[] = [];
  for (const part of raw.split(',')) {
    const [column, dir] = part.split(':');
    if (!column || !COLUMN_SET.has(column)) continue;
    keys.push({ column: column as ColumnId, dir: (dir === 'asc' ? 'asc' : 'desc') as SortDir });
  }
  return keys;
}

export function parseIssueQuery(query: Record<string, unknown>): ParsedIssueQuery {
  const params: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(query)) {
    if (RESERVED.has(key)) continue;
    // Fastify yields a string[] for a repeated parameter; the contract is comma-joined, so a
    // repeat is normalised to the same thing instead of silently taking the last one.
    params[key] = Array.isArray(value)
      ? value.join(',')
      : value === undefined
        ? undefined
        : String(value);
  }

  // paramsToCriteria fills in every default; keeping only the keys actually present makes the
  // result a true Partial, which is what SavedFilter stores and what buildIssueWhere expects.
  const full = paramsToCriteria(params) as unknown as Record<string, unknown>;
  const criteria: Partial<FilterCriteria> = {};
  for (const key of Object.keys(params)) {
    if (key in full) (criteria as Record<string, unknown>)[key] = full[key];
  }

  const pageSizeRaw = query['pageSize'];
  return {
    criteria,
    sort: parseSort(typeof query['sort'] === 'string' ? query['sort'] : undefined),
    page: Math.max(0, Number(query['page'] ?? 0) || 0),
    pageSize: pageSizeRaw === undefined ? undefined : Math.max(0, Number(pageSizeRaw) || 0),
    withIds: query['withIds'] === 'true' || query['withIds'] === '1',
  };
}
