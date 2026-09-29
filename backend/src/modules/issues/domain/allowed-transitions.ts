import { isResolved } from '../../../shared/config';
import type { Action, Issue, Status, WorkflowConfig } from '../../../shared/models';

/**
 * The permission answers applyPatch's callers need, resolved once and passed in, so the
 * domain never reaches for a service.
 */
export interface AbilitySnapshot {
  can(action: Action): boolean;
  meId: number;
}

/**
 * Port of allowedTransitions (issue-actions.service.ts:127-134). Three layers, in order:
 *
 *   1. the `changeStatus` threshold gates everything — fail it and the list is empty
 *   2. the workflow adjacency table says which targets exist at all
 *   3. per-target extras: `closed` needs `close`; leaving a resolved state for an
 *      unresolved one needs `reopen` OR being the issue's reporter
 */
export function allowedTransitions(
  issue: Pick<Issue, 'status' | 'reporterId'>,
  wf: WorkflowConfig,
  ability: AbilitySnapshot,
): Status[] {
  if (!ability.can('changeStatus')) return [];
  const targets = wf.transitions[issue.status] ?? [];
  return targets.filter((s) => {
    if (s === 'closed') return ability.can('close');
    if (isResolved(issue.status) && !isResolved(s)) {
      return ability.can('reopen') || issue.reporterId === ability.meId;
    }
    return true;
  });
}

/** True when `to` is reachable from the issue's current status for this actor. */
export const canTransition = (
  issue: Pick<Issue, 'status' | 'reporterId'>,
  to: Status,
  wf: WorkflowConfig,
  ability: AbilitySnapshot,
): boolean => to === issue.status || allowedTransitions(issue, wf, ability).includes(to);
