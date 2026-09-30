import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { createSeed } from '../../src/shared/seed';
import type { Db as DbJson } from '../../src/shared/models';
import { createDb, createPool } from '../../src/core/database/drizzle.service';
import { ingestDb } from '../../src/modules/admin/db-import';
import { ApiClient, startServer, stopServer } from './harness';

interface ListResponse {
  items: Array<{
    id: number; key: string; status: string; handlerId: number | null; projectId: number;
    tags: string[]; sticky: boolean; overdue: boolean; dueDate: string | null;
    reporterName: string; handlerName: string | null; noteCount: number;
  }>;
  total: number;
  page: number;
  pageSize: number;
  ids?: number[];
}

describe('issue reads', () => {
  let pool: ReturnType<typeof createPool>;
  let json: DbJson;
  let dev: ApiClient;      // dkim, developer, sees private issues
  let reporter: ApiClient; // nwilliams, level 25, not a member of the private project

  beforeAll(async () => {
    const url = process.env['DATABASE_URL_TEST'];
    if (!url) throw new Error('DATABASE_URL_TEST is required');
    json = createSeed(Date.UTC(2026, 8, 29));
    pool = createPool({ url, poolSize: 2 });
    await ingestDb(createDb(pool), json, {
      mode: 'replace',
      passwordHash: await hash('demo', { algorithm: 2 }),
      source: 'issues-read.e2e',
    });
    await startServer();
    dev = new ApiClient();
    await dev.login('dkim');
    reporter = new ApiClient();
    await reporter.login('nwilliams');
  }, 120_000);

  afterAll(async () => {
    await stopServer();
    await pool?.end();
  });

  describe('GET /issues', () => {
    it('hides closed issues with no parameters, matching the UI default view', async () => {
      const r = await dev.get<ListResponse>('/issues');
      expect(r.status).toBe(200);
      expect(r.body.items.some((i) => i.status === 'closed')).toBe(false);
      expect(r.body.total).toBeLessThan(80);
    });

    it('returns everything once hideStatus is cleared', async () => {
      const r = await dev.get<ListResponse>('/issues?hideStatus=&pageSize=200');
      expect(r.body.total).toBe(80);
      expect(r.body.items).toHaveLength(80);
    });

    it('ships a display key, resolved names and the overdue flag', async () => {
      const r = await dev.get<ListResponse>('/issues?hideStatus=&pageSize=5');
      const row = r.body.items[0]!;
      // The frontend builds `WEB-123` from the project key; the API ships it ready.
      expect(row.key).toMatch(/^[A-Z]+-\d+$/);
      expect(row.reporterName).toBeTruthy();
      expect(typeof row.overdue).toBe('boolean');
      // handlerName is null exactly when the issue is unassigned, never a stale name.
      for (const item of r.body.items) {
        expect(item.handlerName === null).toBe(item.handlerId === null);
      }
    });

    it('applies the sentinels', async () => {
      const mine = await dev.get<ListResponse>('/issues?handlerIds=-1&hideStatus=&pageSize=200');
      expect(mine.body.items.every((i) => i.handlerId === 3)).toBe(true);

      const unassigned = await dev.get<ListResponse>('/issues?handlerIds=0&hideStatus=&pageSize=200');
      expect(unassigned.body.items.every((i) => i.handlerId === null)).toBe(true);
      expect(unassigned.body.total).toBeGreaterThan(0);
    });

    it('short-circuits #id and KEY-id', async () => {
      expect((await dev.get<ListResponse>('/issues?text=%237&hideStatus=')).body.items.map((i) => i.id)).toEqual([7]);
      expect((await dev.get<ListResponse>('/issues?text=web-2&hideStatus=')).body.items.map((i) => i.id)).toEqual([2]);
    });

    it('includes subprojects unless told not to', async () => {
      const withSub = await dev.get<ListResponse>('/issues?projectIds=1&hideStatus=&pageSize=200');
      expect(withSub.body.items.some((i) => i.projectId === 4)).toBe(true);

      const without = await dev.get<ListResponse>(
        '/issues?projectIds=1&includeSubprojects=false&hideStatus=&pageSize=200',
      );
      expect(without.body.items.every((i) => i.projectId === 1)).toBe(true);
    });

    it('paginates with a stable total and floats sticky issues to the top of page 0', async () => {
      const first = await dev.get<ListResponse>('/issues?hideStatus=&pageSize=10&page=0');
      const second = await dev.get<ListResponse>('/issues?hideStatus=&pageSize=10&page=1');
      expect(first.body.total).toBe(80);
      expect(second.body.total).toBe(80);
      expect(first.body.items).toHaveLength(10);
      // No overlap between consecutive pages.
      const firstIds = new Set(first.body.items.map((i) => i.id));
      expect(second.body.items.some((i) => firstIds.has(i.id))).toBe(false);
      expect(first.body.items[0]!.sticky).toBe(true);
    });

    it('caps pageSize and treats 0 as "all"', async () => {
      const capped = await dev.get<ListResponse>('/issues?hideStatus=&pageSize=0');
      expect(capped.body.pageSize).toBe(200);
      expect(capped.body.items).toHaveLength(80);
    });

    it('returns the ordered id list only when asked', async () => {
      const without = await dev.get<ListResponse>('/issues?hideStatus=&pageSize=5');
      expect(without.body.ids).toBeUndefined();

      const withIds = await dev.get<ListResponse>('/issues?hideStatus=&pageSize=5&withIds=true');
      // The issue view needs the whole filtered order for prev/next, not just the page.
      expect(withIds.body.ids).toHaveLength(80);
      expect(withIds.body.ids!.slice(0, 5)).toEqual(withIds.body.items.map((i) => i.id));
    });

    it('never leaks issues the caller cannot see', async () => {
      const all = await reporter.get<ListResponse>('/issues?hideStatus=&pageSize=200');
      // DATA is private and nwilliams is not a member.
      expect(all.body.items.some((i) => i.projectId === 3)).toBe(false);
      expect(all.body.total).toBeLessThan(80);
    });

    it('needs authentication', async () => {
      expect((await new ApiClient().get('/issues')).status).toBe(401);
    });
  });

  describe('GET /issues/count', () => {
    it('agrees with the list total', async () => {
      const list = await dev.get<ListResponse>('/issues?statuses=new&pageSize=1');
      const count = await dev.get<{ total: number }>('/issues/count?statuses=new');
      expect(count.body.total).toBe(list.body.total);
    });
  });

  describe('GET /issues/:id', () => {
    it('returns the whole issue view in one request', async () => {
      const r = await dev.get<Record<string, any>>('/issues/1');
      expect(r.status).toBe(200);
      expect(r.body.key).toMatch(/^[A-Z]+-1$/);
      expect(r.body.project.categories.length).toBeGreaterThan(0);
      expect(r.body.project.versions.length).toBeGreaterThan(0);
      expect(Array.isArray(r.body.allowedTransitions)).toBe(true);
      expect(Array.isArray(r.body.assignable)).toBe(true);
      expect(r.body.permissions).toHaveProperty('edit');
      expect(r.body.effectiveLevel).toBe(55);
      expect(r.body.counts).toHaveProperty('notes');
    });

    it('resolves relationships and keeps issue 1 parent of 4 and 8', async () => {
      const r = await dev.get<{ relationships: Array<{ type: string; issueId: number; target: unknown }> }>('/issues/1');
      const children = r.body.relationships.filter((x) => x.type === 'parent_of').map((x) => x.issueId);
      expect(children.sort()).toEqual([4, 8]);
      expect(r.body.relationships[0]!.target).not.toBeNull();
    });

    it('offers only the transitions the actor may perform', async () => {
      const r = await dev.get<{ issue: { status: string }; allowedTransitions: string[] }>('/issues/1');
      // Whatever the current status, `new` is never reachable from a resolved state.
      if (['resolved', 'closed'].includes(r.body.issue.status)) {
        expect(r.body.allowedTransitions).not.toContain('new');
      }
      // A reporter at level 25 clears neither changeStatus (40) nor close (55).
      const asReporter = await reporter.get<{ allowedTransitions: string[] }>('/issues/1');
      if (asReporter.status === 200) expect(asReporter.body.allowedTransitions).toEqual([]);
    });

    it('answers 404 — not 403 — for an issue the caller cannot see', async () => {
      const privateIssue = json.issues.find(
        (i) => i.projectId === 3 && i.reporterId !== 7 && i.handlerId !== 7,
      )!;
      const r = await reporter.get(`/issues/${privateIssue.id}`);
      // 403 would confirm the issue exists, which is the leak privacy is meant to prevent.
      expect(r.status).toBe(404);
      expect(r.body).toMatchObject({ code: 'errors.issueNotFound' });
    });

    it('404s for an id that does not exist at all, identically', async () => {
      const r = await dev.get('/issues/999999');
      expect(r.status).toBe(404);
      expect(r.body).toMatchObject({ code: 'errors.issueNotFound' });
    });
  });

  describe('catalog', () => {
    it('lists only visible projects, with categories, versions and open counts', async () => {
      const r = await dev.get<Array<{ id: number; key: string; categories: unknown[]; openIssues: number }>>('/projects');
      expect(r.status).toBe(200);
      expect(r.body.map((p) => p.key).sort()).toEqual(['ADM', 'DATA', 'MOB', 'WEB']);
      expect(r.body.find((p) => p.key === 'WEB')!.categories).toHaveLength(5);
      expect(r.body.find((p) => p.key === 'WEB')!.openIssues).toBeGreaterThan(0);

      const limited = await reporter.get<Array<{ key: string }>>('/projects');
      expect(limited.body.map((p) => p.key)).not.toContain('DATA');
    });

    it('lists users without emails or hashes', async () => {
      const r = await dev.get<Array<Record<string, unknown>>>('/users');
      expect(r.body).toHaveLength(8);
      // Readable by everyone, so it carries only what the pickers and avatars render.
      expect(Object.keys(r.body[0]!)).not.toContain('email');
      expect(Object.keys(r.body[0]!)).not.toContain('passwordHash');
    });

    it('lists sprints, optionally scoped to a project', async () => {
      expect((await dev.get<unknown[]>('/sprints')).body).toHaveLength(6);
      const web = await dev.get<Array<{ projectId: number }>>('/sprints?projectId=1');
      expect(web.body.every((s) => s.projectId === 1)).toBe(true);
    });

    it('derives tags with usage counts, scoped to visible issues', async () => {
      const r = await dev.get<Array<{ tag: string; count: number }>>('/tags');
      expect(r.body.length).toBeGreaterThan(0);
      expect(r.body.every((t) => t.count > 0)).toBe(true);
      // Sorted by name, matching Store.tags.
      expect(r.body.map((t) => t.tag)).toEqual([...r.body.map((t) => t.tag)].sort());

      const filtered = await dev.get<Array<{ tag: string }>>('/tags?query=reg');
      expect(filtered.body.every((t) => t.tag.startsWith('reg'))).toBe(true);
    });

    it('lists custom fields with usage and linked projects', async () => {
      const r = await dev.get<Array<{ name: string; usage: number; projectIds: number[]; options: string[] }>>(
        '/custom-fields',
      );
      expect(r.body).toHaveLength(3);
      const browser = r.body.find((f) => f.name === 'Browser')!;
      expect(browser.options).toEqual(['Chrome', 'Firefox', 'Safari', 'Edge']);
      expect(browser.projectIds).toContain(1);
    });

    it('lists the caller own filters plus shared ones', async () => {
      const r = await dev.get<Array<{ name: string; ownerId: number; shared: boolean }>>('/saved-filters');
      // dkim owns one; the other two are shared by users 1 and 2.
      expect(r.body).toHaveLength(3);
      expect(r.body.every((f) => f.ownerId === 3 || f.shared)).toBe(true);
    });
  });
});
