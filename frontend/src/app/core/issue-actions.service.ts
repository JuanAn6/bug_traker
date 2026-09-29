import { inject, Injectable } from '@angular/core';
import { REVERSE_RELATIONSHIP, isResolved, statusRank } from './config';
import type {
  Comment, Db, HistoryEntry, HistoryType, Issue, NotifyEvent, RelationshipType, RichText, Status,
} from './models';
import { Auth } from './auth.service';
import { Permissions } from './permissions.service';
import { mentionedUserIds, plainText } from './rich';
import { Store } from './store.service';
import { Toasts } from './toast.service';
import { I18n } from '../i18n/i18n.service';

export type IssueDraft = Omit<Issue, 'id' | 'created' | 'updated' | 'monitorIds' | 'relationships' | 'reporterId' | 'sticky'>
  & Partial<Pick<Issue, 'reporterId' | 'sticky'>>;

/** Fields whose changes are written to history; rich fields are logged as a plain-text excerpt. */
const TRACKED: (keyof Issue)[] = [
  'projectId', 'sprintId', 'category', 'summary', 'status', 'resolution', 'priority', 'severity', 'reproducibility',
  'platform', 'os', 'osBuild', 'productVersion', 'targetVersion', 'fixedInVersion', 'reporterId', 'handlerId',
  'viewState', 'sticky', 'dueDate', 'estimate', 'storyPoints', 'description', 'stepsToReproduce', 'additionalInfo',
];
const RICH: (keyof Issue)[] = ['description', 'stepsToReproduce', 'additionalInfo'];

export interface StatusChange {
  resolution?: Issue['resolution'];
  fixedInVersion?: string;
  handlerId?: number | null;
  note?: RichText;
  notePrivate?: boolean;
  timeSpent?: number;
}

const now = () => new Date().toISOString();
const str = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? plainText(v as RichText).slice(0, 120) : String(v));

@Injectable({ providedIn: 'root' })
export class IssueActions {
  private readonly store = inject(Store);
  private readonly auth = inject(Auth);
  private readonly perm = inject(Permissions);
  private readonly toasts = inject(Toasts);
  private readonly i18n = inject(I18n);

  private get me() {
    return this.auth.me().id;
  }

  // ---------- helpers usable inside a mutate() recipe ----------

  private hist(d: Db, issueId: number, type: HistoryType, field = '', old = '', nw = '', date = now()) {
    const e: HistoryEntry = { id: this.store.nextId(d), issueId, userId: this.me, date, type, field, old, new: nw };
    d.history.push(e);
  }

  private notify(d: Db, issue: Issue, type: NotifyEvent, recipients: Iterable<number>, text: string) {
    for (const uid of new Set(recipients)) {
      if (uid === this.me) continue;
      const u = d.users.find((x) => x.id === uid);
      if (!u?.enabled || !u.prefs.notify[type]) continue;
      d.notifications.push({
        id: this.store.nextId(d), userId: uid, issueId: issue.id, actorId: this.me, type, text, read: false, date: now(),
      });
    }
  }

  private watchers(i: Issue) {
    return [...i.monitorIds, i.reporterId, ...(i.handlerId ? [i.handlerId] : [])];
  }

  /** For other services mutating issue-related data (attachments) inside their own mutate(). */
  track(d: Db, issueId: number, type: HistoryType, field: string, old: string, nw: string, notifyText?: string) {
    this.hist(d, issueId, type, field, old, nw);
    const issue = d.issues.find((i) => i.id === issueId);
    if (!issue) return;
    issue.updated = now();
    if (notifyText) this.notify(d, issue, 'attachment', this.watchers(issue), notifyText);
  }

