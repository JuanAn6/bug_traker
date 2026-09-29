import {
  PRIORITIES, REPRODUCIBILITY, RESOLUTIONS, SEVERITIES, STATUSES,
} from '../../../shared/config';
import type { Issue, Priority, Reproducibility, Resolution, Severity, Status } from '../../../shared/models';

/**
 * The enum → canonical-index mapping that the *Rank columns store.
 *
 * sortValue() in the frontend orders these five columns by their position in the arrays
 * above, not alphabetically ('urgent' must outrank 'normal'), and `hideStatus` is a rank
 * THRESHOLD rather than an equality. Neither is expressible against a MySQL ENUM through
 * the query builder, so the index is materialized as a column.
 *
 * Written here and nowhere else, always in the same statement as the enum itself.
 */
export const ranks = {
  status: (v: Status) => STATUSES.indexOf(v),
  resolution: (v: Resolution) => RESOLUTIONS.indexOf(v),
  priority: (v: Priority) => PRIORITIES.indexOf(v),
  severity: (v: Severity) => SEVERITIES.indexOf(v),
  reproducibility: (v: Reproducibility) => REPRODUCIBILITY.indexOf(v),
} as const;

export interface RankColumns {
  statusRank: number;
  resolutionRank: number;
  priorityRank: number;
  severityRank: number;
  reproducibilityRank: number;
}

/** Derives all five rank columns from an issue's enum values. */
export const rankColumns = (
  i: Pick<Issue, 'status' | 'resolution' | 'priority' | 'severity' | 'reproducibility'>,
): RankColumns => ({
  statusRank: ranks.status(i.status),
  resolutionRank: ranks.resolution(i.resolution),
  priorityRank: ranks.priority(i.priority),
  severityRank: ranks.severity(i.severity),
  reproducibilityRank: ranks.reproducibility(i.reproducibility),
});
