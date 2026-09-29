import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import type { Attachment } from '../../core/models';
import { Attachments } from '../../core/attachments.service';
import { Permissions } from '../../core/permissions.service';
import { Store } from '../../core/store.service';
import { BytesPipe, FmtDatePipe, I18n, RelTimePipe, TPipe } from '../../i18n/i18n.service';
import { Icon } from '../../shared/icon/icon';
import { Confirm, Dialog, FileDrop, UserChip } from '../../shared/ui';

type Source = 'all' | 'ticket' | 'notes';
type SortBy = 'date' | 'name' | 'size' | 'type';

const KIND_ICON: Record<string, string> = { image: 'image', pdf: 'file-text', video: 'video', audio: 'music', text: 'file-text', other: 'file' };

/**
 * Ticket documents: files uploaded to the ticket AND files attached to its notes
 * (same storage, `commentId` tells them apart).
 */
@Component({
  selector: 'app-issue-documents',
  imports: [FormsModule, TPipe, FmtDatePipe, RelTimePipe, BytesPipe, Icon, Dialog, FileDrop, UserChip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:paste)': 'paste($event)' },
  templateUrl: './issue-documents.html',
  styleUrl: './issue-documents.css',
})
export class IssueDocuments {
  protected readonly files = inject(Attachments);
  private readonly store = inject(Store);
  private readonly perm = inject(Permissions);
  private readonly confirm = inject(Confirm);
  private readonly i18n = inject(I18n);
  private readonly sanitizer = inject(DomSanitizer);

  readonly issueId = input.required<number>();
  readonly projectId = input.required<number>();
  readonly gotoNote = output<number>();
  /** Only provides the preview dialog (used for images clicked inside notes/descriptions). */
  readonly previewOnly = input(false);
  protected readonly previewDlg = viewChild.required<Dialog>('previewDlg');
  protected readonly editDlg = viewChild.required<Dialog>('editDlg');

  protected readonly sources: Source[] = ['all', 'ticket', 'notes'];
  protected readonly sorts: SortBy[] = ['date', 'name', 'size', 'type'];
  protected readonly maxSize = this.i18n.bytes(10 * 1024 * 1024);
  protected readonly source = signal<Source>('all');
  protected readonly sortBy = signal<SortBy>('date');
  protected readonly view = signal<'list' | 'grid'>('list');
  protected readonly query = signal('');
  protected readonly versionsOpen = signal(new Set<number>());
  protected readonly thumbs = signal<Record<number, string>>({});
  protected readonly current = signal<Attachment | null>(null);
  protected readonly currentUrl = signal('');
  protected readonly currentText = signal('');
  protected readonly zoom = signal(1);
  protected uploadDescription = '';
  protected editName = '';
  protected editDescription = '';
  private editing: Attachment | null = null;
  private versionTarget: Attachment | null = null;

  protected readonly canUpload = computed(() => this.perm.can('uploadFile', this.projectId()));
  private readonly all = computed(() => this.files.forIssue(this.issueId()).filter((a) => a.current));
  protected readonly counts = computed(() => ({
    all: this.all().length,
    ticket: this.all().filter((a) => !a.commentId).length,
    notes: this.all().filter((a) => a.commentId).length,
  }));
  protected readonly visible = computed(() => {
    const q = this.query().toLowerCase();
    const src = this.source();
    const list = this.all().filter((a) =>
      (src === 'all' || (src === 'ticket') === !a.commentId) && (!q || (a.name + ' ' + a.description).toLowerCase().includes(q)));
    const by = this.sortBy();
    return list.sort((a, b) =>
      by === 'name' ? a.name.localeCompare(b.name) : by === 'size' ? b.size - a.size
      : by === 'type' ? a.mimeType.localeCompare(b.mimeType) || a.name.localeCompare(b.name) : b.date.localeCompare(a.date));
  });
  protected readonly safeUrl = computed(() => this.sanitizer.bypassSecurityTrustResourceUrl(this.currentUrl()));

  constructor() {
    // Lazy thumbnails for image files (grid view).
    effect(() => {
      const list = this.all();
      untracked(async () => {
        const next: Record<number, string> = { ...this.thumbs() };
        for (const a of list) if (!next[a.id] && Attachments.kind(a.mimeType) === 'image') next[a.id] = await this.files.url(a);
        this.thumbs.set(next);
      });
    });
  }

  protected icon(a: Attachment) {
    return KIND_ICON[Attachments.kind(a.mimeType, a.name)];
  }

  protected kind(a: Attachment | null) {
    return a ? Attachments.kind(a.mimeType, a.name) : 'other';
  }

  protected pick(input: HTMLInputElement) {
    this.upload([...(input.files ?? [])]);
    input.value = '';
  }

  protected async upload(list: File[]) {
    if (!list.length || !this.canUpload()) return;
    await this.files.upload(list, { issueId: this.issueId(), commentId: null }, this.uploadDescription.trim());
    this.uploadDescription = '';
  }

  /** Paste files anywhere on the page while the documents tab is shown (not inside editors). */
  protected paste(e: ClipboardEvent) {
    const t = e.target as HTMLElement;
    if (this.previewOnly() || t.isContentEditable || /INPUT|TEXTAREA/.test(t.tagName) || !e.clipboardData?.files.length) return;
    e.preventDefault();
    this.upload([...e.clipboardData.files]);
  }

  protected toggleVersions(id: number) {
    const s = new Set(this.versionsOpen());
    if (s.has(id)) s.delete(id);
    else s.add(id);
    this.versionsOpen.set(s);
  }

  protected startVersion(a: Attachment, input: HTMLInputElement) {
    this.versionTarget = a;
    input.click();
  }

  protected async finishVersion(input: HTMLInputElement) {
    const f = input.files?.[0];
    input.value = '';
    if (f && this.versionTarget) await this.files.newVersion(this.versionTarget, f);
    this.versionTarget = null;
  }

  protected edit(a: Attachment) {
    this.editing = a;
    this.editName = a.name;
    this.editDescription = a.description;
    this.editDlg().open();
  }

  protected saveEdit() {
    if (this.editing && this.editName.trim()) this.files.rename(this.editing, this.editName.trim(), this.editDescription.trim());
    this.editDlg().close();
  }

  protected async remove(a: Attachment) {
    const ok = await this.confirm.ask({
      title: this.i18n.t('files.deleteTitle'), message: this.i18n.t('files.deleteConfirm', { name: a.name, count: a.version }),
      danger: true, confirm: this.i18n.t('common.delete'),
    });
    if (ok) this.files.remove(a);
  }

  async preview(a: Attachment) {
    this.current.set(a);
    this.zoom.set(1);
    this.currentText.set('');
    this.currentUrl.set(await this.files.url(a));
    if (this.kind(a) === 'text') this.currentText.set(await this.files.text(a));
    this.previewDlg().open();
  }

  protected hasSibling(d: number) {
    const list = this.visible();
    const i = list.findIndex((x) => x.id === this.current()?.id);
    return i >= 0 && !!list[i + d];
  }

  protected step(d: number) {
    const list = this.visible();
    const i = list.findIndex((x) => x.id === this.current()?.id);
    const next = list[i + d];
    if (next) this.preview(next);
  }
}