  /** Apply a patch to a draft issue, log every changed field and apply workflow automations. */
  private applyPatch(d: Db, issue: Issue, patch: Partial<Issue>) {
    const wf = d.workflow;
    const next = { ...issue, ...patch };
    if (patch.handlerId !== undefined && patch.handlerId && patch.handlerId !== issue.handlerId
        && wf.autoAssignStatus && patch.status === undefined && statusRank(issue.status) < statusRank('assigned')) {
      next.status = 'assigned';
    }
    if (next.status !== issue.status) {
      if (isResolved(next.status) && !isResolved(issue.status) && (next.resolution === 'open' || next.resolution === 'reopened')) {
        next.resolution = 'fixed';
      }
      if (!isResolved(next.status) && isResolved(issue.status) && patch.resolution === undefined) next.resolution = 'reopened';
    }
    let changed = false;
    for (const f of TRACKED) {
      const a = issue[f];
      const b = next[f];
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      changed = true;
      this.hist(d, issue.id, 'field', f, str(a), str(b));
    }
    if (!changed) return false;
    if (next.handlerId && next.handlerId !== issue.handlerId) {
      if (!next.monitorIds.includes(next.handlerId)) next.monitorIds = [...next.monitorIds, next.handlerId];
      this.notify(d, next, 'assigned', [next.handlerId], next.summary);
    }
    if (next.status !== issue.status) {
      this.notify(d, next, 'status', this.watchers(next),
        `${this.i18n.t('status.' + issue.status)} → ${this.i18n.t('status.' + next.status)}: ${next.summary}`);
    }
    next.updated = now();
    Object.assign(issue, next);
    return true;
  }

  private withUndo(message: string, fn: () => void) {
    const before = this.store.snapshot();
    fn();
    this.toasts.success(message, { label: this.i18n.t('common.undo'), run: () => this.store.restore(before) });
  }

  private denied() {
    this.toasts.error(this.i18n.t('errors.denied'));
  }

  // ---------- queries ----------

  allowedTransitions(issue: Issue): Status[] {
    if (!this.perm.can('changeStatus', issue.projectId)) return [];
    const wf = this.store.workflow();
    return wf.transitions[issue.status].filter((s) =>
      s === 'closed' ? this.perm.can('close', issue.projectId)
      : isResolved(issue.status) && !isResolved(s) ? this.perm.can('reopen', issue.projectId) || issue.reporterId === this.me
      : true);
  }

  // ---------- issues ----------

  report(draft: IssueDraft, attachmentIds: number[] = []): Issue | null {
    if (!this.perm.can('report', draft.projectId)) { this.denied(); return null; }
    let created!: Issue;
    this.store.mutate((d) => {
      const project = d.projects.find((p) => p.id === draft.projectId)!;
      const handlerId = draft.handlerId ?? project.categories.find((c) => c.name === draft.category)?.defaultHandlerId ?? null;
      const reporterId = draft.reporterId ?? this.me;
      const status = handlerId && draft.status === 'new' && d.workflow.autoAssignStatus ? 'assigned' : draft.status;
      const ts = now();
      created = {
        ...draft, id: d.issues.reduce((m, i) => Math.max(m, i.id), 0) + 1, reporterId, handlerId, status,
        sticky: draft.sticky ?? false, monitorIds: [...new Set([reporterId, ...(handlerId ? [handlerId] : [])])],
        relationships: [], created: ts, updated: ts,
      };
      d.issues.push(created);
      this.hist(d, created.id, 'created');
      for (const a of d.attachments.filter((x) => attachmentIds.includes(x.id))) {
        a.issueId = created.id;
        this.hist(d, created.id, 'attachment_added', 'file', '', a.name);
      }
      if (handlerId) this.notify(d, created, 'assigned', [handlerId], created.summary);
      this.notify(d, created, 'mentioned', RICH.flatMap((f) => mentionedUserIds(created[f] as RichText)), created.summary);
    });
    return created;
  }

  update(id: number, patch: Partial<Issue>): boolean {
    const issue = this.store.issueMap().get(id);
    if (!issue || !this.perm.canEditIssue(issue)) { this.denied(); return false; }
    let changed = false;
    this.store.mutate((d) => {
      const di = d.issues.find((i) => i.id === id)!;
      const mentionsBefore = new Set(RICH.flatMap((f) => mentionedUserIds(di[f] as RichText)));
      changed = this.applyPatch(d, di, patch);
      const newMentions = RICH.flatMap((f) => mentionedUserIds(di[f] as RichText)).filter((u) => !mentionsBefore.has(u));
      this.notify(d, di, 'mentioned', newMentions, di.summary);
    });
    return changed;
  }

