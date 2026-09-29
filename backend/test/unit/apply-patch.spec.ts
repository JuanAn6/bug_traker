import { beforeEach, describe, expect, it } from 'vitest';
import { defaultWorkflow } from '../../src/shared/config';
import type { Issue, WorkflowConfig } from '../../src/shared/models';
import { doc } from '../../src/shared/rich';
import { applyPatch, type IssueAggregate } from '../../src/modules/issues/domain/apply-patch';

/**
 * Ports the expectations of frontend/src/app/core/issue-actions.spec.ts onto the pure
 * domain function. These are the invariants the whole write path rests on, so they are
 * asserted here with no database in the way.
 */
describe('applyPatch', () => {
  const NOW = new Date('2026-09-29T12:00:00.000Z');
  const EARLIER = '2026-09-01T08:00:00.000Z';
  let wf: WorkflowConfig;

  const issue = (patch: Partial<IssueAggregate> = {}): IssueAggregate => ({
    id: 1, projectId: 1, sprintId: null, category: 'Backend API', summary: 'Test issue',
    description: doc('x'), stepsToReproduce: null, additionalInfo: null,
    status: 'new', resolution: 'open', priority: 'normal', severity: 'minor',
    reproducibility: 'always', platform: '', os: '', osBuild: '', productVersion: '',
    targetVersion: '', fixedInVersion: '', reporterId: 7, handlerId: null,
    viewState: 'public', sticky: false, tags: [], monitorIds: [7], relationships: [],
    dueDate: null, estimate: null, storyPoints: null, customFields: {},
    created: EARLIER, updated: EARLIER,
    resolvedAt: null, firstResolvedAt: null, reopenedAt: null, reopenCount: 0,
    resolvedAtEstimated: false,
    ...patch,
  });
  const ctx = { actorId: 3, now: NOW };
  const rows = (r: ReturnType<typeof applyPatch>) =>
    r.history.map((h) => [h.field, h.old, h.new]);

  beforeEach(() => {
    wf = defaultWorkflow();
  });

  it('writes one history row per changed field, in TRACKED order and not patch order', () => {
    // The patch lists priority first; the log must still put summary first, because the
    // diff walks TRACKED rather than the patch's own keys.
    const r = applyPatch(issue(), { priority: 'high', summary: 'Renamed' }, wf, ctx);
    expect(r.changed).toBe(true);
    expect(rows(r)).toEqual([
      ['summary', 'Test issue', 'Renamed'],
      ['priority', 'normal', 'high'],
    ]);
  });

  it('moves a pre-assigned issue to "assigned" when a handler arrives, and notifies them', () => {
    const r = applyPatch(issue(), { handlerId: 4 }, wf, ctx);
    expect(r.next.status).toBe('assigned');
    expect(r.monitorsToAdd).toEqual([4]);
    expect(r.next.monitorIds).toEqual([7, 4]);
    expect(r.notifications.filter((n) => n.type === 'assigned')).toEqual([
      { type: 'assigned', recipients: [4], subject: 'Test issue' },
    ]);
    // Both the handler change and the derived status change are logged.
    expect(rows(r)).toEqual([
      ['status', 'new', 'assigned'],
      ['handlerId', '', '4'],
    ]);
  });

  it('does not auto-assign when the patch sets status itself', () => {
    const r = applyPatch(issue(), { handlerId: 4, status: 'confirmed' }, wf, ctx);
    expect(r.next.status).toBe('confirmed');
  });

  it('does not auto-assign past "assigned", nor when autoAssignStatus is off', () => {
    expect(applyPatch(issue({ status: 'resolved' }), { handlerId: 4 }, wf, ctx).next.status)
      .toBe('resolved');
    wf.autoAssignStatus = false;
    expect(applyPatch(issue(), { handlerId: 4 }, wf, ctx).next.status).toBe('new');
  });

  it('never changes status when the handler is cleared', () => {
    const r = applyPatch(issue({ status: 'assigned', handlerId: 4 }), { handlerId: null }, wf, ctx);
    expect(r.next.status).toBe('assigned');
    expect(r.notifications.some((n) => n.type === 'assigned')).toBe(false);
  });

  it('settles the resolution to "fixed" on entering a resolved state', () => {
    const r = applyPatch(issue(), { status: 'resolved' }, wf, ctx);
    expect(r.next.resolution).toBe('fixed');
    expect(r.next.resolvedAt).toEqual(NOW);
    expect(r.next.firstResolvedAt).toEqual(NOW);
  });

  it('keeps an explicitly supplied resolution instead of forcing "fixed"', () => {
    const r = applyPatch(issue(), { status: 'resolved', resolution: 'duplicate' }, wf, ctx);
    expect(r.next.resolution).toBe('duplicate');
  });

  it('marks the resolution "reopened" on leaving a resolved state, and counts the reopen', () => {
    const resolved = issue({
      status: 'resolved', resolution: 'fixed',
      resolvedAt: new Date(EARLIER), firstResolvedAt: new Date(EARLIER),
    });
    const r = applyPatch(resolved, { status: 'feedback' }, wf, ctx);
    expect(r.next.resolution).toBe('reopened');
    expect(r.next.resolvedAt).toBeNull();
    // firstResolvedAt survives a reopen: MTTR and "was ever resolved" still need it.
    expect(r.next.firstResolvedAt).toEqual(new Date(EARLIER));
    expect(r.next.reopenedAt).toEqual(NOW);
    expect(r.next.reopenCount).toBe(1);
  });

  it('notifies watchers of a status change with both endpoints', () => {
    const r = applyPatch(issue({ monitorIds: [7, 5], handlerId: 4 }), { status: 'confirmed' }, wf, ctx);
    const n = r.notifications.find((x) => x.type === 'status');
    expect(n).toMatchObject({ fromStatus: 'new', toStatus: 'confirmed', subject: 'Test issue' });
    // watchers = monitors ∪ reporter ∪ handler. The actor is filtered out later, in SQL.
    expect(n?.recipients).toEqual([7, 5, 7, 4]);
  });

  it('treats a patch that moves nothing tracked as a no-op', () => {
    // tags, monitorIds and customFields are not in TRACKED: they have their own history
    // types, and here they must not bump `updated` or emit anything.
    const r = applyPatch(issue(), { tags: ['regression'], customFields: { 1: 'Chrome' } }, wf, ctx);
    expect(r.changed).toBe(false);
    expect(r.history).toEqual([]);
    expect(r.notifications).toEqual([]);
    expect(r.next.updated).toBe(EARLIER);
  });

  it('stamps `updated` exactly once, from the injected clock', () => {
    const r = applyPatch(issue(), { summary: 'New' }, wf, ctx);
    expect(r.next.updated).toBe(NOW.toISOString());
    expect(r.next.created).toBe(EARLIER);
  });

  it('notifies only mentions that were not already present', () => {
    const withMention = (id: string) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id, label: 'u' + id } }] }],
    });
    const before = issue({ description: withMention('4') as Issue['description'] });
    const r = applyPatch(
      before,
      {
        description: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'mention', attrs: { id: '4', label: 'u4' } }] },
            { type: 'paragraph', content: [{ type: 'mention', attrs: { id: '5', label: 'u5' } }] },
          ],
        } as Issue['description'],
      },
      wf,
      ctx,
    );
    const mention = r.notifications.find((n) => n.type === 'mentioned');
    expect(mention?.recipients).toEqual([5]);
  });

  it('flags the search index dirty only for summary and the rich fields', () => {
    expect(applyPatch(issue(), { summary: 'New' }, wf, ctx).searchDirty).toBe(true);
    expect(applyPatch(issue(), { description: doc('other') }, wf, ctx).searchDirty).toBe(true);
    expect(applyPatch(issue(), { priority: 'high' }, wf, ctx).searchDirty).toBe(false);
  });

  it('recomputes the rank columns alongside the enums', () => {
    const r = applyPatch(issue(), { priority: 'immediate', status: 'confirmed' }, wf, ctx);
    expect(r.next.priorityRank).toBe(5);
    expect(r.next.statusRank).toBe(3);
  });

  it('logs rich-text changes as a truncated plain-text excerpt', () => {
    const long = 'a'.repeat(300);
    const r = applyPatch(issue(), { description: doc(long) }, wf, ctx);
    const row = r.history.find((h) => h.field === 'description');
    expect(row?.old).toBe('x');
    expect(row?.new).toHaveLength(120);
  });
});
