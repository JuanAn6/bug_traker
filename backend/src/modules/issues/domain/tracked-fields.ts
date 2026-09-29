import type { Issue } from '../../../shared/models';
import { plainText } from '../../../shared/rich';
import type { RichText } from '../../../shared/models';

/**
 * The fields whose changes produce a `field` history row, IN THE ORDER THEY ARE LOGGED.
 *
 * Copied from issue-actions.service.ts:17-21. The order is asserted by a ported test: a
 * patch of `{ priority, summary }` must log summary first, because the diff walks this
 * array rather than the patch's own keys.
 *
 * Deliberately absent (each has its own history type or none at all): `tags`
 * (tag_added/tag_removed), `monitorIds` (monitor_added/monitor_removed), `relationships`
 * (relationship_added/relationship_deleted), and `customFields` — which produces no history
 * at all in the frontend, a parity gap kept on purpose.
 */
export const TRACKED: readonly (keyof Issue)[] = [
  'projectId', 'sprintId', 'category', 'summary', 'status', 'resolution', 'priority', 'severity',
  'reproducibility', 'platform', 'os', 'osBuild', 'productVersion', 'targetVersion',
  'fixedInVersion', 'reporterId', 'handlerId', 'viewState', 'sticky', 'dueDate', 'estimate',
  'storyPoints', 'description', 'stepsToReproduce', 'additionalInfo',
];

/** The three rich-text fields, scanned for @mentions and logged as plain-text excerpts. */
export const RICH: readonly (keyof Issue)[] = ['description', 'stepsToReproduce', 'additionalInfo'];

/**
 * How a value becomes a history string. Port of `str()` in issue-actions.service.ts:34:
 * null/undefined → '', objects → a 120-character plain-text excerpt, everything else → String().
 * So history holds "true", "3", and '' for a cleared handler.
 */
export const str = (v: unknown): string =>
  v === null || v === undefined
    ? ''
    : typeof v === 'object'
      ? plainText(v as RichText).slice(0, 120)
      : String(v);
