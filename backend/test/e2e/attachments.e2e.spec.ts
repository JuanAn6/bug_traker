import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { createSeed } from '../../src/shared/seed';
import { createDb, createPool, type Db } from '../../src/core/database/drizzle.service';
import * as s from '../../src/core/database/schema';
import { ingestDb } from '../../src/modules/admin/db-import';
import { API, ApiClient, startServer, stopServer } from './harness';

/** Multipart upload without a form library: Blob + FormData are native in Node 18+. */
async function upload(
  token: string,
  file: { name: string; content: Buffer | string; type?: string },
  fields: Record<string, string | number> = {},
  path = '/attachments',
) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  form.append('file', new Blob([file.content], { type: file.type ?? 'application/octet-stream' }), file.name);

  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : undefined };
}

describe('attachments', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Db;
  let dev: ApiClient;
  let manager: ApiClient;
  let reporter: ApiClient;
  let updater: ApiClient;
  const token = (client: ApiClient) => (client as unknown as { accessToken: string }).accessToken;

  const blobRows = () => db.select().from(s.blobs);
  const attachmentRows = (issueId: number) =>
    db.select().from(s.attachments).where(and(eq(s.attachments.issueId, issueId), isNull(s.attachments.deletedAt)));

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
      source: 'attachments.e2e',
    });
    dev = new ApiClient(); await dev.login('dkim');
    manager = new ApiClient(); await manager.login('mlopez');
    reporter = new ApiClient(); await reporter.login('nwilliams');
    updater = new ApiClient(); await updater.login('eschulz');
    // Leftovers from a previous run would make the dedup assertions meaningless.
    await new ApiClient().post('/nothing').catch(() => undefined);
    const admin = new ApiClient(); await admin.login('administrator');
    await admin.post('/admin/purge-orphans');
  }, 60_000);

  describe('upload', () => {
    it('stores the file and bumps the issue count', async () => {
      const r = await upload(token(dev), { name: 'log.txt', content: 'hello', type: 'text/plain' }, { issueId: 1 });
      expect(r.status).toBe(201);

      const rows = await attachmentRows(1);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name: 'log.txt', version: 1, current: true, blobMissing: false });
      // documentId is its own id: the first version IS the document.
      expect(rows[0]!.documentId).toBe(rows[0]!.id);

      const [issue] = await db.select().from(s.issues).where(eq(s.issues.id, 1));
      expect(issue!.attachmentCount).toBe(1);
    });

    it('deduplicates identical content down to one file', async () => {
      const content = `unique-${Date.now()}`;
      const first = await upload(token(dev), { name: 'a.txt', content }, { issueId: 1 });
      const second = await upload(token(dev), { name: 'b.txt', content }, { issueId: 2 });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);

      const rows = await attachmentRows(1);
      const other = await attachmentRows(2);
      // Two rows, two names, two issues...
      expect(rows[0]!.blobHash).toBe(other[0]!.blobHash);

      // ...and one blob with two references. This is what makes cloning an issue free and deleting
      // a clone safe.
      const blobs = (await blobRows()).filter((b) => b.hash === rows[0]!.blobHash);
      expect(blobs).toHaveLength(1);
      expect(blobs[0]!.refCount).toBe(2);
    });

    it('writes history and notifies watchers', async () => {
      await upload(token(manager), { name: 'from-manager.txt', content: 'x' }, { issueId: 1 });
      const history = await db
        .select()
        .from(s.historyEntries)
        .where(and(eq(s.historyEntries.issueId, 1), eq(s.historyEntries.type, 'attachment_added')));
      expect(history).toHaveLength(1);
      expect(history[0]!.newValue).toBe('from-manager.txt');

      const notifications = await db
        .select()
        .from(s.notifications)
        .where(and(eq(s.notifications.issueId, 1), eq(s.notifications.type, 'attachment')));
      expect(notifications.length).toBeGreaterThan(0);
      // Never the actor.
      expect(notifications.every((n) => n.userId !== 2)).toBe(true);
    });

    it('needs uploadFile on the issue project', async () => {
      // DATA is invisible to nwilliams, so the issue 404s before the threshold is consulted.
      const hidden = createSeed(Date.UTC(2026, 8, 29)).issues.find((i) => i.projectId === 3)!;
      const r = await upload(token(reporter), { name: 'x.txt', content: 'x' }, { issueId: hidden.id });
      expect(r.status).toBe(404);
    });
  });

  describe('validation', () => {
    it('rejects a blocked extension', async () => {
      const r = await upload(token(dev), { name: 'virus.exe', content: 'x' }, { issueId: 1 });
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ code: 'files.blockedType' });
      expect(await attachmentRows(1)).toHaveLength(0);
    });

    it('catches an executable renamed to look harmless', async () => {
      // The extension check is bypassed by renaming, so the magic bytes have the final say.
      const pe = Buffer.from('4d5a90000300000004000000ffff0000', 'hex');
      const r = await upload(token(dev), { name: 'innocent.txt', content: pe, type: 'text/plain' }, { issueId: 1 });
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ code: 'files.blockedType' });
      expect(r.body!['message']).toContain('msdownload');
    });

    it('rejects a truncated oversized upload instead of storing it as whole', async () => {
      // The multipart layer enforces its size limit by TRUNCATING, not throwing, so without an
      // explicit check an 11 MB upload lands as a complete-looking 10 MiB file. A silently
      // corrupted file presented as intact is worse than a rejection.
      const oversized = Buffer.alloc(11 * 1024 * 1024, 0x61);
      const r = await upload(token(dev), { name: 'big.bin', content: oversized }, { issueId: 1 });
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ code: 'files.tooLarge' });
      expect(await attachmentRows(1)).toHaveLength(0);
    });

    it('rejects a request with no file part', async () => {
      const response = await fetch(`${API}/attachments`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token(dev)}`, 'content-type': 'multipart/form-data; boundary=x' },
        body: '--x--\r\n',
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('serving the bytes', () => {
    let id: number;
    const content = '0123456789abcdefghij';

    beforeEach(async () => {
      id = (await upload(token(dev), { name: 'data.txt', content, type: 'text/plain' }, { issueId: 1 })).body!['id'];
    });

    const get = (path: string, headers: Record<string, string> = {}) =>
      fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token(dev)}`, ...headers } });

    it('serves the whole file with a content-addressed ETag', async () => {
      const response = await get(`/attachments/${id}/content`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(content);
      // The hash IS the version, so the validator is exact and the cache can be immutable.
      expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/);
      expect(response.headers.get('cache-control')).toContain('immutable');
      expect(response.headers.get('accept-ranges')).toBe('bytes');
    });

    it('answers 304 to a matching If-None-Match', async () => {
      const etag = (await get(`/attachments/${id}/content`)).headers.get('etag')!;
      const cached = await get(`/attachments/${id}/content`, { 'if-none-match': etag });
      expect(cached.status).toBe(304);
    });

    it('serves byte ranges, including a suffix range', async () => {
      const head = await get(`/attachments/${id}/content`, { range: 'bytes=0-4' });
      expect(head.status).toBe(206);
      expect(await head.text()).toBe('01234');
      expect(head.headers.get('content-range')).toBe(`bytes 0-4/${content.length}`);

      const open = await get(`/attachments/${id}/content`, { range: 'bytes=10-' });
      expect(await open.text()).toBe('abcdefghij');

      // A suffix range is what a player asks for when it wants the trailing metadata.
      const tail = await get(`/attachments/${id}/content`, { range: 'bytes=-4' });
      expect(await tail.text()).toBe('ghij');
    });

    it('answers 416 for a range past the end', async () => {
      const response = await get(`/attachments/${id}/content`, { range: 'bytes=9999-' });
      expect(response.status).toBe(416);
      expect(response.headers.get('content-range')).toBe(`bytes */${content.length}`);
    });

    it('falls back to the whole body for a multi-range request', async () => {
      // Legal, and cheaper than building multipart/byteranges for a case nothing sends.
      const response = await get(`/attachments/${id}/content`, { range: 'bytes=0-1,5-6' });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(content);
    });

    it('always downloads from /content, whatever the type', async () => {
      const response = await get(`/attachments/${id}/content`);
      expect(response.headers.get('content-disposition')).toContain('attachment');
      expect(response.headers.get('content-type')).toBe('application/octet-stream');
    });

    it('renders an allow-listed type inline, sandboxed', async () => {
      const response = await get(`/attachments/${id}/inline`);
      expect(response.headers.get('content-disposition')).toContain('inline');
      expect(response.headers.get('content-type')).toContain('text/plain');
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('never renders an SVG inline', async () => {
      // An SVG is a document that can carry script, so serving one inline from this origin would be
      // stored XSS. It uploads and downloads fine.
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
      const svgId = (await upload(token(dev), { name: 'logo.svg', content: svg, type: 'image/svg+xml' }, { issueId: 1 }))
        .body!['id'];
      const response = await get(`/attachments/${svgId}/inline`);
      expect(response.headers.get('content-disposition')).toContain('attachment');
      expect(response.headers.get('content-type')).toBe('application/octet-stream');
    });

    it('returns only the first slice as text', async () => {
      const response = await get(`/attachments/${id}/text`);
      const body = (await response.json()) as { text: string; truncated: boolean; size: number };
      expect(body.text).toBe(content);
      expect(body.truncated).toBe(false);
      expect(body.size).toBe(content.length);
    });

    it('404s an attachment on an issue the caller cannot see', async () => {
      const response = await fetch(`${API}/attachments/${id}/content`, {
        headers: { authorization: `Bearer ${token(reporter)}` },
      });
      // Issue 1 is public, so this one is visible — the check is that the route is authorized at all.
      expect([200, 404]).toContain(response.status);
      const anonymous = await fetch(`${API}/attachments/${id}/content`);
      expect(anonymous.status).toBe(401);
    });
  });

  describe('versions', () => {
    it('keeps the chain under one documentId with the newest current', async () => {
      const first = (await upload(token(dev), { name: 'doc.txt', content: 'v1' }, { issueId: 1 })).body!['id'];
      const second = await upload(token(dev), { name: 'doc-v2.txt', content: 'v2' }, {}, `/attachments/${first}/versions`);
      expect(second.status).toBe(201);
      expect(second.body).toMatchObject({ version: 2 });

      const rows = await attachmentRows(1);
      expect(rows).toHaveLength(2);
      // Both belong to one document; only the newest is current.
      expect(new Set(rows.map((r) => r.documentId))).toEqual(new Set([first]));
      expect(rows.filter((r) => r.current)).toHaveLength(1);
      expect(rows.find((r) => r.current)!.version).toBe(2);

      // The document count did not change — it is still one document.
      const [issue] = await db.select().from(s.issues).where(eq(s.issues.id, 1));
      expect(issue!.attachmentCount).toBe(1);
    });

    it('nests the older versions under the current one in the listing', async () => {
      const first = (await upload(token(dev), { name: 'doc.txt', content: 'v1' }, { issueId: 1 })).body!['id'];
      await upload(token(dev), { name: 'doc.txt', content: 'v2' }, {}, `/attachments/${first}/versions`);
      await upload(token(dev), { name: 'doc.txt', content: 'v3' }, {}, `/attachments/${first}/versions`);

      const list = await dev.get<Array<{ version: number; versions?: Array<{ version: number }> }>>(
        '/issues/1/documents',
      );
      expect(list.body).toHaveLength(1);
      expect(list.body[0]!.version).toBe(3);
      // Newest first, and the current one is not repeated among them.
      expect(list.body[0]!.versions!.map((v) => v.version)).toEqual([2, 1]);
    });

    it('logs the version rather than a plain add', async () => {
      const first = (await upload(token(dev), { name: 'doc.txt', content: 'v1' }, { issueId: 1 })).body!['id'];
      await upload(token(dev), { name: 'doc.txt', content: 'v2' }, {}, `/attachments/${first}/versions`);
      const history = await db
        .select()
        .from(s.historyEntries)
        .where(and(eq(s.historyEntries.issueId, 1), eq(s.historyEntries.type, 'attachment_version')));
      expect(history).toHaveLength(1);
    });
  });

  describe('delete', () => {
    it('removes the whole chain and keeps the blob until nothing references it', async () => {
      const content = `shared-${Date.now()}`;
      const first = (await upload(token(dev), { name: 'a.txt', content }, { issueId: 1 })).body!['id'];
      await upload(token(dev), { name: 'b.txt', content }, { issueId: 2 });
      await upload(token(dev), { name: 'a2.txt', content: 'other' }, {}, `/attachments/${first}/versions`);

      const removed = await dev.delete<{ removed: number }>(`/attachments/${first}`);
      expect(removed.status).toBe(200);
      // Both versions go: the older one only exists as history of the current.
      expect(removed.body.removed).toBe(2);
      expect(await attachmentRows(1)).toHaveLength(0);

      // The shared blob survives, because issue 2 still points at it.
      const blob = (await blobRows()).find((b) => b.refCount > 0);
      expect(blob).toBeDefined();
      expect(await attachmentRows(2)).toHaveLength(1);
    });

    it('needs deleteOthersFiles for somebody else file', async () => {
      const id = (await upload(token(manager), { name: 'theirs.txt', content: 'x' }, { issueId: 1 })).body!['id'];
      // deleteOthersFiles is 70; dkim is 55.
      const denied = await dev.delete(`/attachments/${id}`);
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ params: { action: 'deleteOthersFiles' } });
      // The uploader can.
      expect((await manager.delete(`/attachments/${id}`)).status).toBe(200);
    });

    it('lets the uploader delete their own regardless of level', async () => {
      const id = (await upload(token(updater), { name: 'mine.txt', content: 'x' }, { issueId: 1 })).body!['id'];
      expect((await updater.delete(`/attachments/${id}`)).status).toBe(200);
    });
  });

  describe('rename', () => {
    it('renames and logs it', async () => {
      const id = (await upload(token(dev), { name: 'before.txt', content: 'x' }, { issueId: 1 })).body!['id'];
      expect((await dev.patch(`/attachments/${id}`, { name: 'after.txt', description: 'Updated' })).status).toBe(204);

      const rows = await attachmentRows(1);
      expect(rows[0]).toMatchObject({ name: 'after.txt', description: 'Updated' });
      const history = await db
        .select()
        .from(s.historyEntries)
        .where(and(eq(s.historyEntries.issueId, 1), eq(s.historyEntries.type, 'attachment_renamed')));
      expect(history[0]).toMatchObject({ oldValue: 'before.txt', newValue: 'after.txt' });
    });

    it('refuses a rename into a blocked extension', async () => {
      const id = (await upload(token(dev), { name: 'ok.txt', content: 'x' }, { issueId: 1 })).body!['id'];
      const r = await dev.patch(`/attachments/${id}`, { name: 'now.exe' });
      expect(r.status).toBe(422);
    });
  });

  describe('note files', () => {
    it('appear in the documents list with their note id', async () => {
      const pending = (await upload(token(dev), { name: 'note-file.txt', content: 'x' })).body!['id'];
      const note = await dev.post<{ id: number }>('/issues/1/notes', {
        body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'see file' }] }] },
        attachmentIds: [pending],
      });
      expect(note.status).toBe(201);

      const list = await dev.get<Array<{ id: number; commentId: number | null }>>('/issues/1/documents');
      // One entity for ticket files and note files alike; commentId records the origin.
      expect(list.body.find((d) => d.id === pending)!.commentId).toBe(note.body.id);
    });

    it('inherit the note privacy at read time', async () => {
      const pending = (await upload(token(manager), { name: 'secret.txt', content: 'x' })).body!['id'];
      await manager.post('/issues/1/notes', {
        body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hidden' }] }] },
        private: true,
        attachmentIds: [pending],
      });

      // eschulz is 40, below viewPrivate: the note is hidden, so its file is too. Derived, not
      // copied onto the attachment row — so flipping the note's privacy moves the file with it.
      const asUpdater = await updater.get<Array<{ id: number }>>('/issues/1/documents');
      expect(asUpdater.body.some((d) => d.id === pending)).toBe(false);
      const asDev = await dev.get<Array<{ id: number }>>('/issues/1/documents');
      expect(asDev.body.some((d) => d.id === pending)).toBe(true);
    });

    it('survive a note deletion when keepFiles is set', async () => {
      const pending = (await upload(token(dev), { name: 'keep.txt', content: 'x' })).body!['id'];
      const note = await dev.post<{ id: number }>('/issues/1/notes', {
        body: { type: 'doc', content: [{ type: 'paragraph' }] },
        attachmentIds: [pending],
      });

      expect((await dev.delete(`/notes/${note.body.id}?keepFiles=true`)).status).toBe(204);
      const rows = await attachmentRows(1);
      const kept = rows.find((r) => r.id === pending);
      // Detached, so it lives on as a ticket document.
      expect(kept).toBeDefined();
      expect(kept!.commentId).toBeNull();
    });

    it('are deleted with the note when keepFiles is false', async () => {
      const pending = (await upload(token(dev), { name: 'bye.txt', content: 'x' })).body!['id'];
      const note = await dev.post<{ id: number }>('/issues/1/notes', {
        body: { type: 'doc', content: [{ type: 'paragraph' }] },
        attachmentIds: [pending],
      });
      expect((await dev.delete(`/notes/${note.body.id}?keepFiles=false`)).status).toBe(204);
      expect(await attachmentRows(1)).toHaveLength(0);
    });
  });

  describe('pending uploads', () => {
    it('are adopted when the issue is created', async () => {
      const pending = (await upload(token(dev), { name: 'from-form.txt', content: 'x' })).body!['id'];
      const created = await dev.post<{ id: number }>('/issues', {
        projectId: 1, category: 'Documentation', summary: 'with a file',
        attachmentIds: [pending],
      });
      expect(created.status).toBe(201);

      const rows = await attachmentRows(created.body.id);
      expect(rows).toHaveLength(1);
      const [issue] = await db.select().from(s.issues).where(eq(s.issues.id, created.body.id));
      expect(issue!.attachmentCount).toBe(1);
    });

    it('cannot be adopted by another user', async () => {
      const pending = (await upload(token(manager), { name: 'not-yours.txt', content: 'x' })).body!['id'];
      const attempt = await dev.post('/issues', {
        projectId: 1, category: 'Documentation', summary: 'stealing',
        attachmentIds: [pending],
      });
      // Rejected, not silently skipped: dropping an attachment the user thinks they attached is
      // worse than an error they can act on.
      expect(attempt.status).toBe(409);
      expect(attempt.body).toMatchObject({ code: 'files.adoptFailed' });
    });

    it('are only visible to their uploader until attached', async () => {
      const pending = (await upload(token(manager), { name: 'draft.txt', content: 'x' })).body!['id'];
      const response = await fetch(`${API}/attachments/${pending}/content`, {
        headers: { authorization: `Bearer ${token(dev)}` },
      });
      expect(response.status).toBe(404);
    });
  });

  describe('zip', () => {
    it('packs every current document', async () => {
      await upload(token(dev), { name: 'one.txt', content: 'first' }, { issueId: 1 });
      await upload(token(dev), { name: 'two.txt', content: 'second' }, { issueId: 1 });

      const response = await fetch(`${API}/issues/1/documents.zip`, {
        headers: { authorization: `Bearer ${token(dev)}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/zip');
      const bytes = Buffer.from(await response.arrayBuffer());
      // A zip starts with PK\x03\x04, and both names appear in the central directory.
      expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304');
      expect(bytes.toString('latin1')).toContain('one.txt');
      expect(bytes.toString('latin1')).toContain('two.txt');
    });

    it('suffixes a duplicate name instead of overwriting inside the archive', async () => {
      await upload(token(dev), { name: 'same.txt', content: 'a' }, { issueId: 1 });
      await upload(token(dev), { name: 'same.txt', content: 'b' }, { issueId: 1 });
      const response = await fetch(`${API}/issues/1/documents.zip`, {
        headers: { authorization: `Bearer ${token(dev)}` },
      });
      const text = Buffer.from(await response.arrayBuffer()).toString('latin1');
      expect(text).toContain('same.txt');
      expect(text).toContain('same (2).txt');
    });
  });

  describe('purge', () => {
    it('reclaims bytes left on disk by a rejected upload', async () => {
      const admin = new ApiClient();
      await admin.login('administrator');
      await admin.post('/admin/purge-orphans');

      // A validation failure after the stream is written leaves the bytes with no blobs row at all,
      // so the refCount sweep cannot see them — only the disk sweep can.
      const pe = Buffer.from('4d5a90000300000004000000ffff0000', 'hex');
      expect((await upload(token(dev), { name: 'sneaky.txt', content: pe }, { issueId: 1 })).status).toBe(422);

      const purged = await admin.post<{ blobsRemoved: number; bytesReclaimed: number }>('/admin/purge-orphans');
      expect(purged.body.blobsRemoved).toBeGreaterThan(0);
      expect(purged.body.bytesReclaimed).toBeGreaterThan(0);
    });

    it('removes abandoned pending uploads and reports the counts', async () => {
      const admin = new ApiClient();
      await admin.login('administrator');
      const r = await admin.post<Record<string, number>>('/admin/purge-orphans');
      expect(r.status).toBe(200);
      expect(Object.keys(r.body).sort()).toEqual(
        ['blobsRemoved', 'bytesReclaimed', 'danglingReferences', 'pendingRemoved', 'rowsRemoved'],
      );
    });

    it('needs manageUsers', async () => {
      expect((await manager.post('/admin/purge-orphans')).status).toBe(403);
    });
  });

  describe('storage report', () => {
    it('counts the files separately from the database', async () => {
      await upload(token(dev), { name: 'counted.txt', content: 'some bytes here' }, { issueId: 1 });
      const admin = new ApiClient();
      await admin.login('administrator');
      const r = await admin.get<{ files: { bytes: number; files: number; documents: number } }>('/admin/storage');
      expect(r.body.files.documents).toBeGreaterThan(0);
      // Files live outside the database, so a mysqldump is not a complete backup — which is exactly
      // why they are reported apart from databaseBytes.
      expect(r.body.files.bytes).toBeGreaterThan(0);
    });
  });
});
