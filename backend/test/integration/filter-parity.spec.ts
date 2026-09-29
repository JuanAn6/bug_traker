import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { emptyCriteria } from '../../src/shared/config';
import { descendantProjectIds, filterIssues, sortIssues } from '../../src/shared/filter-semantics';
import type { Db as DbJson, FilterCriteria, SortKey } from '../../src/shared/models';
import { plainText } from '../../src/shared/rich';
import { createSeed } from '../../src/shared/seed';
import { createDb, createPool, type Db } from '../../src/core/database/drizzle.service';
import { issues } from '../../src/core/database/schema';
import { ingestDb } from '../../src/modules/admin/db-import';
import {
  buildIssueOrderBy, buildIssueWhere,
} from '../../src/modules/issues/issue-query.builder';

/**
 * THE differential test.
 *
 * It runs the frontend's own filterIssues()/sortIssues() — copied verbatim into src/shared —
 * over the seeded dataset, then runs the SQL translation over the same rows in MariaDB, and
 * demands identical id lists IN ORDER.
 *
 * This is where the translation will actually break: `hideStatus` is a rank threshold that
 * switches off when `statuses` is given, three different sentinels mean "me"/"unassigned"/
 * "backlog", the text search is an accent-insensitive AND-of-substrings with an id
 * short-circuit, and sticky sorts above the user's own keys. None of that is visible to a
 * type-checker.
 *
 * Visibility is deliberately NOT exercised here: filterIssues() assumes the caller already
 * scoped the list, so the builder is called without a scope. Access control has its own test.
 */
