import { describe, expect, it } from 'vitest';
import { emptyCriteria } from '../../src/shared/config';
import { criteriaToParams } from '../../src/shared/filter-semantics';
import type { FilterCriteria } from '../../src/shared/models';
import { parseIssueQuery, parseSort } from '../../src/modules/issues/dto/filter-issue.dto';

/**
 * The URL shape is a contract: a filter link copied out of the UI has to resolve to the same
 * result set in the API. These tests pin the round trip through the frontend's own
 * criteriaToParams(), which is the serializer the client actually uses.
 */
describe('parseIssueQuery', () => {
  it('round-trips whatever the frontend serializes', () => {
    const original: FilterCriteria = {
      ...emptyCriteria(),
      projectIds: [1, 4],
      statuses: ['new', 'assigned'],
      handlerIds: [-1, 0],
      sprintIds: ['none', 2],
      tags: ['regression', 'ux'],
      tagsMode: 'all',
      hideStatus: '',
      hasAttachments: true,
      monitorId: -1,
      customFieldId: 1,
      customFieldValue: 'chrome',
      overdueOnly: true,
      text: 'session timeout',
      searchNotes: true,
      createdFrom: '2026-08-01',
    };

    const params = criteriaToParams(original);
    const parsed = parseIssueQuery(params);

    // criteriaToParams omits defaults, so the parsed partial carries only what changed —
    // and merging it back onto the defaults must reproduce the original exactly.
    expect({ ...emptyCriteria(), ...parsed.criteria }).toEqual(original);
  });

  it('returns a true partial, not a filled-in criteria object', () => {
    // buildIssueWhere applies emptyCriteria()'s defaults itself. If this returned a full object
    // instead, `hideStatus: 'closed'` would arrive as an explicit value and could never be
    // distinguished from the caller asking for it.
    const parsed = parseIssueQuery({ statuses: 'new' });
    expect(Object.keys(parsed.criteria)).toEqual(['statuses']);
  });

  it('keeps the three sentinel conventions intact', () => {
    expect(parseIssueQuery({ handlerIds: '-1,0,4' }).criteria.handlerIds).toEqual([-1, 0, 4]);
    expect(parseIssueQuery({ sprintIds: 'none,2' }).criteria.sprintIds).toEqual(['none', 2]);
    expect(parseIssueQuery({ monitorId: '-1' }).criteria.monitorId).toBe(-1);
  });

  it('decodes the tri-state hasAttachments, including the literal "null"', () => {
    expect(parseIssueQuery({ hasAttachments: 'true' }).criteria.hasAttachments).toBe(true);
    expect(parseIssueQuery({ hasAttachments: 'false' }).criteria.hasAttachments).toBe(false);
    expect(parseIssueQuery({ hasAttachments: 'null' }).criteria.hasAttachments).toBeNull();
  });

  it('normalizes a repeated parameter to the comma-joined form', () => {
    // Fastify hands over a string[] when a key appears twice; the contract is comma-joined, so
    // both must mean the same thing rather than the last one silently winning.
    expect(parseIssueQuery({ statuses: ['new', 'assigned'] }).criteria.statuses)
      .toEqual(['new', 'assigned']);
  });

  it('ignores the reserved paging keys', () => {
    const parsed = parseIssueQuery({ statuses: 'new', page: '2', pageSize: '50', sort: 'id:asc', withIds: 'true' });
    expect(Object.keys(parsed.criteria)).toEqual(['statuses']);
    expect(parsed.page).toBe(2);
    expect(parsed.pageSize).toBe(50);
    expect(parsed.withIds).toBe(true);
  });

  it('defaults paging to page 0 and no explicit size', () => {
    const parsed = parseIssueQuery({});
    expect(parsed.page).toBe(0);
    // undefined, not 25: the caller's own prefs.pageSize decides, not a server constant.
    expect(parsed.pageSize).toBeUndefined();
    expect(parsed.withIds).toBe(false);
  });

  it('survives garbage paging values instead of producing NaN', () => {
    const parsed = parseIssueQuery({ page: 'abc', pageSize: '-5' });
    expect(parsed.page).toBe(0);
    expect(parsed.pageSize).toBe(0);
  });
});

describe('parseSort', () => {
  it('parses multiple keys with directions', () => {
    expect(parseSort('priority:desc,id:asc')).toEqual([
      { column: 'priority', dir: 'desc' },
      { column: 'id', dir: 'asc' },
    ]);
  });

  it('defaults a missing or bogus direction to desc', () => {
    expect(parseSort('updated')).toEqual([{ column: 'updated', dir: 'desc' }]);
    expect(parseSort('updated:sideways')).toEqual([{ column: 'updated', dir: 'desc' }]);
  });

  it('drops unknown columns rather than rejecting the request', () => {
    // Mirrors sortValue()'s `?? ''` fallback: an old bookmark naming a renamed column should
    // still return results, just ordered differently.
    expect(parseSort('nope:asc,priority:desc')).toEqual([{ column: 'priority', dir: 'desc' }]);
    expect(parseSort('nope')).toEqual([]);
  });

  it('returns nothing for an empty value, so the default sort applies', () => {
    expect(parseSort(undefined)).toEqual([]);
    expect(parseSort('')).toEqual([]);
  });
});
