import { createSeed } from './seed';
import { criteriaToParams, filterIssues, paramsToCriteria, sortIssues } from './issue-filter';
import { emptyCriteria } from './config';
import type { Issue } from './models';

describe('issue-filter', () => {
  const db = createSeed(Date.UTC(2026, 8, 29));
  const ctx = { meId: 3, projects: db.projects, now: Date.UTC(2026, 8, 29) };

  it('hides closed issues by default and shows them when hideStatus is cleared', () => {
    const def = filterIssues(db.issues, {}, ctx);
    expect(def.some((i) => i.status === 'closed')).toBe(false);
    const all = filterIssues(db.issues, { hideStatus: '' }, ctx);
    expect(all.length).toBe(db.issues.length);
  });

  it('resolves -1 to the current user and 0 to unassigned', () => {
    const mine = filterIssues(db.issues, { handlerIds: [-1], hideStatus: '' }, ctx);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((i) => i.handlerId === 3)).toBe(true);
    const unassigned = filterIssues(db.issues, { handlerIds: [0], hideStatus: '' }, ctx);
    expect(unassigned.every((i) => i.handlerId === null)).toBe(true);
  });

  it('includes subprojects unless disabled', () => {
    const withSub = filterIssues(db.issues, { projectIds: [1], hideStatus: '' }, ctx);
    expect(withSub.some((i) => i.projectId === 4)).toBe(true);
    const without = filterIssues(db.issues, { projectIds: [1], includeSubprojects: false, hideStatus: '' }, ctx);
    expect(without.every((i) => i.projectId === 1)).toBe(true);
  });

  it('matches "#id" and KEY-id text as an exact issue id', () => {
    expect(filterIssues(db.issues, { text: '#7', hideStatus: '' }, ctx).map((i) => i.id)).toEqual([7]);
    expect(filterIssues(db.issues, { text: 'web-2', hideStatus: '' }, ctx).map((i) => i.id)).toEqual([2]);
  });

  it('supports any/all tag matching', () => {
    const issues = [{ ...db.issues[0], id: 1, tags: ['a', 'b'] }, { ...db.issues[0], id: 2, tags: ['a'] }] as Issue[];
    expect(filterIssues(issues, { tags: ['a', 'b'], tagsMode: 'any', hideStatus: '' }, ctx).length).toBe(2);
    expect(filterIssues(issues, { tags: ['a', 'b'], tagsMode: 'all', hideStatus: '' }, ctx).map((i) => i.id)).toEqual([1]);
  });

  it('sorts sticky issues first, then by priority rank', () => {
    const base = db.issues[0];
    const list = [
      { ...base, id: 1, sticky: false, priority: 'urgent' },
      { ...base, id: 2, sticky: true, priority: 'low' },
      { ...base, id: 3, sticky: false, priority: 'normal' },
    ] as Issue[];
    expect(sortIssues(list, [{ column: 'priority', dir: 'desc' }]).map((i) => i.id)).toEqual([2, 1, 3]);
  });

  it('round-trips criteria through URL params', () => {
    const c = { ...emptyCriteria(), projectIds: [1, 4], statuses: ['new' as const], handlerIds: [-1], hideStatus: '' as const, hasAttachments: true, sprintIds: ['none' as const, 2] };
    expect(paramsToCriteria(criteriaToParams(c))).toEqual(c);
  });
});
