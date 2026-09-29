import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Store } from '../../core/store.service';
import { Auth } from '../../core/auth.service';
import { Workspace } from '../../core/workspace.service';
import { Permissions } from '../../core/permissions.service';
import { IssueActions } from '../../core/issue-actions.service';
import { Attachments } from '../../core/attachments.service';
import { Tabs } from '../../core/tabs.service';
import { Toasts } from '../../core/toast.service';
import { RELATIONSHIPS, RESOLUTIONS, isResolved } from '../../core/config';
import { isOverdue } from '../../core/issue-filter';
import { isEmptyRich } from '../../core/rich';
import { isTyping } from '../../core/csv';
import type { Comment, HistoryEntry, Issue, RelationshipType, RichText, Status } from '../../core/models';
import { BytesPipe, FmtDatePipe, I18n, RelTimePipe, TPipe } from '../../i18n/i18n.service';
import { Icon } from '../../shared/icon/icon';
import { RichEditor } from '../../shared/rich/rich-editor/rich-editor';
import { RichView } from '../../shared/rich/rich-view/rich-view';
import { HistoryFormat } from '../../shared/history-format';
import {
  Confirm, Dialog, Empty, FileDrop, Menu, PriorityLabel, SeverityLabel, StatusBadge, TagInput, UserChip, UserSelect,
} from '../../shared/ui';
import { IssueDocuments } from '../issue-documents/issue-documents';

type RichField = 'description' | 'stepsToReproduce' | 'additionalInfo';
type ActivityTab = 'notes' | 'documents' | 'history' | 'timeline' | 'time';

@Component({
  selector: 'app-issue-view',
  imports: [
    FormsModule, RouterLink, TPipe, FmtDatePipe, RelTimePipe, BytesPipe, Icon, RichEditor, RichView, Dialog, Menu, FileDrop, Empty,
    StatusBadge, PriorityLabel, SeverityLabel, TagInput, UserChip, UserSelect, IssueDocuments,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'onKey($event)' },
  templateUrl: './issue-view.html',
  styleUrl: './issue-view.css',
})
export class IssueView {
  protected readonly store = inject(Store);
  protected readonly auth = inject(Auth);
  protected readonly ws = inject(Workspace);
  protected readonly perm = inject(Permissions);
  protected readonly actions = inject(IssueActions);
  protected readonly i18n = inject(I18n);
  protected readonly fmt = inject(HistoryFormat);
  private readonly files = inject(Attachments);
  private readonly tabs = inject(Tabs);
  private readonly toasts = inject(Toasts);
  private readonly confirm = inject(Confirm);
  private readonly router = inject(Router);

  readonly id = input.required<string>();
  protected readonly statusDlg = viewChild.required<Dialog>('statusDlg');
  protected readonly cloneDlg = viewChild.required<Dialog>('cloneDlg');
  protected readonly moveDlg = viewChild.required<Dialog>('moveDlg');
  private readonly composer = viewChild<RichEditor>('composer');
  private readonly docPreview = viewChild<IssueDocuments>('docPreview');

  protected readonly Math = Math;
  protected readonly richFields: RichField[] = ['description', 'stepsToReproduce', 'additionalInfo'];
  protected readonly relationshipTypes = RELATIONSHIPS;
  protected readonly resolutions = RESOLUTIONS;
  protected readonly activityTabs: { id: ActivityTab; icon: string }[] = [
    { id: 'notes', icon: 'message' }, { id: 'documents', icon: 'paperclip' }, { id: 'history', icon: 'history' },
    { id: 'timeline', icon: 'clock' }, { id: 'time', icon: 'clock' },
  ];

