import { describe, expect, it } from 'vitest';
import { defaultWorkflow } from '../../src/shared/config';
import type { Action } from '../../src/shared/models';
import {
  allowedTransitions, canTransition, type AbilitySnapshot,
} from '../../src/modules/issues/domain/allowed-transitions';

describe('allowedTransitions', () => {
  const wf = defaultWorkflow();
  const issue = (status: Parameters<typeof allowedTransitions>[0]['status'], reporterId = 7) =>
    ({ status, reporterId });

  /** An ability that grants exactly the listed actions. */
  const grants = (actions: Action[], meId = 3): AbilitySnapshot => ({
    can: (a) => actions.includes(a),
    meId,
  });
  const all: Action[] = ['changeStatus', 'close', 'reopen'];

  it('returns nothing at all without the changeStatus threshold', () => {
    expect(allowedTransitions(issue('new'), wf, grants(['close', 'reopen']))).toEqual([]);
  });

  it('follows the workflow adjacency table', () => {
    // The default table: closed can only go back to feedback.
    expect(allowedTransitions(issue('closed'), wf, grants(all))).toEqual(['feedback']);
    expect(allowedTransitions(issue('resolved'), wf, grants(all)))
      .toEqual(['feedback', 'assigned', 'closed']);
  });

  it('hides "closed" without the close threshold', () => {
    const t = allowedTransitions(issue('new'), wf, grants(['changeStatus']));
    expect(t).not.toContain('closed');
    expect(t).toContain('assigned');
  });

  it('needs the reopen threshold to leave a resolved state', () => {
    const t = allowedTransitions(issue('resolved'), wf, grants(['changeStatus', 'close']));
    expect(t).toEqual(['closed']);
  });

  it('lets the reporter reopen even without the reopen threshold', () => {
    // The one identity-based exception in the whole transition table.
    const asReporter = grants(['changeStatus'], 7);
    expect(allowedTransitions(issue('resolved', 7), wf, asReporter)).toEqual(['feedback', 'assigned']);
    const asOther = grants(['changeStatus'], 3);
    expect(allowedTransitions(issue('resolved', 7), wf, asOther)).toEqual([]);
  });

  it('rejects resolved -> new but allows resolved -> feedback, as the frontend spec asserts', () => {
    expect(canTransition(issue('resolved'), 'new', wf, grants(all))).toBe(false);
    expect(canTransition(issue('resolved'), 'feedback', wf, grants(all))).toBe(true);
  });

  it('treats a same-status change as allowed, skipping validation', () => {
    // changeStatus(id, issue.status) is a no-op in the frontend, not a rejection.
    expect(canTransition(issue('closed'), 'closed', wf, grants([]))).toBe(true);
  });

  it('reacts immediately to a runtime threshold change', () => {
    // Thresholds are configuration, not code: an admin raising `close` must take effect at
    // once, which is why the workflow is passed in rather than imported.
    const restricted = { ...wf, transitions: { ...wf.transitions, new: ['closed' as const] } };
    expect(allowedTransitions(issue('new'), restricted, grants(['changeStatus']))).toEqual([]);
    expect(allowedTransitions(issue('new'), restricted, grants(['changeStatus', 'close']))).toEqual(['closed']);
  });
});
