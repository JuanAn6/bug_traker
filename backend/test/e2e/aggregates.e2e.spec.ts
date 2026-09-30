import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { STATUSES } from '../../src/shared/config';
import { createSeed } from '../../src/shared/seed';
import { createDb, createPool, type Db } from '../../src/core/database/drizzle.service';
import * as s from '../../src/core/database/schema';
import { ingestDb } from '../../src/modules/admin/db-import';
import { ApiClient, startServer, stopServer } from './harness';

describe('aggregates and admin', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Db;
  let admin: ApiClient;
  let manager: ApiClient;
  let dev: ApiClient;
  let reporter: ApiClient;

  const reseed = async () => {
    await ingestDb(db, createSeed(Date.UTC(2026, 8, 29)), {
      mode: 'replace',
      passwordHash: await hash('demo', { algorithm: 2 }),
      source: 'aggregates.e2e',
    });
  };

  beforeAll(async () => {
    const url = process.env['DATABASE_URL_TEST'];
    if (!url) throw new Error('DATABASE_URL_TEST is required');
    pool = createPool({ url, poolSize: 4 });
    db = createDb(pool);
    await startServer();
  }, 120_000);

  afterAll(async () => {
    await stopServer();
    await pool?.end();
  });

  beforeEach(async () => {
    await reseed();
    admin = new ApiClient(); await admin.login('administrator');
    manager = new ApiClient(); await manager.login('mlopez');
    dev = new ApiClient(); await dev.login('dkim');
    reporter = new ApiClient(); await reporter.login('nwilliams');
  }, 60_000);

  describe('GET /summary', () => {
    it('agrees with the raw counts and keeps the buckets internally consistent', async () => {
      const r = await admin.get<Record<string, any>>('/summary');
      expect(r.status).toBe(200);

      expect(r.body.kpi.total).toBe(80);
      expect(r.body.kpi.open + r.body.kpi.resolved).toBe(80);
      // byStatus keeps its zeros — the chart has a fixed axis of seven.
      expect(r.body.byStatus).toHaveLength(7);
      expect(r.body.byStatus.reduce((sum: number, x: any) => sum + x.count, 0)).toBe(80);
      // byProject's arrays are aligned to STATUSES so the stacked bars line up.
      for (const project of r.body.byProject) {
        expect(project.counts).toHaveLength(STATUSES.length);
        expect(project.counts.reduce((a: number, b: number) => a + b, 0)).toBe(project.total);
      }
      expect(r.body.byProject.reduce((sum: number, p: any) => sum + p.total, 0)).toBe(80);
      // byPriority drops zeros, unlike byStatus.
      expect(r.body.byPriority.every((x: any) => x.count > 0)).toBe(true);
      // byCategory counts only open issues, capped at twelve.
      expect(r.body.byCategory.length).toBeLessThanOrEqual(12);
      expect(r.body.trend.labels).toHaveLength(12);
    });

    it('buckets unassigned issues under handler 0', async () => {
      const r = await admin.get<{ byHandler: Array<{ userId: number; open: number }> }>('/summary');
      const unassigned = r.body.byHandler.find((h) => h.userId === 0);
      expect(unassigned).toBeDefined();
      expect(unassigned!.open).toBeGreaterThan(0);
    });

    it('computes the reopen rate over issues that were EVER resolved', async () => {
      // The seed has no reopened issues, so the corrected formula has to be exercised on purpose.
      // The frontend divides by `currentlyResolved + reopened`, which double-counts an issue that
      // was reopened and then resolved again, and inflates the denominator with one left open.
      const before = await admin.get<{ reopenRatePct: number | null }>('/summary');
      expect(before.body.reopenRatePct).toBe(0);

      const id = (await dev.post<{ id: number }>('/issues', {
        projectId: 1, category: 'Documentation', summary: 'will bounce',
      })).body.id;
      await manager.post(`/issues/${id}/status`, { status: 'resolved' });
      await manager.post(`/issues/${id}/status`, { status: 'feedback' });

      const row = await db.select().from(s.issues).where(eq(s.issues.id, id)).limit(1);
      expect(row[0]!.reopenCount).toBe(1);
      // 26 issues have ever been resolved (25 seeded + this one); exactly one came back.
      const after = await admin.get<{ reopenRatePct: number | null }>('/summary');
      expect(after.body.reopenRatePct).toBe(Math.round((1 / 26) * 100));
    });

    it('scopes every figure to what the caller can see', async () => {
      const all = await admin.get<{ kpi: { total: number } }>('/summary');
      const limited = await reporter.get<{ kpi: { total: number } }>('/summary');
      // DATA is private and nwilliams is not a member: its issues must not reach a count.
      expect(limited.body.kpi.total).toBeLessThan(all.body.kpi.total);
    });
  });

  describe('roadmap and changelog read different columns', () => {
    it('groups the roadmap by targetVersion, unreleased only', async () => {
      const r = await admin.get<Array<{ project: { key: string }; entries: any[] }>>('/roadmap');
      expect(r.status).toBe(200);
      const web = r.body.find((p) => p.project.key === 'WEB');
      expect(web).toBeDefined();
      // 1.0 and 1.1 are released, so they belong to the changelog, not here.
      const names = web!.entries.filter((e) => e.kind === 'version').map((e) => e.name);
      expect(names).not.toContain('1.0');
      expect(names).toContain('1.2');
      // Sprints still in play come after the versions.
      expect(web!.entries.some((e) => e.kind === 'sprint')).toBe(true);
    });

    it('groups the changelog by fixedInVersion, released only and newest first', async () => {
      const r = await admin.get<Array<{ project: { key: string }; entries: any[] }>>('/changelog');
      const web = r.body.find((p) => p.project.key === 'WEB');
      expect(web).toBeDefined();
      const names = web!.entries.map((e) => e.name);
      // Only released versions, and in reverse sortOrder — which is why that column had to become
      // durable data rather than an array position.
      expect(names).not.toContain('1.2');
      expect(names.indexOf('1.1')).toBeLessThan(names.indexOf('1.0'));
      // Grouped by category inside each release.
      expect(web!.entries[0].categories.length).toBeGreaterThan(0);
    });
  });

  describe('board', () => {
    it('returns the workflow columns, the wip limits and per-card transitions', async () => {
      const r = await admin.get<Record<string, any>>('/board?projectId=1');
      expect(r.status).toBe(200);
      expect(r.body.columns).not.toContain('acknowledged'); // the default board omits it
      expect(r.body.wipLimits).toEqual({ assigned: 12 });
      expect(r.body.lanes).toHaveLength(1);
      // Computed server-side so drag-and-drop cannot disagree with what the server will accept.
      expect(Array.isArray(r.body.lanes[0].cards[0].allowedTransitions)).toBe(true);
    });

    it('groups into lanes and drops the empty ones', async () => {
      const byHandler = await admin.get<{ lanes: Array<{ key: string }> }>('/board?projectId=1&lane=handler');
      expect(byHandler.body.lanes.length).toBeGreaterThan(1);
      const byPriority = await admin.get<{ lanes: Array<{ key: string; cards: unknown[] }> }>(
        '/board?projectId=1&lane=priority',
      );
      expect(byPriority.body.lanes.every((l) => l.cards.length > 0)).toBe(true);
      // Most urgent lane first: reverse canonical order.
      expect(byPriority.body.lanes[0]!.key).toBe('immediate');
    });

    it('filters to the backlog with sprint=none', async () => {
      const r = await admin.get<{ lanes: Array<{ cards: Array<{ id: number }> }> }>('/board?sprint=none');
      const ids = r.body.lanes.flatMap((l) => l.cards.map((c) => c.id));
      const rows = await db.select({ id: s.issues.id, sprintId: s.issues.sprintId }).from(s.issues);
      const backlog = new Set(rows.filter((x) => x.sprintId === null).map((x) => x.id));
      expect(ids.every((id) => backlog.has(id))).toBe(true);
    });
  });

  describe('calendar', () => {
    it('returns a fixed 42-cell Monday-first grid keyed in UTC', async () => {
      const r = await admin.get<{ days: Array<{ key: string; inMonth: boolean }> }>('/calendar?month=2026-09');
      expect(r.status).toBe(200);
      // Fixed size so the grid never reflows between months.
      expect(r.body.days).toHaveLength(42);
      // 2026-09-01 is a Tuesday, so the grid starts on Monday the 31st of August.
      expect(r.body.days[0]!.key).toBe('2026-08-31');
      expect(r.body.days.filter((d) => d.inMonth)).toHaveLength(30);
    });

    it('places issues on their due date and marks sprint boundaries', async () => {
      const r = await admin.get<{ days: Array<{ key: string; issues: Array<{ dueDate: string }>; sprints: unknown[] }> }>(
        '/calendar?month=2026-09',
      );
      for (const day of r.body.days) {
        for (const issue of day.issues) expect(issue.dueDate).toBe(day.key);
      }
      expect(r.body.days.some((d) => d.sprints.length > 0)).toBe(true);
    });
  });

  describe('home', () => {
    it('answers every widget in one request', async () => {
      const r = await dev.get<{ widgets: Record<string, { items: unknown[] }>; activeSprints: unknown[] }>('/home');
      expect(r.status).toBe(200);
      // Without this the page is nine round trips.
      expect(Object.keys(r.body.widgets).sort()).toEqual(
        ['assigned', 'due', 'feedback', 'monitored', 'recent', 'reported', 'unassigned'],
      );
      expect(r.body.activeSprints.length).toBeGreaterThan(0);
    });
  });

  describe('sprint detail and burndown', () => {
    it('returns the scope, the backlog and a burndown spanning the sprint', async () => {
      const r = await admin.get<Record<string, any>>('/sprints/2/detail');
      expect(r.status).toBe(200);
      expect(r.body.sprint.id).toBe(2);
      expect(r.body.byStatus).toHaveLength(7);
      expect(r.body.canManage).toBe(true);

      const { burndown } = r.body;
      // start day 1 to end inclusive.
      expect(burndown.labels.length).toBe(burndown.ideal.length);
      expect(burndown.labels.length).toBeGreaterThan(1);
      // The ideal line runs from the full scope down to zero.
      expect(burndown.ideal[0]).toBe(burndown.total);
      expect(burndown.ideal.at(-1)).toBe(0);
      // Future days are null rather than zero, so the chart stops at today.
      expect(burndown.remaining.some((x: number | null) => x === null)).toBe(true);
    });

    it('404s an unknown sprint', async () => {
      expect((await admin.get('/sprints/9999/detail')).status).toBe(404);
    });
  });

  describe('project writes', () => {
    it('validates the key and rejects a duplicate case-insensitively', async () => {
      expect((await admin.post('/projects', { name: 'A', key: 'A' })).status).toBe(400);
      expect((await admin.post('/projects', { name: 'A', key: 'toolongkey1' })).status).toBe(400);
      const created = await admin.post<{ id: number }>('/projects', { name: 'Fresh', key: 'FRSH' });
      expect(created.status).toBe(201);
      const dup = await admin.post('/projects', { name: 'Other', key: 'frsh' });
      expect(dup.status).toBe(409);
      expect(dup.body).toMatchObject({ code: 'errors.keyTaken' });
    });

    it('seeds a category and a manager membership so the project is usable', async () => {
      const id = (await admin.post<{ id: number }>('/projects', { name: 'Usable', key: 'USE' })).body.id;
      const categories = await db.select().from(s.projectCategories).where(eq(s.projectCategories.projectId, id));
      expect(categories.map((c) => c.name)).toEqual(['General']);
      const members = await db.select().from(s.projectMembers).where(eq(s.projectMembers.projectId, id));
      expect(members[0]).toMatchObject({ userId: 1, accessLevel: 70 });
    });

    it('needs manageProject', async () => {
      // manageProject is 70; dkim is 55.
      expect((await dev.post('/projects', { name: 'No', key: 'NOPE' })).status).toBe(403);
    });

    it('propagates a category rename to the issues AND logs it', async () => {
      const before = await db.select().from(s.issues).where(eq(s.issues.category, 'Documentation'));
      expect(before.length).toBeGreaterThan(0);

      const r = await admin.put('/projects/1', {
        categories: [
          { name: 'UI' }, { name: 'Backend API' }, { name: 'Authentication' },
          { name: 'Performance' }, { name: 'Docs', previousName: 'Documentation' },
        ],
      });
      expect(r.status).toBe(204);

      expect(await db.select().from(s.issues).where(eq(s.issues.category, 'Documentation'))).toHaveLength(0);
      expect((await db.select().from(s.issues).where(eq(s.issues.category, 'Docs'))).length).toBe(before.length);

      // The frontend rewrites the issues but writes no history at all, so a rename across forty
      // issues leaves no trace. One row per issue here.
      const logged = await db
        .select()
        .from(s.historyEntries)
        .where(eq(s.historyEntries.field, 'category'));
      expect(logged.filter((h) => h.oldValue === 'Documentation' && h.newValue === 'Docs'))
        .toHaveLength(before.length);
    });

    it('refuses to delete a category still in use without a merge target', async () => {
      const r = await admin.put('/projects/1', {
        categories: [{ name: 'UI' }, { name: 'Backend API' }, { name: 'Authentication' }, { name: 'Performance' }],
      });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ code: 'errors.categoryInUse', params: { name: 'Documentation' } });
    });

    it('merges a deleted category into the nominated one', async () => {
      const [ui, docs] = await Promise.all([
        db.select().from(s.issues).where(eq(s.issues.category, 'UI')),
        db.select().from(s.issues).where(eq(s.issues.category, 'Documentation')),
      ]);

      const r = await admin.put('/projects/1', {
        categories: [{ name: 'UI' }, { name: 'Backend API' }, { name: 'Authentication' }, { name: 'Performance' }],
        categoryMerges: { Documentation: 'UI' },
      });
      expect(r.status).toBe(204);
      expect(await db.select().from(s.issues).where(eq(s.issues.category, 'UI')))
        .toHaveLength(ui.length + docs.length);
    });

    it('rewrites all three version columns on a version rename', async () => {
      const r = await admin.put('/projects/1', {
        versions: [
          { name: '1.0', released: true }, { name: '1.1-fixed', previousName: '1.1', released: true },
          { name: '1.2' }, { name: '2.0' },
        ],
      });
      expect(r.status).toBe(204);
      // productVersion, targetVersion and fixedInVersion all hold version names; leaving any of
      // them behind would orphan it.
      expect(await db.select().from(s.issues).where(eq(s.issues.fixedInVersion, '1.1'))).toHaveLength(0);
      expect((await db.select().from(s.issues).where(eq(s.issues.fixedInVersion, '1.1-fixed'))).length)
        .toBeGreaterThan(0);
    });

    it('reorders versions and rejects an incomplete order', async () => {
      expect((await admin.put('/projects/1/versions/order', { names: ['2.0', '1.2', '1.1', '1.0'] })).status).toBe(204);
      const versions = await db
        .select()
        .from(s.projectVersions)
        .where(eq(s.projectVersions.projectId, 1));
      expect(versions.sort((a, b) => a.sortOrder - b.sortOrder).map((v) => v.name))
        .toEqual(['2.0', '1.2', '1.1', '1.0']);

      expect((await admin.put('/projects/1/versions/order', { names: ['1.0'] })).status).toBe(422);
    });

    it('prevents a parent cycle', async () => {
      // 4 is already a child of 1, so making 1 a child of 4 would close a loop.
      const r = await admin.put('/projects/1', { parentId: 4 });
      expect(r.status).toBe(422);
      expect((await admin.put('/projects/1', { parentId: 1 })).status).toBe(422);
    });

    it('orphans subprojects rather than deleting them, and clears the default preference', async () => {
      await admin.patch('/me/prefs', { defaultProjectId: 1 });
      expect((await admin.delete('/projects/1')).status).toBe(204);

      const [child] = await db.select().from(s.projects).where(eq(s.projects.id, 4));
      // Deleting a parent must not silently take its subprojects with it.
      expect(child!.parentId).toBeNull();
      expect(child!.deletedAt).toBeNull();

      const [prefs] = await db.select().from(s.userPrefs).where(eq(s.userPrefs.userId, 1));
      // The one column with no FK, so it has to be cleared by hand.
      expect(prefs!.defaultProjectId).toBeNull();
    });
  });

  describe('sprint writes', () => {
    it('clamps a future start date to today', async () => {
      const id = (await manager.post<{ id: number }>('/sprints', {
        projectId: 1, name: 'Future', start: '2099-01-01', end: '2099-01-14',
      })).body.id;
      expect((await manager.post(`/sprints/${id}/start`)).status).toBe(204);

      const [sprint] = await db.select().from(s.sprints).where(eq(s.sprints.id, id));
      expect(sprint!.state).toBe('active');
      // A running sprint cannot claim to begin in 2099, and the burndown's first bucket would sit
      // in the future with nothing in it.
      expect(sprint!.start).toBe(new Date().toISOString().slice(0, 10));
    });

    it('rejects an inverted date range', async () => {
      const r = await manager.post('/sprints', {
        projectId: 1, name: 'Bad', start: '2027-02-01', end: '2027-01-01',
      });
      expect(r.status).toBe(422);
    });

    it('moves the unfinished work on complete, as real field changes', async () => {
      const target = (await manager.post<{ id: number }>('/sprints', {
        projectId: 1, name: 'Next', start: '2027-01-01', end: '2027-01-14',
      })).body.id;

      const before = await db.select().from(s.issues).where(eq(s.issues.sprintId, 2));
      const unfinished = before.filter((i) => i.statusRank < STATUSES.indexOf('resolved'));

      const r = await manager.post<{ moved: number[] }>('/sprints/2/complete', { moveTo: target });
      expect(r.status).toBe(200);
      expect(r.body.moved.sort()).toEqual(unfinished.map((i) => i.id).sort());

      const [closed] = await db.select().from(s.sprints).where(eq(s.sprints.id, 2));
      expect(closed!.state).toBe('closed');
      // Through the bulk patch, so each move has a history row rather than being a silent UPDATE.
      for (const issue of unfinished) {
        const rows = await db
          .select()
          .from(s.historyEntries)
          .where(eq(s.historyEntries.issueId, issue.id));
        expect(rows.some((h) => h.field === 'sprintId')).toBe(true);
      }
    });

    it('refuses to move work into another project sprint or a closed one', async () => {
      // Sprint 5 belongs to Mobile App; sprint 2 to Web Portal.
      const cross = await manager.post('/sprints/2/complete', { moveTo: 5 });
      expect(cross.status).toBe(422);

      await manager.post('/sprints/3/complete', { moveTo: null });
      const intoClosed = await manager.post('/sprints/2/complete', { moveTo: 3 });
      expect(intoClosed.status).toBe(422);
    });

    it('needs manageSprints', async () => {
      // manageSprints is 70; dkim is 55.
      expect((await dev.post('/sprints', { projectId: 1, name: 'No', start: '2027-01-01', end: '2027-01-02' })).status)
        .toBe(403);
      expect((await dev.post('/sprints/2/start')).status).toBe(403);
    });
  });

  describe('user writes', () => {
    it('creates a user with prefs and a deterministic avatar colour', async () => {
      const r = await admin.post<{ id: number }>('/users', {
        username: 'nuevo', realName: 'Nueva Persona', email: 'nuevo@example.com',
        accessLevel: 40, password: 'contrasena1',
      });
      expect(r.status).toBe(201);
      const [prefs] = await db.select().from(s.userPrefs).where(eq(s.userPrefs.userId, r.body.id));
      expect(prefs).toBeDefined();
      expect(prefs!.pageSize).toBe(25);
      const [user] = await db.select().from(s.users).where(eq(s.users.id, r.body.id));
      expect(user!.avatarColor).toMatch(/^#[0-9a-f]{6}$/i);

      // And the password works.
      const fresh = new ApiClient();
      expect((await fresh.login('nuevo', 'contrasena1')).status).toBe(201);
    });

    it('rejects a duplicate username', async () => {
      const r = await admin.post('/users', {
        username: 'dkim', realName: 'Clash', email: 'clash@example.com', accessLevel: 25,
      });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ code: 'errors.usernameTaken' });
    });

    it('ends the sessions of a user it disables', async () => {
      const victim = new ApiClient();
      await victim.login('loconnor');
      expect((await victim.get('/auth/me')).status).toBe(200);

      expect((await admin.patch('/users/5', { enabled: false })).status).toBe(204);
      // tokenVersion is bumped, so the live access token dies rather than lasting 15 minutes.
      expect((await victim.get('/auth/me')).status).toBe(401);
      expect((await victim.post('/auth/refresh')).status).toBe(401);
    });

    it('soft-deletes and reassigns, keeping the reporter resolvable', async () => {
      const handled = await db.select().from(s.issues).where(eq(s.issues.handlerId, 4));
      expect(handled.length).toBeGreaterThan(0);

      expect((await admin.delete('/users/4?reassignTo=3')).status).toBe(204);

      const [user] = await db.select().from(s.users).where(eq(s.users.id, 4));
      // Soft, unlike the frontend, which deletes the row and leaves every issue that person ever
      // filed with a dangling reporterId that no join can resolve.
      expect(user!.deletedAt).not.toBeNull();
      expect(user!.enabled).toBe(false);

      for (const issue of handled) {
        const [row] = await db.select().from(s.issues).where(eq(s.issues.id, issue.id));
        expect(row!.handlerId).toBe(3);
      }
      // Their reported issues still render.
      const reported = await db.select().from(s.issues).where(eq(s.issues.reporterId, 4));
      expect(reported.every((i) => i.reporterId === 4)).toBe(true);
    });

    it('will not let somebody delete their own account', async () => {
      expect((await admin.delete('/users/1')).status).toBe(422);
    });

    it('needs manageUsers, and the profile route does not', async () => {
      expect((await manager.post('/users', {
        username: 'x', realName: 'X', email: 'x@example.com', accessLevel: 25,
      })).status).toBe(403);
      // Own profile is always allowed — but not the access level.
      expect((await reporter.patch('/me', { realName: 'Noah W' })).status).toBe(204);
      expect((await reporter.patch('/me', { accessLevel: 90 })).status).toBe(400);
    });

    it('validates preferences instead of accepting any shape', async () => {
      expect((await dev.patch('/me/prefs', { pageSize: 50 })).status).toBe(204);
      expect((await dev.patch('/me/prefs', { theme: 'neon' })).status).toBe(400);
      expect((await dev.patch('/me/prefs', { pageSize: 9999 })).status).toBe(400);
    });
  });

  describe('custom fields', () => {
    it('requires options for a list field', async () => {
      const r = await admin.post('/custom-fields', { name: 'Empty list', type: 'list', options: [] });
      expect(r.status).toBe(422);
    });

    it('creates, links to projects and reports usage', async () => {
      const created = await admin.post<{ id: number }>('/custom-fields', {
        name: 'Severity note', type: 'string', projectIds: [1, 2],
      });
      expect(created.status).toBe(201);

      const list = await admin.get<Array<{ id: number; projectIds: number[]; usage: number }>>('/custom-fields');
      const field = list.body.find((f) => f.id === created.body.id)!;
      expect(field.projectIds.sort()).toEqual([1, 2]);
      expect(field.usage).toBe(0);
    });

    it('reports how many values a delete destroyed', async () => {
      const before = await admin.get<Array<{ id: number; name: string; usage: number }>>('/custom-fields');
      const browser = before.body.find((f) => f.name === 'Browser')!;
      expect(browser.usage).toBeGreaterThan(0);

      const r = await admin.delete<{ removedValues: number }>(`/custom-fields/${browser.id}`);
      expect(r.status).toBe(200);
      expect(r.body.removedValues).toBe(browser.usage);
      expect((await admin.get<unknown[]>('/custom-fields')).body).toHaveLength(2);
    });

    it('needs manageCustomFields', async () => {
      expect((await manager.post('/custom-fields', { name: 'No', type: 'string' })).status).toBe(403);
    });
  });

  describe('notifications', () => {
    it('lists only the caller own, with the unread count agreeing', async () => {
      const mine = await dev.get<Array<{ id: number }>>('/notifications');
      expect(mine.status).toBe(200);
      expect(mine.body.length).toBeGreaterThan(0);

      const count = await dev.get<{ unread: number }>('/notifications/unread-count');
      expect(count.body.unread).toBe(3); // the seed leaves three unread for dkim
      // Nobody else's notifications appear.
      expect((await reporter.get<unknown[]>('/notifications')).body).toHaveLength(0);
    });

    it('will not let one user mark another notifications read', async () => {
      const mine = await dev.get<Array<{ id: number }>>('/notifications');
      const ids = mine.body.map((n) => n.id);

      // markRead in the frontend takes ids and trusts them. Scoped to the owner here.
      const attempt = await reporter.post<{ updated: number }>('/notifications/read', { ids });
      expect(attempt.status).toBe(200);
      expect(attempt.body.updated).toBe(0);
      expect((await dev.get<{ unread: number }>('/notifications/unread-count')).body.unread).toBe(3);

      const own = await dev.post<{ updated: number }>('/notifications/read', { ids });
      expect(own.body.updated).toBeGreaterThan(0);
      expect((await dev.get<{ unread: number }>('/notifications/unread-count')).body.unread).toBe(0);
    });

    it('withholds the excerpt of a private note from a reader who cannot see it', async () => {
      const id = (await dev.post<{ id: number }>('/issues', {
        projectId: 1, category: 'Documentation', summary: 'private mention',
      })).body.id;
      // eschulz is 40, below viewPrivate (55).
      await manager.post(`/issues/${id}/notes`, {
        body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: '6', label: 'eschulz' } }] }] },
        private: true,
      });

      const updater = new ApiClient();
      await updater.login('eschulz');
      const notifications = await updater.get<Array<{ type: string; excerpt: string | null }>>('/notifications');
      const mention = notifications.body.find((n) => n.type === 'mentioned');
      // Parity keeps the notification itself — the frontend sends it regardless — but the text of a
      // note this reader cannot open is not quoted back at them.
      expect(mention).toBeDefined();
      expect(mention!.excerpt).toBeNull();
    });
  });

  describe('admin', () => {
    it('round-trips the Db shape the frontend can import', async () => {
      const exported = await admin.get<Record<string, any>>('/admin/export');
      expect(exported.status).toBe(200);
      expect(exported.body.schema).toBe(1);
      expect(exported.body.issues).toHaveLength(80);
      // prefs and notify are re-nested from their columns.
      expect(Object.keys(exported.body.users[0].prefs.notify)).toHaveLength(5);
      // Categories, versions and members are embedded back onto the project.
      expect(exported.body.projects[0].categories.length).toBeGreaterThan(0);
      // Only one direction of each relationship: the importer re-derives the mirror.
      const linked = exported.body.issues.find((i: any) => i.relationships.length);
      expect(linked.relationships[0]).toHaveProperty('issueId');

      const imported = await admin.post<{ counts: Record<string, number> }>('/admin/import', exported.body);
      expect(imported.status).toBe(200);
      expect(imported.body.counts['issues']).toBe(80);

      const again = await admin.get<Record<string, any>>('/admin/export');
      expect(again.body.issues).toEqual(exported.body.issues);
      expect(again.body.workflow).toEqual(exported.body.workflow);
    });

    it('reports every integrity invariant as zero', async () => {
      const r = await admin.get<{ integrity: Record<string, number> }>('/admin/storage');
      expect(r.status).toBe(200);
      // Relationship symmetry is maintained transactionally rather than by a constraint, and the
      // counters incrementally, so both deserve an audit.
      for (const [name, value] of Object.entries(r.body.integrity)) {
        expect(value, name).toBe(0);
      }
    });

    it('needs manageUsers for export, import and storage', async () => {
      for (const client of [manager, dev, reporter]) {
        expect((await client.get('/admin/export')).status).toBe(403);
        expect((await client.get('/admin/storage')).status).toBe(403);
        expect((await client.post('/admin/import', {})).status).toBe(403);
      }
    });

    it('rejects an incompatible schema', async () => {
      const r = await admin.post('/admin/import', { schema: 2, users: [], issues: [] });
      expect(r.status).toBe(500);
    });
  });

  describe('operational surface', () => {
    it('echoes a correlation id and generates one when absent', async () => {
      // Set by an interceptor, not by pinoHttp.genReqId — under the Fastify adapter that hook is
      // not the one in play, so the header was silently never set.
      const response = await fetch('http://127.0.0.1:3101/api/health', {
        headers: { 'x-request-id': 'trace-me-123' },
      });
      expect(response.headers.get('x-request-id')).toBe('trace-me-123');

      const generated = await fetch('http://127.0.0.1:3101/api/health');
      expect(generated.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('reports readiness including the search indexes', async () => {
      const r = await new ApiClient().get<Record<string, unknown>>('/health/ready');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: 'ok', workflow: true });
    });

    it('streams server-sent events', async () => {
      const token = (dev as unknown as { accessToken: string }).accessToken;
      const controller = new AbortController();
      const response = await fetch('http://127.0.0.1:3101/api/events', {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const reader = response.body!.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain('event: ready');
      controller.abort();
    });

    it('needs authentication to stream', async () => {
      const response = await fetch('http://127.0.0.1:3101/api/events');
      expect(response.status).toBe(401);
    });
  });
});