  protected readonly issue = computed(() => {
    const i = this.store.issueMap().get(Number(this.id()));
    return i && this.perm.canSeeIssue(i) ? i : null;
  });
  protected readonly key = computed(() => (this.issue() ? this.store.issueKey(this.issue()!) : ''));
  protected readonly project = computed(() => this.store.projectMap().get(this.issue()?.projectId ?? 0));
  protected readonly sprint = computed(() => this.store.sprintMap().get(this.issue()?.sprintId ?? 0));
  protected readonly canEdit = computed(() => !!this.issue() && this.perm.canEditIssue(this.issue()!));
  protected readonly transitions = computed(() => (this.issue() ? this.actions.allowedTransitions(this.issue()!) : []));
  protected readonly monitoring = computed(() => !!this.issue()?.monitorIds.includes(this.auth.me().id));
  protected readonly overdue = computed(() => !!this.issue() && isOverdue(this.issue()!));
  protected readonly customFields = computed(() =>
    this.store.customFields().filter((f) => this.project()?.customFieldIds.includes(f.id)));
  protected readonly assignable = computed(() => {
    const p = this.project();
    return this.store.users().filter((u) => u.enabled && u.accessLevel >= 40 && (!p || p.members.some((m) => m.userId === u.id) || u.accessLevel >= 70));
  });
  protected readonly relations = computed(() =>
    (this.issue()?.relationships ?? []).map((r) => {
      const t = this.store.issueMap().get(r.issueId);
      return { ...r, target: t && this.perm.canSeeIssue(t) ? t : null };
    }));

  protected readonly newestFirst = computed(() => !!this.auth.prefs()?.notesNewestFirst);
  protected readonly notes = computed(() => {
    const i = this.issue();
    if (!i) return [];
    const list = this.store.comments().filter((c) => c.issueId === i.id && this.perm.canSeeNote(c, i.projectId));
    return list.sort((a, b) => (this.newestFirst() ? b.created.localeCompare(a.created) : a.created.localeCompare(b.created)));
  });
  protected readonly noteFiles = computed(() => {
    const m = new Map<number, ReturnType<Attachments['forIssue']>>();
    for (const a of this.files.forIssue(this.issue()?.id ?? 0)) {
      if (!a.commentId || !a.current) continue;
      m.set(a.commentId, [...(m.get(a.commentId) ?? []), a]);
    }
    return m;
  });
  protected readonly docCount = computed(() => this.files.forIssue(this.issue()?.id ?? 0).filter((a) => a.current).length);
  protected readonly history = computed(() =>
    this.store.history().filter((h) => h.issueId === this.issue()?.id).sort((a, b) => b.date.localeCompare(a.date)));
  protected readonly timeline = computed(() => {
    const items: { key: string; date: string; userId: number; icon: string; text: string }[] = [];
    for (const h of this.history()) {
      if (h.type === 'note_added') continue;
      items.push({ key: 'h' + h.id, date: h.date, userId: h.userId, icon: iconFor(h), text: this.fmt.line(h) });
    }
    for (const n of this.notes()) {
      items.push({ key: 'n' + n.id, date: n.created, userId: n.authorId, icon: 'message', text: this.i18n.t('issue.addedNote', { id: n.id }) });
    }
    return items.sort((a, b) => b.date.localeCompare(a.date));
  });
  protected readonly timeByUser = computed(() => {
    const m = new Map<number, { userId: number; minutes: number; entries: number }>();
    for (const n of this.notes().filter((x) => x.timeSpent)) {
      const r = m.get(n.authorId) ?? { userId: n.authorId, minutes: 0, entries: 0 };
      r.minutes += n.timeSpent;
      r.entries++;
      m.set(n.authorId, r);
    }
    return [...m.values()].sort((a, b) => b.minutes - a.minutes);
  });
  protected readonly timeTotal = computed(() => this.timeByUser().reduce((s, r) => s + r.minutes, 0));

  protected readonly tab = signal<ActivityTab>('notes');
  protected readonly highlight = signal<number | null>(null);
  protected readonly editingSummary = signal(false);
  protected readonly editingField = signal<RichField | null>(null);
  protected richDraft: RichText = null;

  // relationships
  protected relType: RelationshipType = 'related_to';
  protected relTarget: number | null = null;
  protected readonly relError = signal('');

  // note composer
  protected noteDraft: RichText = null;
  protected notePrivate = false;
  protected noteTime = 0;
  protected readonly pendingIds = signal<number[]>([]);
  protected readonly pendingFiles = computed(() => this.pendingIds().map((id) => this.files.get(id)).filter((a) => !!a));
  protected readonly noteUploader = async (f: File) => {
    const [id] = await this.files.upload([f], { issueId: 0, commentId: null });
    if (id) this.pendingIds.update((l) => [...l, id]);
    return id ?? null;
  };
  protected readonly ticketUploader = async (f: File) => (await this.files.upload([f], { issueId: this.issue()!.id, commentId: null }))[0] ?? null;