  bulkUpdate(ids: number[], patch: Partial<Issue>, label: string) {
    const editable = ids.filter((id) => {
      const i = this.store.issueMap().get(id);
      return i && this.perm.canEditIssue(i);
    });
    if (!editable.length) { this.denied(); return; }
    this.withUndo(this.i18n.t('toast.bulkUpdated', { count: editable.length, action: label }), () =>
      this.store.mutate((d) => {
        for (const id of editable) this.applyPatch(d, d.issues.find((i) => i.id === id)!, patch);
      }));
  }

  assign(ids: number[], handlerId: number | null) {
    const allowed = ids.filter((id) => this.perm.can('assign', this.store.issueMap().get(id)?.projectId));
    if (!allowed.length) { this.denied(); return; }
    this.bulkUpdate(allowed, { handlerId }, this.i18n.t('actions.assign'));
  }

  changeStatus(id: number, status: Status, extra: StatusChange = {}): boolean {
    const issue = this.store.issueMap().get(id);
    if (!issue) return false;
    if (status !== issue.status && !this.allowedTransitions(issue).includes(status)) {
      this.toasts.error(this.i18n.t('errors.transition', {
        from: this.i18n.t('status.' + issue.status), to: this.i18n.t('status.' + status),
      }));
      return false;
    }
    this.store.mutate((d) => {
      const di = d.issues.find((i) => i.id === id)!;
      const patch: Partial<Issue> = { status };
      if (extra.resolution) patch.resolution = extra.resolution;
      if (extra.fixedInVersion !== undefined) patch.fixedInVersion = extra.fixedInVersion;
      if (extra.handlerId !== undefined) patch.handlerId = extra.handlerId;
      this.applyPatch(d, di, patch);
      if (extra.note && plainText(extra.note)) this.pushNote(d, di, extra.note, !!extra.notePrivate, extra.timeSpent ?? 0, []);
    });
    return true;
  }

  bulkStatus(ids: number[], status: Status) {
    const issues = ids.map((id) => this.store.issueMap().get(id)!).filter((i) => this.allowedTransitions(i).includes(status));
    if (!issues.length) { this.toasts.error(this.i18n.t("errors.noneAllowed")); return; }
    this.bulkUpdate(issues.map((i) => i.id), { status }, this.i18n.t('status.' + status));
  }

  toggleSticky(id: number) {
    const i = this.store.issueMap().get(id);
    if (i) this.update(id, { sticky: !i.sticky });
  }

  clone(id: number, opts: { copyNotes: boolean; copyAttachments: boolean }): number | null {
    const src = this.store.issueMap().get(id);
    if (!src || !this.perm.can('report', src.projectId)) { this.denied(); return null; }
    let newId = 0;
    this.store.mutate((d) => {
      newId = d.issues.reduce((m, i) => Math.max(m, i.id), 0) + 1;
      const ts = now();
      const copy: Issue = {
        ...structuredClone(src), id: newId, status: 'new', resolution: 'open', fixedInVersion: '', reporterId: this.me,
        monitorIds: [this.me], relationships: [{ type: 'related_to', issueId: src.id }], created: ts, updated: ts, sticky: false,
      };
      d.issues.push(copy);
      d.issues.find((i) => i.id === src.id)!.relationships.push({ type: 'related_to', issueId: newId });
      this.hist(d, newId, 'created');
      this.hist(d, newId, 'cloned', 'issue', '', String(src.id));
      this.hist(d, src.id, 'relationship_added', 'related_to', '', String(newId));
      if (opts.copyNotes) {
        for (const c of d.comments.filter((x) => x.issueId === src.id)) {
          d.comments.push({ ...structuredClone(c), id: this.store.nextId(d), issueId: newId });
        }
      }
      if (opts.copyAttachments) {
        // Metadata copy only: the clone points at the same blob.
        for (const a of d.attachments.filter((x) => x.issueId === src.id && x.current && x.commentId === null)) {
          d.attachments.push({ ...a, id: this.store.nextId(d), issueId: newId, previousVersionId: null });
        }
      }
    });
    return newId;
  }

