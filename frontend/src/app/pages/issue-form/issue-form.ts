import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormBuilder, FormControl, FormRecord, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Store } from '../../core/store.service';
import { Auth } from '../../core/auth.service';
import { Workspace } from '../../core/workspace.service';
import { Permissions } from '../../core/permissions.service';
import { IssueActions, IssueDraft } from '../../core/issue-actions.service';
import { Attachments } from '../../core/attachments.service';
import { Tabs } from '../../core/tabs.service';
import { Toasts } from '../../core/toast.service';
import { DirtyAware } from '../../core/guards';
import { PRIORITIES, REPRODUCIBILITY, RESOLUTIONS, SEVERITIES, STATUSES } from '../../core/config';
import type { Issue, Priority, Reproducibility, Resolution, RichText, Severity, Status, ViewState } from '../../core/models';
import { BytesPipe, I18n, TPipe } from '../../i18n/i18n.service';
import { Icon } from '../../shared/icon/icon';
import { RichEditor } from '../../shared/rich/rich-editor/rich-editor';
import { Empty, FileDrop, TagInput, UserSelect } from '../../shared/ui';

const DRAFT_KEY = 'bt:report-draft';

@Component({
  selector: 'app-issue-form',
  imports: [ReactiveFormsModule, FormsModule, RouterLink, TPipe, BytesPipe, Icon, RichEditor, TagInput, UserSelect, FileDrop, Empty],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './issue-form.html',
  styleUrl: './issue-form.css',
})
export class IssueForm implements DirtyAware {
  protected readonly store = inject(Store);
  protected readonly auth = inject(Auth);
  protected readonly perm = inject(Permissions);
  private readonly ws = inject(Workspace);
  private readonly actions = inject(IssueActions);
  private readonly files = inject(Attachments);
  private readonly tabs = inject(Tabs);
  private readonly toasts = inject(Toasts);
  private readonly i18n = inject(I18n);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly fb = inject(FormBuilder).nonNullable;

  /** Route param when editing (/issues/:id/edit). */
  readonly id = input<string>();

  protected readonly severities = SEVERITIES;
  protected readonly priorities = PRIORITIES;
  protected readonly reproducibility = REPRODUCIBILITY;
  protected readonly resolutions = RESOLUTIONS;

  /** null = new issue, undefined = not found / no permission. */
  protected readonly editing = computed<Issue | null | undefined>(() => {
    if (!this.id()) return null;
    const i = this.store.issues().find((x) => x.id === Number(this.id()));
    return i && this.perm.canEditIssue(i) ? i : undefined;
  });

  protected readonly form = this.fb.group({
    projectId: [0, Validators.min(1)],
    category: ['', Validators.required],
    severity: ['minor' as Severity],
    priority: ['normal' as Priority],
    reproducibility: ['have_not_tried' as Reproducibility],
    handlerId: [null as number | null],
    sprintId: [null as number | null],
    dueDate: [''],
    productVersion: [''],
    targetVersion: [''],
    platform: [''],
    os: [''],
    osBuild: [''],
    estimate: [null as number | null],
    storyPoints: [null as number | null],
    viewState: ['public' as ViewState],
    reporterId: [0],
    status: ['new' as Status],
    resolution: ['open' as Resolution],
    fixedInVersion: [''],
    sticky: [false],
    summary: ['', [Validators.required, Validators.maxLength(128), Validators.pattern(/\S/)]],
    description: [null as RichText],
    stepsToReproduce: [null as RichText],
    additionalInfo: [null as RichText],
    tags: [[] as string[]],
  });
  protected readonly cfForm = new FormRecord<FormControl<string>>({});

  protected readonly advanced = signal(readAdvanced());
  protected reportStay = false;
  protected readonly hasDraft = signal(false);
  protected readonly pendingIds = signal<number[]>([]);
  protected readonly pendingFiles = computed(() => this.pendingIds().map((id) => this.files.get(id)).filter((a) => !!a));

  private readonly value = toSignal(this.form.valueChanges, { initialValue: this.form.getRawValue() });
  protected readonly projectId = computed(() => this.value().projectId ?? 0);
  protected readonly project = computed(() => this.store.projectMap().get(this.projectId()));
  protected readonly projects = computed(() => this.ws.visibleProjects().filter((p) => p.enabled && this.perm.can('report', p.id)));
  protected readonly sprints = computed(() => this.store.sprints().filter((s) => s.projectId === this.projectId() && s.state !== 'closed'));
  protected readonly openVersions = computed(() => (this.project()?.versions ?? []).filter((v) => !v.obsolete));
  protected readonly memberIds = computed(() => this.project()?.members.map((m) => m.userId) ?? null);
  protected readonly customFields = computed(() => this.store.customFields().filter((f) => this.project()?.customFieldIds.includes(f.id)));
  protected readonly statusOptions = computed(() => {
    const e = this.editing();
    if (!e) return STATUSES;
    return [e.status, ...this.actions.allowedTransitions(e)];
  });
  protected readonly suggestions = computed(() => ({
    platform: [...new Set(this.store.issues().map((i) => i.platform).filter(Boolean))],
    os: [...new Set(this.store.issues().map((i) => i.os).filter(Boolean))],
  }));

  protected readonly uploader = async (f: File): Promise<number | null> => {
    const e = this.editing();
    const [id] = await this.files.upload([f], { issueId: e ? e.id : 0, commentId: null });
    if (id && !e) this.pendingIds.update((l) => [...l, id]);
    return id ?? null;
  };

  private saved = false;