  // note edit
  protected readonly editingNote = signal<number | null>(null);
  protected noteEditDraft: RichText = null;
  protected noteEditPrivate = false;
  protected noteEditTime = 0;
  protected readonly noteEditUploader = async (f: File) =>
    (await this.files.upload([f], { issueId: this.issue()!.id, commentId: this.editingNote() }))[0] ?? null;

  // status dialog
  protected readonly targetStatus = signal<Status>('new');
  protected readonly resolving = computed(() => isResolved(this.targetStatus()));
  protected stResolution: Issue['resolution'] = 'fixed';
  protected stFixed = '';
  protected stHandler: number | null = null;
  protected stNote: RichText = null;
  protected stPrivate = false;
  protected stTime = 0;

  protected cloneNotes = false;
  protected cloneFiles = true;
  protected moveTarget = 0;

  constructor() {
    effect(() => {
      const i = this.issue();
      const k = this.key();
      untracked(() => {
        if (i) this.tabs.setTitle(`${k} ${i.summary}`);
      });
    });
    // Reset per-issue UI state when navigating between issues.
    effect(() => {
      this.id();
      untracked(() => {
        this.editingField.set(null);
        this.editingSummary.set(false);
        this.editingNote.set(null);
        this.relError.set('');
        if (location.hash.startsWith('#note-')) setTimeout(() => this.scrollToNote(Number(location.hash.slice(6))), 50);
      });
    });
  }

  protected isEmpty(rt: RichText) {
    return isEmptyRich(rt);
  }

  // ---------- navigation ----------

  protected neighbor(delta: number): number | null {
    const list = this.ws.issueNav();
    const idx = list.indexOf(Number(this.id()));
    return idx >= 0 ? list[idx + delta] ?? null : null;
  }

  protected go(delta: number) {
    const n = this.neighbor(delta);
    if (n) this.router.navigate(['/issues', n]);
  }