  move(ids: number[], projectId: number) {
    const allowed = ids.filter((id) => this.perm.can('move', this.store.issueMap().get(id)?.projectId));
    if (!allowed.length) { this.denied(); return; }
    const project = this.store.projectMap().get(projectId)!;
    this.withUndo(this.i18n.t('toast.moved', { count: allowed.length, project: project.name }), () =>
      this.store.mutate((d) => {
        for (const id of allowed) {
          const di = d.issues.find((i) => i.id === id)!;
          const patch: Partial<Issue> = { projectId, sprintId: null };
          if (!project.categories.some((c) => c.name === di.category)) patch.category = project.categories[0]?.name ?? '';
          if (!project.versions.some((v) => v.name === di.targetVersion)) patch.targetVersion = '';
          this.applyPatch(d, di, patch);
        }
      }));
  }

  remove(ids: number[]) {
    const allowed = ids.filter((id) => this.perm.can('delete', this.store.issueMap().get(id)?.projectId));
    if (!allowed.length) { this.denied(); return; }
    const set = new Set(allowed);
    this.withUndo(this.i18n.t('toast.deleted', { count: allowed.length }), () =>
      this.store.mutate((d) => {
        d.issues = d.issues.filter((i) => !set.has(i.id));
        for (const i of d.issues) i.relationships = i.relationships.filter((r) => !set.has(r.issueId));
        d.comments = d.comments.filter((c) => !set.has(c.issueId));
        // Attachment metadata goes; blobs are purged as orphans on next start (so undo still works).
        d.attachments = d.attachments.filter((a) => !set.has(a.issueId));
        d.history = d.history.filter((h) => !set.has(h.issueId));
        d.notifications = d.notifications.filter((n) => !set.has(n.issueId));
      }));
  }

  // ---------- relationships / tags / monitors ----------

  addRelationship(id: number, type: RelationshipType, targetId: number): string | null {
    const src = this.store.issueMap().get(id);
    if (!src || !this.perm.can('manageRelationships', src.projectId)) return this.i18n.t('errors.denied');
    if (id === targetId) return this.i18n.t('errors.selfRelation');
    if (!this.store.issueMap().has(targetId)) return this.i18n.t('errors.issueNotFound', { id: targetId });
    if (src.relationships.some((r) => r.issueId === targetId)) return this.i18n.t('errors.relationExists');
    this.store.mutate((d) => {
      const a = d.issues.find((i) => i.id === id)!;
      const b = d.issues.find((i) => i.id === targetId)!;
      a.relationships.push({ type, issueId: targetId });
      b.relationships.push({ type: REVERSE_RELATIONSHIP[type], issueId: id });
      a.updated = b.updated = now();
      this.hist(d, id, 'relationship_added', type, '', String(targetId));
      this.hist(d, targetId, 'relationship_added', REVERSE_RELATIONSHIP[type], '', String(id));
    });
    return null;
  }

  removeRelationship(id: number, targetId: number) {
    this.store.mutate((d) => {
      const a = d.issues.find((i) => i.id === id)!;
      const b = d.issues.find((i) => i.id === targetId);
      const rel = a.relationships.find((r) => r.issueId === targetId);
      a.relationships = a.relationships.filter((r) => r.issueId !== targetId);
      if (b) b.relationships = b.relationships.filter((r) => r.issueId !== id);
      if (rel) {
        this.hist(d, id, 'relationship_deleted', rel.type, String(targetId), '');
        if (b) this.hist(d, targetId, 'relationship_deleted', REVERSE_RELATIONSHIP[rel.type], String(id), '');
      }
    });
  }

  addTag(ids: number[], tag: string) {
    const t = tag.trim().toLowerCase().replace(/\s+/g, '-');
    if (!t) return;
    this.store.mutate((d) => {
      for (const i of d.issues.filter((x) => ids.includes(x.id) && !x.tags.includes(t))) {
        i.tags.push(t);
        i.updated = now();
        this.hist(d, i.id, 'tag_added', 'tag', '', t);
      }
    });
  }

  removeTag(ids: number[], tag: string) {
    this.store.mutate((d) => {
      for (const i of d.issues.filter((x) => ids.includes(x.id) && x.tags.includes(tag))) {
        i.tags = i.tags.filter((x) => x !== tag);
        i.updated = now();
        this.hist(d, i.id, 'tag_removed', 'tag', tag, '');
      }
    });
  }

