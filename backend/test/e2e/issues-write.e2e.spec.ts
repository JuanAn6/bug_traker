import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { and, asc, eq } from 'drizzle-orm';
import { createSeed } from '../../src/shared/seed';
import { createDb, createPool, type Db } from '../../src/core/database/drizzle.service';
import * as s from '../../src/core/database/schema';
import { ingestDb } from '../../src/modules/admin/db-import';
import { ApiClient, startServer, stopServer } from './harness';

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const mention = (id: string, label: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id, label } }] }],
});

describe('issue writes', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Db;
  let dev: ApiClient;       // dkim, 55
  let updater: ApiClient;   // eschulz, 40
  let reporter: ApiClient;  // nwilliams, 25
  let manager: ApiClient;   // mlopez, 70

  const history = (issueId: number) =>
    db
      .select({ type: s.historyEntries.type, field: s.historyEntries.field, old: s.historyEntries.oldValue, new: s.historyEntries.newValue })
      .from(s.historyEntries)
      .where(eq(s.historyEntries.issueId, issueId))
      .orderBy(asc(s.historyEntries.id));

  const issueRow = async (id: number) => {
    const [row] = await db.select().from(s.issues).where(eq(s.issues.id, id)).limit(1);
    return row!;
  };

  const create = async (client: ApiClient, body: Record<string, unknown>) => {
    const r = await client.post<{ id: number }>('/issues', body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id;
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
    await ingestDb(db, createSeed(Date.UTC(2026, 8, 29)), {
      mode: 'replace',
      passwordHash: await hash('demo', { algorithm: 2 }),
      source: 'issues-write.e2e',
    });
    dev = new ApiClient(); await dev.login('dkim');
    updater = new ApiClient(); await updater.login('eschulz');
    reporter = new ApiClient(); await reporter.login('nwilliams');
    manager = new ApiClient(); await manager.login('mlopez');
  }, 60_000);

  describe('POST /issues', () => {
    it('applies the category default handler and auto-assigns, with one "created" row', async () => {
      // 'Backend API' in Web Portal has defaultHandlerId 3, and autoAssignStatus is on.
      const id = await create(dev, { projectId: 1, category: 'Backend API', summary: 'auto' });
      const row = await issueRow(id);
      expect(row.handlerId).toBe(3);
      expect(row.status).toBe('assigned');
      // Creation logs exactly one row: no per-field history for a brand-new issue.
      expect((await history(id)).map((h) => h.type)).toEqual(['created']);
    });

    it('leaves a category without a default handler unassigned and "new"', async () => {
      const id = await create(dev, { projectId: 1, category: 'Documentation', summary: 'manual' });
      const row = await issueRow(id);
      expect(row.handlerId).toBeNull();
      expect(row.status).toBe('new');
    });

    it('seeds monitors with the reporter and the handler, deduplicated', async () => {
      const id = await create(dev, { projectId: 1, category: 'Documentation', summary: 'm', handlerId: 4 });
      const monitors = await db
        .select({ userId: s.issueMonitors.userId })
        .from(s.issueMonitors)
        .where(eq(s.issueMonitors.issueId, id));
      expect(monitors.map((m) => m.userId).sort()).toEqual([3, 4]);

      // Reporter and handler being the same person must not produce two rows.
      const same = await create(dev, { projectId: 1, category: 'Documentation', summary: 'x', handlerId: 3 });
      const one = await db.select().from(s.issueMonitors).where(eq(s.issueMonitors.issueId, same));
      expect(one).toHaveLength(1);
    });

    it('normalizes tags the way addTag does', async () => {
      const id = await create(dev, {
        projectId: 1, category: 'Documentation', summary: 't',
        tags: ['Quick Win', '  REGRESSION  ', 'quick win'],
      });
      const tags = await db
        .select({ tag: s.issueTags.tag })
        .from(s.issueTags)
        .where(eq(s.issueTags.issueId, id))
        .orderBy(asc(s.issueTags.sortOrder));
      // trim + lowercase + hyphenate, then deduplicated.
      expect(tags.map((t) => t.tag)).toEqual(['quick-win', 'regression']);
    });

    it('notifies the handler but never the actor', async () => {
      const id = await create(dev, { projectId: 1, category: 'Documentation', summary: 'n', handlerId: 4 });
      const notifications = await db
        .select({ userId: s.notifications.userId, type: s.notifications.type })
        .from(s.notifications)
        .where(eq(s.notifications.issueId, id));
      expect(notifications).toEqual([{ userId: 4, type: 'assigned' }]);
    });

    it('notifies people mentioned in the rich fields', async () => {
      const id = await create(dev, {
        projectId: 1, category: 'Documentation', summary: 'mention',
        description: mention('5', 'loconnor'),
      });
      const notifications = await db
        .select({ userId: s.notifications.userId, type: s.notifications.type })
        .from(s.notifications)
        .where(and(eq(s.notifications.issueId, id), eq(s.notifications.type, 'mentioned')));
      expect(notifications.map((n) => n.userId)).toEqual([5]);
    });

    it('refuses a reporter forged by the client', async () => {
      // report() in the frontend takes `draft.reporterId ?? me` straight from the caller, so
      // anyone can claim to be anyone. Here it needs manageUsers.
      const forged = await dev.post('/issues', {
        projectId: 1, category: 'Documentation', summary: 'forged', reporterId: 1,
      });
      expect(forged.status).toBe(403);

      const admin = new ApiClient();
      await admin.login('administrator');
      const allowed = await admin.post<{ id: number }>('/issues', {
        projectId: 1, category: 'Documentation', summary: 'on behalf', reporterId: 7,
      });
      expect(allowed.status).toBe(201);
      expect((await issueRow(allowed.body.id)).reporterId).toBe(7);
    });

    it('refuses to file into a project the caller cannot see', async () => {
      // DATA is private and nwilliams is not a member. `report` has a threshold of 25, which
      // they clear — so without an explicit visibility check this succeeded. 404, not 403,
      // because saying "forbidden" would confirm the project exists.
      const denied = await reporter.post('/issues', { projectId: 3, category: 'ETL', summary: 'no' });
      expect(denied.status).toBe(404);
    });

    it('refuses a project that does not exist', async () => {
      expect((await dev.post('/issues', { projectId: 9999, category: 'x', summary: 'no' })).status).toBe(404);
    });

    it('rejects an unknown field rather than ignoring it', async () => {
      const r = await dev.post('/issues', {
        projectId: 1, category: 'Documentation', summary: 'x', sticky: true,
      });
      expect(r.status).toBe(400);
    });
  });

  describe('PATCH /issues/:id', () => {
    it('logs one row per changed field, in TRACKED order and not patch order', async () => {
      const id = await create(dev, { projectId: 1, category: 'Documentation', summary: 'Test issue' });
      const r = await dev.patch<{ changed: boolean }>(`/issues/${id}`, {
        priority: 'high',
        summary: 'Renamed',
      });
      expect(r.body.changed).toBe(true);
      // summary sits before priority in TRACKED, so it is logged first regardless of the body.
      expect((await history(id)).filter((h) => h.type === 'field').map((h) => [h.field, h.old, h.new]))
        .toEqual([
          ['summary', 'Test issue', 'Renamed'],
          ['priority', 'normal', 'high'],
        ]);
    });

    it('reports changed:false and touches nothing when the values already match', async () => {
      const id = await create(dev, { projectId: 1, category: 'Documentation', summary: 'Same' });
      const before = await issueRow(id);
      const r = await dev.patch<{ changed: boolean }>(`/issues/${id}`, { summary: 'Same' });
      expect(r.body.changed).toBe(false);
      expect((await issueRow(id)).updated.getTime()).toBe(before.updated.getTime());
    });

    it('checks each field against its own threshold, not one blanket permission', async () => {
      const id = await create(dev, { projectId: 1, category: 'Documentation', summary: 'thresholds' });
      // eschulz is an updater (40): enough to edit...
      expect((await updater.patch(`/issues/${id}`, { summary: 'edited' })).status).toBe(200);
      // ...but assign is 55 and move is 55.
      const assign = await updater.patch(`/issues/${id}`, { handlerId: 4 });
      expect(assign.status).toBe(403);
      expect(assign.body).toMatchObject({ params: { action: 'assign' } });
      const move = await updater.patch(`/issues/${id}`, { projectId: 2 });
      expect(move.status).toBe(403);
      expect(move.body).toMatchObject({ params: { action: 'move' } });
    });

    it('lets the reporter edit their own issue with only the report threshold', async () => {
      const mine = await create(reporter, { projectId: 1, category: 'Documentation', summary: 'mine' });
      // nwilliams is 25, below update (40), but canEditIssue widens it for the reporter.
      expect((await reporter.patch(`/issues/${mine}`, { summary: 'my edit' })).status).toBe(200);

      const theirs = await create(dev, { projectId: 1, category: 'Documentation', summary: 'theirs' });
      expect((await reporter.patch(`/issues/${theirs}`, { summary: 'nope' })).status).toBe(403);
    });

    it('remaps category, sprint and ALL THREE version fields on a move', async () => {
      const id = await create(dev, {
        projectId: 1, category: 'Documentation', summary: 'to move',
        productVersion: '1.0', targetVersion: '1.2', fixedInVersion: '1.1',
      });
      expect((await dev.patch(`/issues/${id}`, { projectId: 2 })).status).toBe(200);

      const row = await issueRow(id);
      expect(row.projectId).toBe(2);
      // MOB has none of those versions and no 'Documentation' category.
      expect(row.category).toBe('iOS');
      expect(row.productVersion).toBe('');
      expect(row.targetVersion).toBe('');
      expect(row.fixedInVersion).toBe('');
      expect(row.sprintId).toBeNull();

      // The destination really does have the category now — no orphan left behind.
      const [exists] = await db
        .select()
        .from(s.projectCategories)
        .where(and(eq(s.projectCategories.projectId, 2), eq(s.projectCategories.name, row.category)));
      expect(exists).toBeDefined();

      // And every repair is auditable.
      const fields = (await history(id)).filter((h) => h.type === 'field').map((h) => h.field);
      expect(fields).toContain('productVersion');
      expect(fields).toContain('fixedInVersion');
    });

    it('rejects a stale rowVersion instead of overwriting', async () => {
      const id = await create(dev, { projectId: 1, category: 'Documentation', summary: 'concurrent' });
      const version = (await issueRow(id)).rowVersion;

      expect((await dev.patch(`/issues/${id}`, { summary: 'first', rowVersion: version })).status).toBe(200);
      // The second caller read the same version and lost the race.
      const second = await dev.patch(`/issues/${id}`, { summary: 'second', rowVersion: version });
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ code: 'errors.stale' });
      expect((await issueRow(id)).summary).toBe('first');
    });

    it('404s for an issue the caller cannot see, before any permission check', async () => {
      const hidden = createSeed(Date.UTC(2026, 8, 29)).issues.find(
        (i) => i.projectId === 3 && i.reporterId !== 7 && i.handlerId !== 7,
      )!;
      expect((await reporter.patch(`/issues/${hidden.id}`, { summary: 'x' })).status).toBe(404);
    });
  });

  describe('POST /issues/:id/status', () => {
    it('settles the resolution to "fixed" and stamps the resolution marks', async () => {
      const id = await create(dev, { projectId: 1, category: 'Documentation', summary: 'resolve' });
      const r = await dev.post(`/issues/${id}/status`, { status: 'resolved' });
      expect(r.status).toBe(200);

      const row = await issueRow(id);
      expect(row.resolution).toBe('fixed');
      expect(row.resolvedAt).not.toBeNull();
      expect(row.firstResolvedAt).not.toBeNull();
    });

    it('marks it "reopened" on the way back out and keeps firstResolvedAt', async () => {
      const id = await create(dev, { projectId: 1, category: 'Documentation', summary: 'reopen' });
      await dev.post(`/issues/${id}/status`, { status: 'resolved' });
      const firstResolved = (await issueRow(id)).firstResolvedAt;

      await dev.post(`/issues/${id}/status`, { status: 'feedback' });
      const row = await issueRow(id);
      expect(row.resolution).toBe('reopened');
      expect(row.resolvedAt).toBeNull();
      // Never cleared: MTTR and "was ever resolved" still need it.
      expect(row.firstResolvedAt?.getTime()).toBe(firstResolved?.getTime());
      expect(row.reopenCount).toBe(1);
    });

    it('honours an explicit resolution instead of forcing "fixed"', async () => {
      const id = await create(dev, { projectId: 1, category: 'Documentation', summary: 'dup' });
      await dev.post(`/issues/${id}/status`, { status: 'resolved', resolution: 'duplicate' });
      expect((await issueRow(id)).resolution).toBe('duplicate');
    });

    it('rejects a transition the workflow forbids', async () => {
      const id = await create(dev, { projectId: 1, category: 'Documentation', summary: 'illegal' });
      await dev.post(`/issues/${id}/status`, { status: 'resolved' });
      const r = await dev.post(`/issues/${id}/status`, { status: 'new' });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ code: 'errors.transition', params: { from: 'resolved', to: 'new' } });
    });

    it('does not let the reporter exception bypass the changeStatus gate', async () => {
      const mine = await create(reporter, { projectId: 1, category: 'Documentation', summary: 'mine' });
      await manager.post(`/issues/${mine}/status`, { status: 'resolved' });
      // "the reporter may always reopen" widens the TARGET list inside allowedTransitions; it
      // does not lift the changeStatus threshold (40), which nwilliams at 25 does not clear.
      const r = await reporter.post(`/issues/${mine}/status`, { status: 'feedback' });
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ params: { action: 'changeStatus' } });
    });

    it('lets a reporter who DOES clear changeStatus reopen without the reopen threshold', async () => {
      // eschulz is an updater (40): clears changeStatus, not reopen (25 — which they also
      // clear). Use a manager-resolved issue reported by eschulz to exercise the identity path.
      const mine = await create(updater, { projectId: 1, category: 'Documentation', summary: 'reopen mine' });
      await manager.post(`/issues/${mine}/status`, { status: 'resolved' });
      expect((await updater.post(`/issues/${mine}/status`, { status: 'feedback' })).status).toBe(200);
    });

    it('writes the note in the same transaction as the status change', async () => {
      const id = await create(dev, { projectId: 1, category: 'Documentation', summary: 'with note' });
      const r = await dev.post<{ changed: boolean; noteId: number }>(`/issues/${id}/status`, {
        status: 'resolved',
        note: mention('4', 'srossi'),
        timeSpent: 30,
      });
      expect(r.status).toBe(200);
      expect(r.body.noteId).toBeGreaterThan(0);

      const row = await issueRow(id);
      expect(row.status).toBe('resolved');
      expect(row.noteCount).toBe(1);

      const types = (await history(id)).map((h) => h.type);
      expect(types).toContain('note_added');

      // The mentioned user is notified once, and not also through the generic 'note' fan-out.
      const forMentioned = await db
        .select({ type: s.notifications.type })
        .from(s.notifications)
        .where(and(eq(s.notifications.issueId, id), eq(s.notifications.userId, 4)));
      expect(forMentioned.map((n) => n.type)).toEqual(['mentioned']);
    });

    it('ignores an empty note rather than storing a blank comment', async () => {
      const id = await create(dev, { projectId: 1, category: 'Documentation', summary: 'blank' });
      const r = await dev.post<{ noteId?: number }>(`/issues/${id}/status`, {
        status: 'confirmed',
        note: doc('   '),
      });
      expect(r.body.noteId).toBeUndefined();
      expect((await issueRow(id)).noteCount).toBe(0);
    });

    it('needs the assign threshold to change the handler along the way', async () => {
      const id = await create(dev, { projectId: 1, category: 'Documentation', summary: 'assign too' });
      const r = await updater.post(`/issues/${id}/status`, { status: 'confirmed', handlerId: 4 });
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ params: { action: 'assign' } });
    });
  });

  describe('the outbox', () => {
    it('records an event per write, published only after the commit', async () => {
      const id = await create(dev, { projectId: 1, category: 'Documentation', summary: 'events' });
      await dev.patch(`/issues/${id}`, { summary: 'events changed' });

      const rows = await db.select({ topic: s.outbox.topic }).from(s.outbox);
      const topics = rows.map((r) => r.topic);
      expect(topics).toContain('issue.created');
      expect(topics).toContain('issue.updated');
    });

    it('writes no event for a rejected write', async () => {
      await db.delete(s.outbox);
      const id = await create(dev, { projectId: 1, category: 'Documentation', summary: 'rollback' });
      await db.delete(s.outbox);

      // A forbidden patch must leave nothing behind — the event is written inside the same
      // transaction as the change it describes.
      expect((await updater.patch(`/issues/${id}`, { projectId: 2 })).status).toBe(403);
      expect(await db.select().from(s.outbox)).toHaveLength(0);
    });
  });
});