  protected scrollToNote(id: number) {
    this.tab.set('notes');
    this.highlight.set(id);
    setTimeout(() => document.getElementById('note-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 30);
    setTimeout(() => this.highlight.set(null), 2500);
  }

  protected onKey(e: KeyboardEvent) {
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]') || !this.issue()) return;
    const i = this.issue()!;
    switch (e.key) {
      case 'e': if (this.canEdit()) { e.preventDefault(); this.router.navigate(['/issues', i.id, 'edit']); } break;
      case 'a': if (this.perm.can('assign', i.projectId)) { e.preventDefault(); this.actions.assign([i.id], this.auth.me().id); } break;
      case 'c': e.preventDefault(); this.tab.set('notes'); setTimeout(() => this.composer()?.focus(), 30); break;
      case '[': this.go(-1); break;
      case ']': this.go(1); break;
    }
  }

  // ---------- inline edits ----------

  protected saveSummary(v: string) {
    const summary = v.trim();
    this.editingSummary.set(false);
    if (summary && summary !== this.issue()!.summary) this.actions.update(this.issue()!.id, { summary });
  }

  protected editRich(f: RichField) {
    this.richDraft = this.issue()![f];
    this.editingField.set(f);
  }

  protected saveRich(f: RichField) {
    this.actions.update(this.issue()!.id, { [f]: this.richDraft });
    this.editingField.set(null);
  }

  // ---------- status ----------

  openStatus(s: Status) {
    if (!s) return;
    const i = this.issue()!;
    this.targetStatus.set(s);
    this.stResolution = isResolved(s) ? (i.resolution === 'open' || i.resolution === 'reopened' ? 'fixed' : i.resolution) : i.resolution;
    this.stFixed = i.fixedInVersion || i.targetVersion;
    this.stHandler = s === 'assigned' && !i.handlerId ? this.auth.me().id : i.handlerId;
    this.stNote = null;
    this.stPrivate = false;
    this.stTime = 0;
    this.statusDlg().open();
  }

  protected applyStatus() {
    const i = this.issue()!;
    const s = this.targetStatus();
    const ok = this.actions.changeStatus(i.id, s, {
      resolution: this.resolving() ? this.stResolution : !isResolved(s) && isResolved(i.status) ? 'reopened' : undefined,
      fixedInVersion: this.resolving() ? this.stFixed : undefined,
      handlerId: this.stHandler !== i.handlerId ? this.stHandler : undefined,
      note: this.stNote, notePrivate: this.stPrivate, timeSpent: Number(this.stTime) || 0,
    });
    if (ok) this.statusDlg().close();
  }

  // ---------- relationships ----------

  protected addRelation() {
    const err = this.actions.addRelationship(this.issue()!.id, this.relType, Number(this.relTarget));
    this.relError.set(err ?? '');
    if (!err) this.relTarget = null;
  }

  // ---------- notes ----------

  protected async addNoteFiles(list: File[]) {
    const ids = await this.files.upload(list, { issueId: 0, commentId: null });
    this.pendingIds.update((l) => [...l, ...ids]);
  }

  protected dropPending(id: number) {
    this.files.discardPending([id]);
    this.pendingIds.update((l) => l.filter((x) => x !== id));
  }

  protected addNote() {
    if (isEmptyRich(this.noteDraft) && !this.pendingIds().length) return;
    const body = this.noteDraft ?? { type: 'doc', content: [{ type: 'paragraph' }] };
    const c = this.actions.addNote(this.issue()!.id, body, this.notePrivate, Number(this.noteTime) || 0, this.pendingIds());
    if (!c) return;
    this.noteDraft = null;
    this.composer()?.clear();
    this.notePrivate = false;
    this.noteTime = 0;
    this.pendingIds.set([]);
    this.toasts.success(this.i18n.t('issue.noteAdded'));
  }

  protected quote(n: Comment) {
    const author = this.store.userMap().get(n.authorId)?.username ?? '';
    this.composer()?.quote(n.body, `@${author} (#${n.id}):`);
  }

  protected editNote(n: Comment) {
    this.noteEditDraft = n.body;
    this.noteEditPrivate = n.private;
    this.noteEditTime = n.timeSpent;
    this.editingNote.set(n.id);
  }

  protected saveNoteEdit(n: Comment) {
    this.actions.editNote(n.id, this.noteEditDraft, this.noteEditPrivate, Number(this.noteEditTime) || 0);
    this.editingNote.set(null);
  }

  protected async deleteNote(n: Comment) {
    const count = this.noteFiles().get(n.id)?.length ?? 0;
    const answer = await this.confirm.ask({
      title: this.i18n.t('issue.deleteNote'),
      message: count ? this.i18n.t('issue.deleteNoteFiles', { count }) : this.i18n.t('issue.deleteNoteConfirm'),
      danger: true, confirm: this.i18n.t('common.delete'),
      choices: count ? [
        { label: this.i18n.t('issue.keepFiles'), value: 'keep' },
        { label: this.i18n.t('issue.deleteFiles'), value: 'delete', danger: true },
      ] : undefined,
    });
    if (answer) this.actions.deleteNote(n.id, answer === 'keep');
  }

  protected previewAttachment(id: number) {
    const a = this.files.get(id);
    if (a) this.docPreview()?.preview(a);
  }

  // ---------- misc ----------

  protected copyLink() {
    navigator.clipboard?.writeText(location.href).then(() => this.toasts.success(this.i18n.t('toast.copied')));
  }

  protected print() {
    window.print();
  }

  protected doClone() {
    const id = this.actions.clone(this.issue()!.id, { copyNotes: this.cloneNotes, copyAttachments: this.cloneFiles });
    this.cloneDlg().close();
    if (id) this.router.navigate(['/issues', id]);
  }

  protected async remove() {
    const i = this.issue()!;
    const ok = await this.confirm.ask({
      title: this.i18n.t('common.delete'), message: this.i18n.t('issue.deleteConfirm', { key: this.key(), summary: i.summary }),
      danger: true, confirm: this.i18n.t('common.delete'),
    });
    if (!ok) return;
    const key = this.tabs.activeKey();
    this.actions.remove([i.id]);
    this.tabs.drop(key);
    this.router.navigate(['/issues']);
  }
}

function iconFor(h: HistoryEntry): string {
  if (h.type.startsWith('attachment')) return 'paperclip';
  if (h.type.startsWith('relationship') || h.type === 'cloned') return 'link';
  if (h.type.startsWith('tag')) return 'tag';
  if (h.type.startsWith('monitor')) return 'eye';
  if (h.type.startsWith('note')) return 'message';
  if (h.type === 'created') return 'plus';
  return h.field === 'status' ? 'workflow' : h.field === 'handlerId' ? 'user' : 'edit';
}