  setMonitor(ids: number[], userId: number, on: boolean) {
    if (userId !== this.me && !this.perm.can("monitorOthers")) { this.denied(); return; }
    this.store.mutate((d) => {
      for (const i of d.issues.filter((x) => ids.includes(x.id))) {
        const has = i.monitorIds.includes(userId);
        if (has === on) continue;
        i.monitorIds = on ? [...i.monitorIds, userId] : i.monitorIds.filter((u) => u !== userId);
        this.hist(d, i.id, on ? 'monitor_added' : 'monitor_removed', 'monitor', on ? '' : String(userId), on ? String(userId) : '');
      }
    });
  }

  // ---------- notes ----------

  private pushNote(d: Db, issue: Issue, body: RichText, priv: boolean, timeSpent: number, attachmentIds: number[]): Comment {
    const c: Comment = {
      id: this.store.nextId(d), issueId: issue.id, authorId: this.me, body, private: priv, timeSpent, created: now(), edited: null,
    };
    d.comments.push(c);
    for (const a of d.attachments.filter((x) => attachmentIds.includes(x.id))) {
      a.issueId = issue.id;
      a.commentId = c.id;
      this.hist(d, issue.id, 'attachment_added', 'file', '', a.name);
    }
    issue.updated = c.created;
    if (!issue.monitorIds.includes(this.me)) issue.monitorIds.push(this.me);
    this.hist(d, issue.id, 'note_added', 'note', '', String(c.id));
    const mentioned = mentionedUserIds(body);
    this.notify(d, issue, 'mentioned', mentioned, plainText(body).slice(0, 140));
    this.notify(d, issue, 'note', this.watchers(issue).filter((u) => !mentioned.includes(u)), plainText(body).slice(0, 140));
    return c;
  }

  addNote(issueId: number, body: RichText, priv: boolean, timeSpent: number, attachmentIds: number[] = []): Comment | null {
    const issue = this.store.issueMap().get(issueId);
    if (!issue || !this.perm.can('addNote', issue.projectId)) { this.denied(); return null; }
    let c: Comment | null = null;
    this.store.mutate((d) => {
      c = this.pushNote(d, d.issues.find((i) => i.id === issueId)!, body, priv, timeSpent, attachmentIds);
    });
    return c;
  }

  editNote(noteId: number, body: RichText, priv: boolean, timeSpent: number) {
    this.store.mutate((d) => {
      const c = d.comments.find((x) => x.id === noteId)!;
      const issue = d.issues.find((i) => i.id === c.issueId)!;
      const before = new Set(mentionedUserIds(c.body));
      this.hist(d, c.issueId, 'note_edited', 'note', plainText(c.body).slice(0, 120), plainText(body).slice(0, 120));
      if (c.private !== priv) this.hist(d, c.issueId, 'field', 'notePrivate', String(c.private), String(priv));
      Object.assign(c, { body, private: priv, timeSpent, edited: now() });
      // Files attached to a private note inherit its visibility (enforced at read time via commentId).
      this.notify(d, issue, 'mentioned', mentionedUserIds(body).filter((u) => !before.has(u)), plainText(body).slice(0, 140));
    });
  }

  /** keepFiles=true detaches the note's files so they stay as ticket documents. */
  deleteNote(noteId: number, keepFiles: boolean) {
    this.withUndo(this.i18n.t('toast.noteDeleted'), () =>
      this.store.mutate((d) => {
        const c = d.comments.find((x) => x.id === noteId)!;
        d.comments = d.comments.filter((x) => x.id !== noteId);
        const files = d.attachments.filter((a) => a.commentId === noteId);
        if (keepFiles) files.forEach((a) => (a.commentId = null));
        else {
          const ids = new Set(files.map((f) => f.id));
          d.attachments = d.attachments.filter((a) => !ids.has(a.id));
          files.forEach((f) => this.hist(d, c.issueId, 'attachment_deleted', 'file', f.name, ''));
        }
        this.hist(d, c.issueId, 'note_deleted', 'note', plainText(c.body).slice(0, 120), '');
      }));
  }
}