describe('FilterCriteria -> SQL parity', () => {
  const SEED_NOW = Date.UTC(2026, 8, 29);
  const ME = 3; // dkim, a developer and member of Web Portal
  let json: DbJson;
  let db: Db;
  let pool: Awaited<ReturnType<typeof createPool>>;

  const ctx = () => ({ meId: ME, now: new Date(SEED_NOW) });

  beforeAll(async () => {
    const url = process.env['DATABASE_URL_TEST'];
    if (!url) throw new Error('DATABASE_URL_TEST is required for integration tests');

    json = createSeed(SEED_NOW);
    pool = createPool({ url, poolSize: 2 });
    db = createDb(pool);
    await ingestDb(db, json, {
      mode: 'replace',
      passwordHash: await hash('demo', { algorithm: 2 }),
      source: 'filter-parity.spec',
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  /** The in-memory context filterIssues() expects. */
  const memoryCtx = () => ({
    meId: ME,
    now: SEED_NOW,
    projects: json.projects,
    attachmentCounts: new Map<number, number>(
      // Same rule the store uses: current && issueId != 0.
      [...json.attachments.filter((a) => a.current && a.issueId)
        .reduce((m, a) => m.set(a.issueId, (m.get(a.issueId) ?? 0) + 1), new Map<number, number>())],
    ),
    // Built from every comment, exactly as the frontend does (no privacy filter) — the
    // builder is called without a scope here so the two agree.
    noteText: json.comments.reduce((m, c) => {
      const prev = m.get(c.issueId) ?? '';
      return m.set(c.issueId, `${prev} ${plainText(c.body)}`);
    }, new Map<number, string>()),
  });

  const descendants = (ids: number[]) => [...descendantProjectIds(json.projects, ids)];

  /** Runs both implementations and returns their id lists. */
  async function both(criteria: Partial<FilterCriteria>, sort: SortKey[] = []) {
    const expected = sortIssues(
      filterIssues(json.issues, criteria, memoryCtx()),
      sort,
    ).map((i) => i.id);

    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(buildIssueWhere(criteria, ctx(), descendants))
      .orderBy(...buildIssueOrderBy(sort));

    return { expected, actual: rows.map((r) => r.id) };
  }

  const parity = async (criteria: Partial<FilterCriteria>, sort: SortKey[] = []) => {
    const { expected, actual } = await both(criteria, sort);
    expect(actual).toEqual(expected);
    return expected;
  };

  it('seeded the dataset the frontend spec pins', () => {
    expect(json.issues).toHaveLength(80);
    expect(json.projects.find((p) => p.id === 4)?.parentId).toBe(1);
  });

  describe('defaults', () => {
    it('hides closed issues with no criteria at all', async () => {
      const ids = await parity({});
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.length).toBeLessThan(80);
      const closed = new Set(json.issues.filter((i) => i.status === 'closed').map((i) => i.id));
      expect(ids.some((id) => closed.has(id))).toBe(false);
    });

    it('returns everything once hideStatus is cleared', async () => {
      expect(await parity({ hideStatus: '' })).toHaveLength(80);
    });

    it('treats hideStatus as a rank threshold, not an equality', async () => {
      // 'resolved' must hide resolved AND closed.
      const ids = await parity({ hideStatus: 'resolved' });
      const tail = new Set(
        json.issues.filter((i) => i.status === 'resolved' || i.status === 'closed').map((i) => i.id),
      );
      expect(ids.some((id) => tail.has(id))).toBe(false);
    });

    it('ignores hideStatus when statuses is given', async () => {
      // Asking for closed issues explicitly must win over the default that hides them.
      const ids = await parity({ statuses: ['closed'] });
      expect(ids.length).toBeGreaterThan(0);
    });
  });

  describe('sentinels', () => {
    it('resolves -1 to the current user for handler and reporter', async () => {
      await parity({ handlerIds: [-1], hideStatus: '' });
      await parity({ reporterIds: [-1], hideStatus: '' });
    });

    it('resolves 0 to unassigned', async () => {
      const ids = await parity({ handlerIds: [0], hideStatus: '' });
      expect(ids.length).toBeGreaterThan(0);
      expect(json.issues.filter((i) => ids.includes(i.id)).every((i) => i.handlerId === null)).toBe(true);
    });

    it('mixes unassigned with real handlers', async () => {
      await parity({ handlerIds: [0, 4, -1], hideStatus: '' });
    });

    it("resolves 'none' to the backlog, alone and mixed with real sprints", async () => {
      await parity({ sprintIds: ['none'], hideStatus: '' });
      await parity({ sprintIds: [2], hideStatus: '' });
      await parity({ sprintIds: ['none', 2], hideStatus: '' });
    });

    it('resolves monitorId -1 to the current user and ignores a literal 0', async () => {
      await parity({ monitorId: -1, hideStatus: '' });
      await parity({ monitorId: 0, hideStatus: '' });
    });
  });

  describe('project scope', () => {
    it('includes subprojects by default', async () => {
      const ids = await parity({ projectIds: [1], hideStatus: '' });
      const inSub = json.issues.filter((i) => i.projectId === 4).map((i) => i.id);
      expect(ids).toEqual(expect.arrayContaining(inSub));
    });

    it('excludes them when asked', async () => {
      const ids = await parity({ projectIds: [1], includeSubprojects: false, hideStatus: '' });
      expect(json.issues.filter((i) => ids.includes(i.id)).every((i) => i.projectId === 1)).toBe(true);
    });

    it('handles several projects at once', async () => {
      await parity({ projectIds: [2, 3], hideStatus: '' });
    });
  });

  describe('enum filters', () => {
    it('matches every single-value case for all five enums', async () => {
      const c = emptyCriteria();
      for (const status of ['new', 'feedback', 'assigned', 'resolved', 'closed'] as const) {
        await parity({ statuses: [status] });
      }
      for (const priority of ['none', 'low', 'normal', 'high', 'urgent', 'immediate'] as const) {
        await parity({ priorities: [priority], hideStatus: '' });
      }
      for (const severity of ['minor', 'major', 'crash', 'block', 'feature'] as const) {
        await parity({ severities: [severity], hideStatus: '' });
      }
      for (const resolution of ['open', 'fixed', 'duplicate', 'wont_fix'] as const) {
        await parity({ resolutions: [resolution], hideStatus: '' });
      }
      for (const repro of ['always', 'sometimes', 'random', 'na'] as const) {
        await parity({ reproducibility: [repro], hideStatus: '' });
      }
      expect(c.tagsMode).toBe('any');
    });

    it('handles multi-value sets', async () => {
      await parity({ statuses: ['new', 'assigned', 'closed'] });
      await parity({ priorities: ['urgent', 'immediate'], severities: ['crash', 'block'], hideStatus: '' });
    });
  });

  describe('tags', () => {
    it('matches any and all', async () => {
      await parity({ tags: ['regression'], hideStatus: '' });
      await parity({ tags: ['regression', 'ux'], tagsMode: 'any', hideStatus: '' });
      await parity({ tags: ['regression', 'ux'], tagsMode: 'all', hideStatus: '' });
      await parity({ tags: ['backend', 'security', 'customer'], tagsMode: 'all', hideStatus: '' });
    });
  });

  describe('text search', () => {
    it('short-circuits #id and KEY-id to an exact id', async () => {
      expect(await parity({ text: '#7', hideStatus: '' })).toEqual([7]);
      expect(await parity({ text: 'web-2', hideStatus: '' })).toEqual([2]);
      // The project key is ignored, as in the frontend: MOB-2 still finds issue 2.
      expect(await parity({ text: 'MOB-2', hideStatus: '' })).toEqual([2]);
    });

    it('requires every word to appear, in any order', async () => {
      await parity({ text: 'login', hideStatus: '' });
      await parity({ text: 'timeout', hideStatus: '' });
      await parity({ text: 'session timeout', hideStatus: '' });
      await parity({ text: 'timeout session', hideStatus: '' });
    });

    it('matches substrings mid-word, which FULLTEXT could not', async () => {
      await parity({ text: 'ogin', hideStatus: '' });
    });

    it('ignores accents and case', async () => {
      await parity({ text: 'MARIA', hideStatus: '' });
      await parity({ text: 'configuración', hideStatus: '' });
      await parity({ text: 'configuracion', hideStatus: '' });
    });

    it('searches note bodies only when asked', async () => {
      await parity({ text: 'staging', hideStatus: '' });
      await parity({ text: 'staging', searchNotes: true, hideStatus: '' });
      await parity({ text: 'console log', searchNotes: true, hideStatus: '' });
    });

    it('finds nothing for a term that is absent', async () => {
      expect(await parity({ text: 'zzzznotpresent', hideStatus: '' })).toEqual([]);
    });
  });

  describe('dates', () => {
    it('matches created and updated ranges', async () => {
      await parity({ createdFrom: '2026-08-01', hideStatus: '' });
      await parity({ createdTo: '2026-08-01', hideStatus: '' });
      await parity({ createdFrom: '2026-08-01', createdTo: '2026-09-15', hideStatus: '' });
      await parity({ updatedFrom: '2026-09-01', hideStatus: '' });
      await parity({ updatedFrom: '2026-09-01', updatedTo: '2026-09-29', hideStatus: '' });
    });

    it('is inclusive on both bounds', async () => {
      // The frontend compares `iso.slice(0,10) >= from` and `<= to`, so a boundary day is in.
      const day = json.issues[0]!.created.slice(0, 10);
      await parity({ createdFrom: day, createdTo: day, hideStatus: '' });
    });

    it('matches due-date ranges and leaves null due dates alone when unbounded', async () => {
      await parity({ dueFrom: '2026-09-01', hideStatus: '' });
      await parity({ dueTo: '2026-10-31', hideStatus: '' });
      await parity({ dueFrom: '2026-09-01', dueTo: '2026-10-31', hideStatus: '' });
    });

    it('matches overdueOnly against the injected clock', async () => {
      const ids = await parity({ overdueOnly: true, hideStatus: '' });
      expect(ids.length).toBeGreaterThan(0);
    });
  });

  describe('other fields', () => {
    it('matches viewState, versions, platform and os', async () => {
      await parity({ viewState: 'private', hideStatus: '' });
      await parity({ viewState: 'public', hideStatus: '' });
      await parity({ targetVersion: '1.2', hideStatus: '' });
      await parity({ fixedInVersion: '1.1', hideStatus: '' });
      await parity({ platform: 'desktop', hideStatus: '' });
      await parity({ os: 'ubuntu', hideStatus: '' });
      await parity({ os: 'macos 15', hideStatus: '' });
    });

    it('matches the tri-state hasAttachments', async () => {
      // The seed ships no attachments, so true is empty and false is everything.
      expect(await parity({ hasAttachments: true, hideStatus: '' })).toEqual([]);
      expect(await parity({ hasAttachments: false, hideStatus: '' })).toHaveLength(80);
      expect(await parity({ hasAttachments: null, hideStatus: '' })).toHaveLength(80);
    });

    it('matches relationships by type, in both directions', async () => {
      await parity({ relationship: 'related_to', hideStatus: '' });
      await parity({ relationship: 'parent_of', hideStatus: '' });
      await parity({ relationship: 'child_of', hideStatus: '' });
      await parity({ relationship: 'duplicate_of', hideStatus: '' });
      await parity({ relationship: 'has_duplicate', hideStatus: '' });
    });

    it('matches custom fields by presence and by substring', async () => {
      // No value means "set to something non-empty" — '' must not match.
      await parity({ customFieldId: 1, hideStatus: '' });
      await parity({ customFieldId: 1, customFieldValue: 'chrome', hideStatus: '' });
      await parity({ customFieldId: 3, hideStatus: '' });
      await parity({ customFieldId: 2, hideStatus: '' });
    });
  });

  describe('sorting', () => {
    const cases: Array<[string, SortKey[]]> = [
      ['default (updated desc)', []],
      ['id asc', [{ column: 'id', dir: 'asc' }]],
      ['id desc', [{ column: 'id', dir: 'desc' }]],
      ['priority desc', [{ column: 'priority', dir: 'desc' }]],
      ['priority asc', [{ column: 'priority', dir: 'asc' }]],
      ['severity desc', [{ column: 'severity', dir: 'desc' }]],
      ['status asc', [{ column: 'status', dir: 'asc' }]],
      ['resolution desc', [{ column: 'resolution', dir: 'desc' }]],
      ['reproducibility asc', [{ column: 'reproducibility', dir: 'asc' }]],
      ['summary asc', [{ column: 'summary', dir: 'asc' }]],
      ['category asc', [{ column: 'category', dir: 'asc' }]],
      ['created asc', [{ column: 'created', dir: 'asc' }]],
      ['dueDate asc (nulls last)', [{ column: 'dueDate', dir: 'asc' }]],
      ['dueDate desc (nulls FIRST)', [{ column: 'dueDate', dir: 'desc' }]],
      ['storyPoints asc (nulls first)', [{ column: 'storyPoints', dir: 'asc' }]],
      ['storyPoints desc (nulls last)', [{ column: 'storyPoints', dir: 'desc' }]],
      ['targetVersion asc', [{ column: 'targetVersion', dir: 'asc' }]],
      ['tags asc', [{ column: 'tags', dir: 'asc' }]],
      ['multi-key: priority desc then created asc', [
        { column: 'priority', dir: 'desc' }, { column: 'created', dir: 'asc' },
      ]],
      ['multi-key: status asc then priority desc then id asc', [
        { column: 'status', dir: 'asc' }, { column: 'priority', dir: 'desc' }, { column: 'id', dir: 'asc' },
      ]],
    ];

    it.each(cases)('orders identically: %s', async (_name, sort) => {
      await parity({ hideStatus: '' }, sort);
    });

    it('floats the sticky issue to the top regardless of direction', async () => {
      const sticky = json.issues.find((i) => i.sticky)!.id;
      for (const dir of ['asc', 'desc'] as const) {
        const ids = await parity({ hideStatus: '' }, [{ column: 'priority', dir }]);
        expect(ids[0]).toBe(sticky);
      }
    });
  });

  describe('combinations', () => {
    it('matches realistic multi-field queries', async () => {
      await parity({
        projectIds: [1], statuses: ['assigned'], priorities: ['high', 'urgent'], handlerIds: [-1],
      }, [{ column: 'priority', dir: 'desc' }]);

      await parity({
        hideStatus: 'resolved', tags: ['regression'], tagsMode: 'any',
        createdFrom: '2026-07-01', overdueOnly: false,
      }, [{ column: 'updated', dir: 'desc' }]);

      await parity({
        projectIds: [1, 2], includeSubprojects: true, handlerIds: [0],
        severities: ['crash', 'block'], hideStatus: '',
      }, [{ column: 'severity', dir: 'desc' }, { column: 'id', dir: 'asc' }]);

      await parity({
        text: 'api', searchNotes: true, statuses: ['new', 'assigned', 'confirmed'],
        viewState: 'public',
      }, [{ column: 'created', dir: 'asc' }]);
    });

    it('matches the three saved filters the seed ships', async () => {
      for (const f of json.filters) {
        await parity(f.criteria, f.sort);
      }
    });
  });
});
