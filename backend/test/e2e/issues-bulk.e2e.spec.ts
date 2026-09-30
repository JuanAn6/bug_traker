import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { createSeed } from '../../src/shared/seed';
import { createDb, createPool, type Db } from '../../src/core/database/drizzle.service';
import * as s from '../../src/core/database/schema';
import { ingestDb } from '../../src/modules/admin/db-import';
import { ApiClient, startServer, stopServer } from './harness';

interface Bulk {
  applied: number[];
  unchanged: number[];
  skipped: Array<{ id: number; reason: string }>;
  undo?: { token: string; expiresAt: string };
}

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('bulk, links, notes and undo', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Db;
  let dev: ApiClient;       // dkim, 55
  let updater: ApiClient;   // eschulz, 40
  let reporter: ApiClient;  // nwilliams, 25
  let manager: ApiClient;   // mlopez, 70

  const issueRow = async (id: number) => {
    const [row] = await db.select().from(s.issues).where(eq(s.issues.id, id)).limit(1);
    return row!;
  };
  const tagsOf = async (id: number) =>
    (await db.select({ tag: s.issueTags.tag }).from(s.issueTags).where(eq(s.issueTags.issueId, id)))
      .map((t) => t.tag);

  const create = async (client: ApiClient, extra: Record<string, unknown> = {}) => {
    const r = await client.post<{ id: number }>('/issues', {
      projectId: 1, category: 'Documentation', summary: 'bulk subject', ...extra,
    });
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
      source: 'issues-bulk.e2e',
    });
    dev = new ApiClient(); await dev.login('dkim');
    updater = new ApiClient(); await updater.login('eschulz');
    reporter = new ApiClient(); await reporter.login('nwilliams');
    manager = new ApiClient(); await manager.login('mlopez');
  }, 60_000);

  describe('bulk operations', () => {
    it('accounts for every requested id in exactly one bucket', async () => {
      // The whole reason for a per-id response: the caller must be able to reconcile it against
      // what it sent. "Already in that state" is a third outcome, not a silent absence.
      const a = await create(dev, { priority: 'low' });
      const b = await create(dev, { priority: 'urgent' });
      const r = await dev.post<Bulk>('/issues/bulk', { ids: [a, b, 999999], priority: 'urgent' });

      expect(r.status).toBe(200);
      expect(r.body.applied).toEqual([a]);
      expect(r.body.unchanged).toEqual([b]);
      expect(r.body.skipped).toEqual([{ id: 999999, reason: 'errors.issueNotFound' }]);

      const all = new Set([...r.body.applied, ...r.body.unchanged, ...r.body.skipped.map((x) => x.id)]);
      expect(all).toEqual(new Set([a, b, 999999]));
    });

    it('does the same for a bulk status change', async () => {
      const open = await create(dev);
      const closed = await create(dev);
      await manager.post(`/issues/${closed}/status`, { status: 'closed' });

      const r = await manager.post<Bulk>('/issues/bulk/status', {
        ids: [open, closed, 999999],
        status: 'closed',
      });
      expect(r.body.applied).toEqual([open]);
      expect(r.body.unchanged).toEqual([closed]);
      expect(r.body.skipped.map((x) => x.id)).toEqual([999999]);
    });

    it('skips ids the caller may not touch instead of failing the whole request', async () => {
      const mine = await create(reporter);
      const theirs = await create(dev);
      // nwilliams (25) may edit their own issue but not somebody else's.
      const r = await reporter.post<Bulk>('/issues/bulk', {
        ids: [mine, theirs],
        priority: 'high',
      });
      expect(r.body.applied).toEqual([mine]);
      expect(r.body.skipped).toEqual([{ id: theirs, reason: 'errors.denied' }]);
    });

    it('enforces the per-field threshold across the whole selection', async () => {
      const a = await create(dev);
      const b = await create(dev);
      // eschulz (40) can edit, but move is 55 — so nothing is applied, not "some".
      const r = await updater.post<Bulk>('/issues/bulk/move', { ids: [a, b], projectId: 2 });
      expect(r.body.applied).toEqual([]);
      expect(r.body.skipped.map((x) => x.reason)).toEqual(['errors.denied', 'errors.denied']);
      expect((await issueRow(a)).projectId).toBe(1);
    });

    it('rejects a transition per issue rather than for the batch', async () => {
      const resolved = await create(dev);
      await dev.post(`/issues/${resolved}/status`, { status: 'resolved' });
      const fresh = await create(dev);

      // resolved -> new is forbidden; new -> new is a no-op.
      const r = await dev.post<Bulk>('/issues/bulk/status', { ids: [resolved, fresh], status: 'new' });
      expect(r.body.skipped).toEqual([{ id: resolved, reason: 'errors.transition' }]);
      expect(r.body.unchanged).toEqual([fresh]);
    });

    it('assigns in bulk, inheriting the auto-assign automation', async () => {
      const a = await create(dev);
      const b = await create(dev);
      const r = await dev.post<Bulk>('/issues/bulk/assign', { ids: [a, b], handlerId: 4 });
      expect(r.body.applied.sort()).toEqual([a, b].sort());
      // Assignment is a patch of handlerId, so applyPatch's auto-status still fires.
      expect((await issueRow(a)).status).toBe('assigned');
      expect((await issueRow(a)).handlerId).toBe(4);
    });

    it('bounds the selection size', async () => {
      const r = await dev.post('/issues/bulk', {
        ids: Array.from({ length: 1001 }, (_, i) => i + 1),
        priority: 'high',
      });
      expect(r.status).toBe(400);
    });
  });

  describe('soft delete and undo', () => {
    it('hides deleted issues and restores them with the token', async () => {
      const a = await create(dev);
      const b = await create(dev);

      const deleted = await manager.delete<Bulk>('/issues/bulk', { ids: [a, b] });
      expect(deleted.body.applied.sort()).toEqual([a, b].sort());
      expect(deleted.body.undo?.token).toBeTruthy();
      // Gone from both the detail and the list.
      expect((await dev.get(`/issues/${a}`)).status).toBe(404);
      const list = await dev.get<{ items: Array<{ id: number }> }>('/issues?hideStatus=&pageSize=200');
      expect(list.body.items.some((i) => i.id === a)).toBe(false);

      const undone = await manager.post<{ restored: number[] }>(`/undo/${deleted.body.undo!.token}`);
      expect(undone.status).toBe(200);
      expect(undone.body.restored.sort()).toEqual([a, b].sort());
      expect((await dev.get(`/issues/${a}`)).status).toBe(200);
    });

    it('restores a deleted issue notes along with it', async () => {
      const id = await create(dev);
      await dev.post(`/issues/${id}/notes`, { body: doc('will be back') });

      const deleted = await manager.delete<Bulk>('/issues/bulk', { ids: [id] });
      expect((await db.select().from(s.comments).where(and(eq(s.comments.issueId, id), isNull(s.comments.deletedAt)))))
        .toHaveLength(0);

      await manager.post(`/undo/${deleted.body.undo!.token}`);
      const notes = await dev.get<unknown[]>(`/issues/${id}/notes`);
      expect(notes.body).toHaveLength(1);
    });

    it('needs the delete threshold', async () => {
      const id = await create(dev);
      // delete is 70; dkim is 55.
      const r = await dev.delete<Bulk>('/issues/bulk', { ids: [id] });
      expect(r.body.applied).toEqual([]);
      expect(r.body.skipped).toEqual([{ id, reason: 'errors.denied' }]);
    });

    it('is single-use, owner-only and records the revert in history', async () => {
      const id = await create(dev, { priority: 'low' });
      const patched = await dev.post<Bulk>('/issues/bulk', { ids: [id], priority: 'urgent' });
      const token = patched.body.undo!.token;

      // Somebody else's token is not theirs to spend.
      expect((await manager.post(`/undo/${token}`)).status).toBe(403);

      expect((await dev.post(`/undo/${token}`)).status).toBe(200);
      expect((await issueRow(id)).priority).toBe('low');

      // Reverting is replayed through applyPatch, so the audit trail shows both directions
      // instead of the change disappearing as it would with a snapshot restore.
      const rows = await db
        .select({ field: s.historyEntries.field, old: s.historyEntries.oldValue, new: s.historyEntries.newValue })
        .from(s.historyEntries)
        .where(and(eq(s.historyEntries.issueId, id), eq(s.historyEntries.field, 'priority')));
      expect(rows).toEqual([
        { field: 'priority', old: 'low', new: 'urgent' },
        { field: 'priority', old: 'urgent', new: 'low' },
      ]);

      expect((await dev.post(`/undo/${token}`)).body).toMatchObject({ code: 'undo.alreadyUsed' });
    });

    it('404s an unknown token', async () => {
      expect((await dev.post('/undo/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    });
  });

  describe('clone', () => {
    it('resets the copy and links it both ways', async () => {
      const source = await create(dev, { priority: 'urgent', tags: ['regression'] });
      await dev.post(`/issues/${source}/status`, { status: 'resolved', fixedInVersion: '1.1' });

      const r = await dev.post<{ id: number }>(`/issues/${source}/clone`, {});
      expect(r.status).toBe(201);
      const copy = await issueRow(r.body.id);

      expect(copy.status).toBe('new');
      expect(copy.resolution).toBe('open');
      expect(copy.fixedInVersion).toBe('');
      expect(copy.reporterId).toBe(3);
      expect(copy.sticky).toBe(false);
      expect(copy.resolvedAt).toBeNull();
      // Carried over.
      expect(copy.priority).toBe('urgent');
      expect(await tagsOf(r.body.id)).toEqual(['regression']);

      // Symmetric related_to, so the link shows from either side.
      const links = await db
        .select()
        .from(s.issueRelationships)
        .where(eq(s.issueRelationships.issueId, r.body.id));
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ otherIssueId: source, type: 'related_to' });

      // Only the cloner monitors the copy.
      const monitors = await db
        .select({ userId: s.issueMonitors.userId })
        .from(s.issueMonitors)
        .where(eq(s.issueMonitors.issueId, r.body.id));
      expect(monitors.map((m) => m.userId)).toEqual([3]);
    });

    it('copies only the notes the cloner can actually read', async () => {
      const source = await create(dev);
      await dev.post(`/issues/${source}/notes`, { body: doc('public note') });
      await manager.post(`/issues/${source}/notes`, { body: doc('manager secret'), private: true });

      // eschulz is 40, below viewPrivate (55): the private note must not travel.
      const r = await updater.post<{ id: number }>(`/issues/${source}/clone`, { copyNotes: true });
      const copied = await db
        .select({ private: s.comments.private })
        .from(s.comments)
        .where(eq(s.comments.issueId, r.body.id));
      expect(copied).toHaveLength(1);
      expect(copied[0]!.private).toBe(false);
    });

    it('needs the report threshold on the source project', async () => {
      const source = await create(dev);
      // DATA is invisible to nwilliams, so the source itself 404s first.
      expect((await reporter.post(`/issues/${source}/clone`, {})).status).toBe(201);
    });
  });

  describe('relationships', () => {
    it('creates and removes both directions', async () => {
      const a = await create(dev);
      const b = await create(dev);

      expect((await dev.post(`/issues/${a}/relationships`, { type: 'parent_of', issueId: b })).status).toBe(204);

      const forward = await db.select().from(s.issueRelationships).where(eq(s.issueRelationships.issueId, a));
      const back = await db.select().from(s.issueRelationships).where(eq(s.issueRelationships.issueId, b));
      expect(forward[0]).toMatchObject({ otherIssueId: b, type: 'parent_of' });
      // The mirror image, from REVERSE_RELATIONSHIP.
      expect(back[0]).toMatchObject({ otherIssueId: a, type: 'child_of' });

      expect((await dev.delete(`/issues/${a}/relationships/${b}`)).status).toBe(204);
      expect(await db.select().from(s.issueRelationships).where(eq(s.issueRelationships.issueId, b))).toHaveLength(0);
    });

    it('allows at most one link per pair, whatever the type', async () => {
      const a = await create(dev);
      const b = await create(dev);
      await dev.post(`/issues/${a}/relationships`, { type: 'parent_of', issueId: b });
      const second = await dev.post(`/issues/${a}/relationships`, { type: 'related_to', issueId: b });
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ code: 'errors.relationExists' });
    });

    it('rejects a self-link', async () => {
      const a = await create(dev);
      const r = await dev.post(`/issues/${a}/relationships`, { type: 'related_to', issueId: a });
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ code: 'errors.selfRelation' });
    });

    it('needs manageRelationships to remove one, which the frontend never checks', async () => {
      const a = await create(dev);
      const b = await create(dev);
      await dev.post(`/issues/${a}/relationships`, { type: 'related_to', issueId: b });
      // manageRelationships is 40; nwilliams is 25.
      const r = await reporter.delete(`/issues/${a}/relationships/${b}`);
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ params: { action: 'manageRelationships' } });
    });

    it('will not link to an issue the caller cannot see', async () => {
      const mine = await create(reporter);
      const hidden = createSeed(Date.UTC(2026, 8, 29)).issues.find(
        (i) => i.projectId === 3 && i.reporterId !== 7 && i.handlerId !== 7,
      )!;
      // Otherwise linking becomes a way to probe for private ids.
      expect((await reporter.post(`/issues/${mine}/relationships`, { type: 'related_to', issueId: hidden.id })).status)
        .toBe(403);
    });
  });

  describe('monitors', () => {
    it('subscribes and unsubscribes idempotently', async () => {
      const id = await create(updater);
      expect((await dev.post(`/issues/${id}/monitors`, { on: true })).status).toBe(204);
      const after = await db.select().from(s.issueMonitors).where(eq(s.issueMonitors.issueId, id));
      expect(after.map((m) => m.userId)).toContain(3);

      // Repeating it writes no second row and no second history entry.
      await dev.post(`/issues/${id}/monitors`, { on: true });
      const rows = await db
        .select({ type: s.historyEntries.type })
        .from(s.historyEntries)
        .where(and(eq(s.historyEntries.issueId, id), eq(s.historyEntries.type, 'monitor_added')));
      expect(rows).toHaveLength(1);

      await dev.post(`/issues/${id}/monitors`, { on: false });
      const gone = await db.select().from(s.issueMonitors).where(eq(s.issueMonitors.issueId, id));
      expect(gone.map((m) => m.userId)).not.toContain(3);
    });

    it('needs monitorOthers to subscribe somebody else', async () => {
      const id = await create(dev);
      // monitorOthers is 55, evaluated globally — a project membership cannot grant it.
      expect((await reporter.post(`/issues/${id}/monitors`, { userId: 4, on: true })).status).toBe(403);
      expect((await dev.post(`/issues/${id}/monitors`, { userId: 4, on: true })).status).toBe(204);
    });

    it('leaves `updated` alone, as setMonitor does', async () => {
      const id = await create(dev);
      const before = (await issueRow(id)).updated.getTime();
      await dev.post(`/issues/${id}/monitors`, { userId: 5, on: true });
      // Documented parity: subscribing does not move an issue up "recently modified".
      expect((await issueRow(id)).updated.getTime()).toBe(before);
    });
  });

  describe('tags', () => {
    it('normalizes, appends in order and refreshes the derived columns', async () => {
      const id = await create(dev);
      expect((await dev.post(`/issues/${id}/tags`, { tag: '  Quick WIN ' })).status).toBe(204);
      await dev.post(`/issues/${id}/tags`, { tag: 'regression' });

      expect(await tagsOf(id)).toEqual(['quick-win', 'regression']);
      const row = await issueRow(id);
      // tagsSorted backs `ORDER BY tags`, and searchNorm includes the tags in the haystack.
      expect(row.tagsSorted).toBe('quick-win,regression');
      expect(row.searchNorm).toContain('quick-win');

      // A tag change DOES bump updated — addTag/removeTag do, unlike setMonitor.
      const found = await dev.get<{ items: Array<{ id: number }> }>(
        `/issues?tags=quick-win&hideStatus=&pageSize=200`,
      );
      expect(found.body.items.map((i) => i.id)).toContain(id);
    });

    it('is idempotent and removes cleanly', async () => {
      const id = await create(dev);
      await dev.post(`/issues/${id}/tags`, { tag: 'ux' });
      await dev.post(`/issues/${id}/tags`, { tag: 'UX' });
      expect(await tagsOf(id)).toEqual(['ux']);

      expect((await dev.delete(`/issues/${id}/tags/ux`)).status).toBe(204);
      expect(await tagsOf(id)).toEqual([]);
      expect((await issueRow(id)).tagsSorted).toBe('');
    });

    it('needs manageTags, which the frontend never checks', async () => {
      const id = await create(reporter);
      // manageTags is 40; nwilliams is 25 — even on their own issue.
      const r = await reporter.post(`/issues/${id}/tags`, { tag: 'nope' });
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ params: { action: 'manageTags' } });
    });
  });

  describe('notes', () => {
    it('creates, lists and sums time, hiding private notes', async () => {
      const id = await create(dev);
      await dev.post(`/issues/${id}/notes`, { body: doc('public'), timeSpent: 30 });
      await manager.post(`/issues/${id}/notes`, { body: doc('secret'), private: true, timeSpent: 60 });

      // eschulz is 40, below viewPrivate: sees one note and only its time.
      const asUpdater = await updater.get<Array<{ private: boolean }>>(`/issues/${id}/notes`);
      expect(asUpdater.body).toHaveLength(1);
      const time = await updater.get<{ total: number }>(`/issues/${id}/time`);
      expect(time.body.total).toBe(30);

      // dkim is 55: sees both.
      expect((await dev.get<unknown[]>(`/issues/${id}/notes`)).body).toHaveLength(2);
      expect((await dev.get<{ total: number }>(`/issues/${id}/time`)).body.total).toBe(90);
    });

    it('subscribes the author and bumps the note count', async () => {
      const id = await create(updater);
      await dev.post(`/issues/${id}/notes`, { body: doc('commenting subscribes me') });
      const monitors = await db
        .select({ userId: s.issueMonitors.userId })
        .from(s.issueMonitors)
        .where(eq(s.issueMonitors.issueId, id));
      expect(monitors.map((m) => m.userId)).toContain(3);
      expect((await issueRow(id)).noteCount).toBe(1);
    });

    it('tells `canEdit` per note so the UI can render its buttons', async () => {
      const id = await create(dev);
      await dev.post(`/issues/${id}/notes`, { body: doc('mine') });
      await manager.post(`/issues/${id}/notes`, { body: doc('theirs') });

      const notes = await dev.get<Array<{ authorId: number; canEdit: boolean }>>(`/issues/${id}/notes`);
      expect(notes.body.find((n) => n.authorId === 3)!.canEdit).toBe(true);
      // dkim is 55, editOthersNotes is 70.
      expect(notes.body.find((n) => n.authorId === 2)!.canEdit).toBe(false);
    });

    it('needs editOthersNotes to touch somebody else note', async () => {
      const id = await create(dev);
      const note = await manager.post<{ id: number }>(`/issues/${id}/notes`, { body: doc('managers') });

      const denied = await dev.patch(`/notes/${note.body.id}`, { timeSpent: 99 });
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ params: { action: 'editOthersNotes' } });
      expect((await dev.delete(`/notes/${note.body.id}`)).status).toBe(403);

      // The author can, and so can a manager.
      expect((await manager.patch(`/notes/${note.body.id}`, { timeSpent: 99 })).status).toBe(204);
    });

    it('logs an edit, and a privacy flip as a field change', async () => {
      const id = await create(dev);
      const note = await dev.post<{ id: number }>(`/issues/${id}/notes`, { body: doc('before') });
      await dev.patch(`/notes/${note.body.id}`, { body: doc('after'), private: true });

      const rows = await db
        .select({ type: s.historyEntries.type, field: s.historyEntries.field, old: s.historyEntries.oldValue, new: s.historyEntries.newValue })
        .from(s.historyEntries)
        .where(eq(s.historyEntries.issueId, id));
      expect(rows).toEqual(expect.arrayContaining([
        { type: 'note_edited', field: 'note', old: 'before', new: 'after' },
        // A privacy flip changes who can read it, so it is auditable on its own.
        { type: 'field', field: 'notePrivate', old: 'false', new: 'true' },
      ]));
    });

    it('does not move the issue up "recently modified" when a note is edited', async () => {
      const id = await create(dev);
      const note = await dev.post<{ id: number }>(`/issues/${id}/notes`, { body: doc('x') });
      const before = (await issueRow(id)).updated.getTime();
      await dev.patch(`/notes/${note.body.id}`, { body: doc('y') });
      // editNote() does not bump issue.updated. Parity, documented in the README.
      expect((await issueRow(id)).updated.getTime()).toBe(before);
    });

    it('keeps the note count honest when a note is deleted', async () => {
      const id = await create(dev);
      const note = await dev.post<{ id: number }>(`/issues/${id}/notes`, { body: doc('bye') });
      expect((await issueRow(id)).noteCount).toBe(1);

      expect((await dev.delete(`/notes/${note.body.id}`)).status).toBe(204);
      expect((await issueRow(id)).noteCount).toBe(0);
      expect((await dev.get<unknown[]>(`/issues/${id}/notes`)).body).toHaveLength(0);
    });

    it('needs addNote to comment at all', async () => {
      const hidden = createSeed(Date.UTC(2026, 8, 29)).issues.find((i) => i.projectId === 3)!;
      // DATA is invisible to nwilliams, so this 404s before the threshold is consulted.
      expect((await reporter.post(`/issues/${hidden.id}/notes`, { body: doc('x') })).status).toBe(404);
    });
  });
});
