import { describe, expect, it } from 'vitest';
import {
  PRIORITIES, REPRODUCIBILITY, RESOLUTIONS, SEVERITIES, STATUSES, statusRank,
} from '../../src/shared/config';
import { rankColumns, ranks } from '../../src/modules/issues/domain/rank';

describe('rank columns', () => {
  it('agrees with the frontend statusRank helper for every status', () => {
    for (const s of STATUSES) expect(ranks.status(s)).toBe(statusRank(s));
  });

  it('orders enums by canonical position, not alphabetically', () => {
    // The whole reason the columns exist: 'urgent' must outrank 'normal', and a plain
    // alphabetical ORDER BY on the enum's string value would put 'normal' after it.
    expect(ranks.priority('urgent')).toBeGreaterThan(ranks.priority('normal'));
    expect(ranks.severity('block')).toBeGreaterThan(ranks.severity('minor'));
    expect(ranks.status('closed')).toBeGreaterThan(ranks.status('new'));
  });

  it('never yields -1, which would mean an enum value outside the canonical array', () => {
    for (const [name, list] of [
      ['status', STATUSES], ['resolution', RESOLUTIONS], ['priority', PRIORITIES],
      ['severity', SEVERITIES], ['reproducibility', REPRODUCIBILITY],
    ] as const) {
      for (const v of list) {
        expect(ranks[name](v as never), `${name}=${v}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('derives all five columns at once', () => {
    expect(
      rankColumns({
        status: 'assigned', resolution: 'open', priority: 'high',
        severity: 'crash', reproducibility: 'always',
      }),
    ).toEqual({
      statusRank: STATUSES.indexOf('assigned'),
      resolutionRank: RESOLUTIONS.indexOf('open'),
      priorityRank: PRIORITIES.indexOf('high'),
      severityRank: SEVERITIES.indexOf('crash'),
      reproducibilityRank: REPRODUCIBILITY.indexOf('always'),
    });
  });
});
