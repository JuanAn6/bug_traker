import { inject, Injectable } from '@angular/core';
import { BLOCKED_EXTENSIONS, MAX_FILE_SIZE } from './config';
import type { Attachment } from './models';
import { Auth } from './auth.service';
import { IssueActions } from './issue-actions.service';
import { Permissions } from './permissions.service';
import { Store } from './store.service';
import { Toasts } from './toast.service';
import { I18n } from '../i18n/i18n.service';

// ---------- minimal IndexedDB blob store ----------
const DB_NAME = 'bt-files';
const OS = 'blobs';
let dbPromise: Promise<IDBDatabase> | null = null;

function idb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(OS);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = run(db.transaction(OS, mode).objectStore(OS));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const blobStore = {
  put: (key: number, blob: Blob) => tx('readwrite', (s) => s.put(blob, key)),
  get: (key: number) => tx<Blob | undefined>('readonly', (s) => s.get(key)),
  delete: (key: number) => tx('readwrite', (s) => s.delete(key)),
  keys: () => tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys()),
  clear: () => tx('readwrite', (s) => s.clear()),
};

export interface UploadTarget { issueId: number; commentId: number | null; }

/**
 * One entry point for every file: ticket documents and files attached to notes share the same
 * entity (`commentId` marks the origin) and the same blob store.
 */
@Injectable({ providedIn: 'root' })
export class Attachments {
  private readonly store = inject(Store);
  private readonly auth = inject(Auth);
  private readonly perm = inject(Permissions);
  private readonly actions = inject(IssueActions);
  private readonly toasts = inject(Toasts);
  private readonly i18n = inject(I18n);
  private readonly urls = new Map<number, Promise<string>>();

  validate(file: File): string | null {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (BLOCKED_EXTENSIONS.includes(ext)) return this.i18n.t('files.blocked', { name: file.name });
    if (file.size > MAX_FILE_SIZE) return this.i18n.t('files.tooLarge', { name: file.name, max: this.i18n.bytes(MAX_FILE_SIZE) });
    return null;
  }

  get(id: number): Attachment | undefined {
    return this.store.attachments().find((a) => a.id === id);
  }

  /** Visible files of an issue (all versions), respecting private-note visibility. */
  forIssue(issueId: number): Attachment[] {
    const issue = this.store.issueMap().get(issueId);
    if (!issue) return [];
    const notes = new Map(this.store.comments().filter((c) => c.issueId === issueId).map((c) => [c.id, c]));
    return this.store.attachments().filter((a) => {
      if (a.issueId !== issueId) return false;
      const note = a.commentId ? notes.get(a.commentId) : undefined;
      return !note || this.perm.canSeeNote(note, issue.projectId);
    });
  }

  versions(a: Attachment): Attachment[] {
    const all = this.store.attachments();
    const chain: Attachment[] = [];
    let prev = a.previousVersionId;
    while (prev) {
      const p = all.find((x) => x.id === prev);
      if (!p) break;
      chain.push(p);
      prev = p.previousVersionId;
    }
    return chain;
  }

  async upload(files: File[], target: UploadTarget, description = ''): Promise<number[]> {
    if (target.issueId && !this.perm.can('uploadFile', this.store.issueMap().get(target.issueId)?.projectId)) {
      this.toasts.error(this.i18n.t('errors.denied'));
      return [];
    }
    const ids: number[] = [];
    for (const file of files) {
      const err = this.validate(file);
      if (err) { this.toasts.error(err); continue; }
      let meta!: Attachment;
      this.store.mutate((d) => {
        const id = this.store.nextId(d);
        meta = {
          id, blobId: id, issueId: target.issueId, commentId: target.commentId, name: file.name, description,
          mimeType: file.type || 'application/octet-stream', size: file.size, uploaderId: this.auth.me().id,
          date: new Date().toISOString(), version: 1, previousVersionId: null, current: true,
        };
        d.attachments.push(meta);
        if (target.issueId) this.actions.track(d, target.issueId, 'attachment_added', 'file', '', file.name, file.name);
      });
      try {
        await blobStore.put(meta.blobId, file);
        ids.push(meta.id);
      } catch (e) {
        this.store.mutate((d) => (d.attachments = d.attachments.filter((a) => a.id !== meta.id)));
        this.toasts.error(this.i18n.t('files.storeFailed', { name: file.name }));
      }
    }
    return ids;
  }

