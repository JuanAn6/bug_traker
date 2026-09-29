import { isResolved, statusRank } from '../../../shared/config';
import type {
  HistoryType, Issue, NotifyEvent, RichText, Status, WorkflowConfig,
} from '../../../shared/models';
import { mentionedUserIds } from '../../../shared/rich';
import { rankColumns, type RankColumns } from './rank';
import { RICH, str, TRACKED } from './tracked-fields';

/**
 * Resolution bookkeeping the frontend derives by scanning history (`resolvedDates()`), kept
 * as columns here so burndown, MTTR and the 12-week trend are cheap and cannot drift.
 */
export interface ResolutionMarks {
  resolvedAt: Date | null;
  /** Never cleared once set — MTTR and "was ever resolved" still need it after a reopen. */
  firstResolvedAt: Date | null;
  reopenedAt: Date | null;
  reopenCount: number;
  /** True when the importer inferred resolvedAt instead of observing the transition. */
  resolvedAtEstimated: boolean;
}

/** What the domain operates on: the frontend's Issue shape plus the resolution marks. */
export type IssueAggregate = Issue & ResolutionMarks;

export interface HistoryDraft {
  type: HistoryType;
  field: string;
  old: string;
  new: string;
}

/**
 * Recipients are *candidates*. The application layer narrows them with a single SQL query
 * that applies `user.enabled`, `prefs.notify[type]` and — unlike the frontend — whether the
 * recipient can actually see the issue.
 */
export interface NotificationDraft {
  type: NotifyEvent;
  recipients: number[];
  subject: string;
  excerpt?: string;
  excerptPrivate?: boolean;
  fromStatus?: Status;
  toStatus?: Status;
}

export interface PatchResult {
  changed: boolean;
  next: IssueAggregate & RankColumns;
  history: HistoryDraft[];
  /** Handler auto-subscribed to the issue, to be inserted into issueMonitors. */
  monitorsToAdd: number[];
  notifications: NotificationDraft[];
  /** True when summary, a rich field or the tags changed, so searchNorm must be rebuilt. */
  searchDirty: boolean;
}

export interface PatchContext {
  actorId: number;
  now: Date;
}

const mentionsIn = (issue: Issue): number[] =>
  RICH.flatMap((f) => mentionedUserIds(issue[f] as RichText));

/** monitors ∪ reporter ∪ handler — port of `watchers()`. A null handler drops out. */
export const watchers = (i: Issue): number[] => [
  ...i.monitorIds,
  i.reporterId,
  ...(i.handlerId ? [i.handlerId] : []),
];

/**
 * Port of applyPatch (issue-actions.service.ts:80-113). Pure: no I/O, no clock of its own,
 * no framework. Every field write in the system funnels through here, which is what makes
 * the automations impossible to bypass.
 *
 * The step order is load-bearing and asserted by the ported tests:
 *   1. auto-assign status when a handler arrives
 *   2. auto-resolution when the resolved boundary is crossed
 *   3. diff over TRACKED, in TRACKED's own order
 *   4. bail out unchanged if nothing tracked moved
 *   5. auto-monitor the new handler, notify assigned + status
 *   6. stamp `updated` once
 */
export function applyPatch(
  issue: IssueAggregate,
  patch: Partial<Issue>,
  wf: WorkflowConfig,
  ctx: PatchContext,
): PatchResult {
  const next: IssueAggregate = { ...issue, ...patch };

  // 1. A new, non-null handler on a pre-'assigned' status moves the issue to 'assigned' —
  // but only when the patch does not set `status` itself. Clearing the handler never does.
  if (
    patch.handlerId !== undefined &&
    patch.handlerId &&
    patch.handlerId !== issue.handlerId &&
    wf.autoAssignStatus &&
    patch.status === undefined &&
    statusRank(issue.status) < statusRank('assigned')
  ) {
    next.status = 'assigned';
  }

  // 2. Crossing into resolved with an untouched resolution settles it as 'fixed'; crossing
  // back out without an explicit resolution marks it 'reopened'.
  if (next.status !== issue.status) {
    if (
      isResolved(next.status) &&
      !isResolved(issue.status) &&
      (next.resolution === 'open' || next.resolution === 'reopened')
    ) {
      next.resolution = 'fixed';
    }
    if (!isResolved(next.status) && isResolved(issue.status) && patch.resolution === undefined) {
      next.resolution = 'reopened';
    }
  }

  // 3. One history row per changed tracked field, walked in TRACKED order so the log reads
  // the same way regardless of how the caller ordered the patch.
  const history: HistoryDraft[] = [];
  for (const f of TRACKED) {
    const before = issue[f];
    const after = next[f];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    history.push({ type: 'field', field: f, old: str(before), new: str(after) });
  }

  // 4. A patch that moves only untracked fields (tags, monitors, customFields) is a no-op
  // here: no `updated` bump, no notifications. Those paths write their own history.
  if (history.length === 0) {
    return {
      changed: false,
      next: { ...issue, ...rankColumns(issue) },
      history: [],
      monitorsToAdd: [],
      notifications: [],
      searchDirty: false,
    };
  }

  // 5. Auto-monitor the handler and announce the two things watchers care about.
  const monitorsToAdd: number[] = [];
  const notifications: NotificationDraft[] = [];

  if (next.handlerId && next.handlerId !== issue.handlerId) {
    if (!next.monitorIds.includes(next.handlerId)) {
      next.monitorIds = [...next.monitorIds, next.handlerId];
      monitorsToAdd.push(next.handlerId);
    }
    notifications.push({ type: 'assigned', recipients: [next.handlerId], subject: next.summary });
  }

  if (next.status !== issue.status) {
    notifications.push({
      type: 'status',
      recipients: watchers(next),
      subject: next.summary,
      fromStatus: issue.status,
      toStatus: next.status,
    });
  }

  // Only mentions that were not already there produce a notification.
  const before = new Set(mentionsIn(issue));
  const added = mentionsIn(next).filter((id) => !before.has(id));
  if (added.length) {
    notifications.push({ type: 'mentioned', recipients: added, subject: next.summary });
  }

  // 6. Resolution marks and the single `updated` stamp.
  applyResolutionMarks(issue, next, ctx.now);
  next.updated = ctx.now.toISOString();

  const searchDirty = history.some(
    (h) => h.field === 'summary' || (RICH as readonly string[]).includes(h.field),
  );

  return {
    changed: true,
    next: { ...next, ...rankColumns(next) },
    history,
    monitorsToAdd,
    notifications,
    searchDirty,
  };
}

/**
 * Maintains resolvedAt / firstResolvedAt / reopenedAt / reopenCount as the issue crosses
 * the resolved boundary. This is the denormalization that replaces resolvedDates()'s scan
 * of `field='status'` history rows — and it fixes that function's habit of falling back to
 * `issue.updated`, which let any later edit silently move an issue's "resolved" date.
 */
function applyResolutionMarks(before: IssueAggregate, next: IssueAggregate, now: Date): void {
  const wasResolved = isResolved(before.status);
  const isNowResolved = isResolved(next.status);
  if (wasResolved === isNowResolved) return;

  if (isNowResolved) {
    next.resolvedAt = now;
    next.firstResolvedAt = before.firstResolvedAt ?? now;
    next.resolvedAtEstimated = false;
  } else {
    next.resolvedAt = null;
    next.reopenedAt = now;
    next.reopenCount = before.reopenCount + 1;
  }
}