  constructor() {
    // Populate once the issue (edit) or defaults (report) are known.
    effect(() => {
      const e = this.editing();
      untracked(() => (e ? this.load(e) : e === null ? this.loadNew() : undefined));
    });
    // Keep category/custom fields consistent with the selected project.
    effect(() => {
      const p = this.project();
      const fields = this.customFields();
      untracked(() => {
        if (p && !p.categories.some((c) => c.name === this.form.controls.category.value)) {
          this.form.controls.category.setValue(p.categories[0]?.name ?? '', { emitEvent: false });
        }
        const current = this.editing()?.customFields ?? {};
        for (const k of Object.keys(this.cfForm.controls)) if (!fields.some((f) => String(f.id) === k)) this.cfForm.removeControl(k);
        for (const f of fields) {
          if (this.cfForm.contains(String(f.id))) continue;
          this.cfForm.addControl(String(f.id), this.fb.control(current[f.id] ?? f.defaultValue, f.required ? Validators.required : []));
        }
      });
    });
    effect(() => {
      const on = this.advanced();
      try { localStorage.setItem('bt:form-advanced', on ? '1' : '0'); } catch { /* ignore */ }
    });
    // Dirty marker on the editor tab + draft autosave for new reports.
    this.form.valueChanges.subscribe(() => {
      this.tabs.setDirty(this.form.dirty);
      if (!this.editing() && this.form.dirty) this.writeDraft();
    });
  }

  isDirty(): boolean {
    return !this.saved && (this.form.dirty || this.cfForm.dirty);
  }

  private load(e: Issue) {
    this.form.reset({
      ...e, dueDate: e.dueDate ?? '', tags: [...e.tags],
    }, { emitEvent: true });
    this.form.markAsPristine();
  }

  private loadNew() {
    const q = this.route.snapshot.queryParamMap;
    const projectId = Number(q.get('project')) || this.ws.projectId() || this.auth.prefs()?.defaultProjectId || this.projects()[0]?.id || 0;
    const draft = readDraft();
    this.form.reset({
      projectId, category: '', severity: 'minor', priority: 'normal', reproducibility: 'have_not_tried', handlerId: null,
      sprintId: Number(q.get('sprint')) || null, dueDate: '', productVersion: '', targetVersion: '', platform: '', os: '', osBuild: '',
      estimate: null, storyPoints: null, viewState: 'public', reporterId: this.auth.me().id, status: 'new', resolution: 'open',
      fixedInVersion: '', sticky: false, summary: '', description: null, stepsToReproduce: null, additionalInfo: null, tags: [],
    });
    if (draft) {
      this.form.patchValue(draft);
      this.hasDraft.set(true);
      this.toasts.show(this.i18n.t('form.draftRestored'));
    }
    this.form.markAsPristine();
  }

  protected discardDraft() {
    clearDraft();
    this.hasDraft.set(false);
    this.saved = true;
    this.loadNew();
    this.saved = false;
  }

  private writeDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(this.form.getRawValue()));
      this.hasDraft.set(true);
    } catch { /* ignore */ }
  }

  protected async addFiles(list: File[]) {
    const e = this.editing();
    if (e) {
      await this.files.upload(list, { issueId: e.id, commentId: null });
      return;
    }
    const ids = await this.files.upload(list, { issueId: 0, commentId: null });
    this.pendingIds.update((l) => [...l, ...ids]);
  }

  protected removePending(id: number) {
    this.files.discardPending([id]);
    this.pendingIds.update((l) => l.filter((x) => x !== id));
  }

  protected save() {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.cfForm.invalid) {
      this.toasts.error(this.i18n.t('form.invalid'));
      return;
    }
    const v = this.form.getRawValue();
    const customFields = Object.fromEntries(Object.entries(this.cfForm.getRawValue()).filter(([, x]) => x !== '')) as Record<number, string>;
    const e = this.editing();
    const base = { ...v, summary: v.summary.trim(), dueDate: v.dueDate || null, customFields,
      estimate: v.estimate === null || String(v.estimate) === '' ? null : Number(v.estimate) };

    if (e) {
      const { status, ...rest } = base;
      // Status goes through the workflow rules; everything else is a regular update.
      this.actions.update(e.id, { ...rest, reporterId: rest.reporterId || e.reporterId });
      if (status !== e.status) this.actions.changeStatus(e.id, status);
      this.finish();
      this.router.navigate(['/issues', e.id]);
      return;
    }

    const draft: IssueDraft = { ...base, status: 'new', resolution: 'open', fixedInVersion: '' };
    const created = this.actions.report(draft, this.pendingIds());
    if (!created) return;
    clearDraft();
    this.hasDraft.set(false);
    this.pendingIds.set([]);
    this.toasts.success(this.i18n.t('form.reported', { key: this.store.issueKey(created) }), {
      label: this.i18n.t('actions.open'), run: () => this.router.navigate(['/issues', created.id]),
    });
    if (this.reportStay) {
      // Keep classification, clear the text for the next report.
      this.form.patchValue({ summary: '', description: null, stepsToReproduce: null, additionalInfo: null, tags: [] });
      this.form.markAsPristine();
      this.form.markAsUntouched();
      this.tabs.setDirty(false);
      return;
    }
    this.finish();
    this.router.navigate(['/issues', created.id]);
  }

  private finish() {
    this.saved = true;
    this.tabs.setDirty(false);
  }
}

function readAdvanced(): boolean {
  try { return localStorage.getItem('bt:form-advanced') !== '0'; } catch { return true; }
}

function readDraft(): Partial<Record<string, unknown>> | null {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null'); } catch { return null; }
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}