  async newVersion(att: Attachment, file: File) {
    const err = this.validate(file);
    if (err) { this.toasts.error(err); return; }
    let id = 0;
    this.store.mutate((d) => {
      id = this.store.nextId(d);
      d.attachments.find((a) => a.id === att.id)!.current = false;
      d.attachments.push({
        ...att, id, blobId: id, name: file.name, mimeType: file.type || att.mimeType, size: file.size,
        uploaderId: this.auth.me().id, date: new Date().toISOString(), version: att.version + 1, previousVersionId: att.id, current: true,
      });
      this.actions.track(d, att.issueId, 'attachment_version', 'file', `${att.name} v${att.version}`, `${file.name} v${att.version + 1}`, file.name);
    });
    await blobStore.put(id, file);
    this.toasts.success(this.i18n.t('files.versionUploaded', { name: file.name }));
  }

  rename(att: Attachment, name: string, description: string) {
    this.store.mutate((d) => {
      const a = d.attachments.find((x) => x.id === att.id)!;
      if (a.name !== name) this.actions.track(d, a.issueId, 'attachment_renamed', 'file', a.name, name);
      a.name = name;
      a.description = description;
    });
  }

  canDelete(att: Attachment): boolean {
    const issue = this.store.issueMap().get(att.issueId);
    return att.uploaderId === this.auth.user()?.id || this.perm.can('deleteOthersFiles', issue?.projectId);
  }

  /** Removes the document and all its previous versions. Blobs are purged later so undo works. */
  remove(att: Attachment) {
    const chain = new Set([att.id, ...this.versions(att).map((v) => v.id)]);
    const before = this.store.snapshot();
    this.store.mutate((d) => {
      d.attachments = d.attachments.filter((a) => !chain.has(a.id));
      if (att.issueId) this.actions.track(d, att.issueId, 'attachment_deleted', 'file', att.name, '');
    });
    this.toasts.success(this.i18n.t('files.deleted', { name: att.name }), {
      label: this.i18n.t('common.undo'), run: () => this.store.restore(before),
    });
  }

  /** Assign pending uploads (from unsaved forms) once the issue/note exists. */
  discardPending(ids: number[]) {
    this.store.mutate((d) => (d.attachments = d.attachments.filter((a) => !(ids.includes(a.id) && a.issueId === 0))));
  }

  url(att: Pick<Attachment, 'blobId'>): Promise<string> {
    let p = this.urls.get(att.blobId);
    if (!p) {
      p = blobStore.get(att.blobId).then((b) => (b ? URL.createObjectURL(b) : ''));
      this.urls.set(att.blobId, p);
    }
    return p;
  }

  async text(att: Attachment, max = 200_000): Promise<string> {
    const b = await blobStore.get(att.blobId);
    return b ? (await b.slice(0, max).text()) : '';
  }

  async download(att: Attachment) {
    const href = await this.url(att);
    if (!href) { this.toasts.error(this.i18n.t("files.missing", { name: att.name })); return; }
    const a = document.createElement('a');
    a.href = href;
    a.download = att.name;
    a.click();
  }

  async downloadAll(list: Attachment[]) {
    // ponytail: sequential native downloads; add a zip library if users want a single archive.
    for (const a of list) {
      await this.download(a);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Delete blobs no attachment references and stale pending uploads. */
  async purgeOrphans(): Promise<number> {
    if (typeof indexedDB === 'undefined') return 0;
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    if (this.store.attachments().some((a) => a.issueId === 0 && a.date < dayAgo)) {
      this.store.mutate((d) => (d.attachments = d.attachments.filter((a) => a.issueId !== 0 || a.date >= dayAgo)));
    }
    const used = new Set(this.store.attachments().map((a) => a.blobId));
    const keys = await blobStore.keys();
    const orphans = keys.filter((k) => !used.has(Number(k)));
    await Promise.all(orphans.map((k) => blobStore.delete(Number(k))));
    return orphans.length;
  }

  async clearAll() {
    this.store.mutate((d) => (d.attachments = []));
    await blobStore.clear();
    this.urls.forEach((p) => p.then((u) => u && URL.revokeObjectURL(u)));
    this.urls.clear();
  }

  static kind(mime: string, name = ''): 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'other' {
    if (mime.startsWith('image/')) return 'image';
    if (mime === 'application/pdf') return 'pdf';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('text/') || /json|xml|csv|javascript/.test(mime) || /\.(log|md|txt|ya?ml|ini|sql)$/i.test(name)) return 'text';
    return 'other';
  }
}
