import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { Store } from '../../core/store.service';
import { Auth } from '../../core/auth.service';
import { Workspace } from '../../core/workspace.service';
import { Permissions } from '../../core/permissions.service';
import { IssueActions } from '../../core/issue-actions.service';
import { Toasts } from '../../core/toast.service';
import {
  ALL_COLUMNS, DEFAULT_COLUMNS, PRIORITIES, RELATIONSHIPS, REPRODUCIBILITY, RESOLUTIONS, SEVERITIES, STATUSES, emptyCriteria,
} from '../../core/config';
import { criteriaToParams, filterIssues, paramsToCriteria, sortIssues } from '../../core/issue-filter';
import { downloadText, parseCsv, toCsv } from '../../core/csv';
import { doc, plainText } from '../../core/rich';
import type { ColumnId, FilterCriteria, Issue, Priority, SavedFilter, Severity, SortKey, Status } from '../../core/models';
import { I18n, TPipe } from '../../i18n/i18n.service';
import { Icon } from '../../shared/icon/icon';
import { IssueTable } from '../../shared/issue-table/issue-table';
import { Confirm, Dialog, Menu, UserSelect } from '../../shared/ui';

const COLS_KEY = 'bt:columns';

@Component({
  selector: 'app-issues',
  imports: [FormsModule, RouterLink, TPipe, Icon, IssueTable, Menu, Dialog, UserSelect],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './issues.html',
  styleUrl: './issues.css',
})
export class Issues {
  protected readonly store = inject(Store);
  protected readonly auth = inject(Auth);
  protected readonly ws = inject(Workspace);
  protected readonly perm = inject(Permissions);
  protected readonly actions = inject(IssueActions);
  private readonly toasts = inject(Toasts);
  private readonly confirm = inject(Confirm);
  private readonly i18n = inject(I18n);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly saveDlg = viewChild.required<Dialog>('saveDlg');
  protected readonly importDlg = viewChild.required<Dialog>('importDlg');

  protected readonly statuses = STATUSES;
  protected readonly priorities = PRIORITIES;
  protected readonly severities = SEVERITIES;
  protected readonly resolutions = RESOLUTIONS;
  protected readonly reproducibility = REPRODUCIBILITY;
  protected readonly relationships = RELATIONSHIPS;
  protected readonly allColumns = ALL_COLUMNS;
  protected readonly defaultColumns = DEFAULT_COLUMNS;
  protected readonly String = String;
  protected readonly toNum = (x: string | number) => Number(x);

  private readonly params = toSignal(this.route.queryParams, { initialValue: {} as Record<string, string> });
  protected readonly c = computed<FilterCriteria>(() => paramsToCriteria(this.params()));
  protected readonly activeFilter = computed(() => {
    const id = Number(this.params()['filter']);
    return id ? this.store.filters().find((f) => f.id === id) ?? null : null;
  });
  protected readonly sort = computed<SortKey[]>(() => {
    const raw = this.params()['sort'] as string | undefined;
    return raw ? raw.split(',').map((s) => {
      const [column, dir] = s.split(':');
      return { column: column as ColumnId, dir: dir === 'asc' ? 'asc' : 'desc' };
    }) : [];
  });
  protected readonly columns = signal<ColumnId[]>(readColumns());
  protected readonly selection = signal<number[]>([]);
  protected readonly page = signal(0);
  protected readonly advancedOpen = signal(false);
  protected readonly pageSize = computed(() => this.auth.prefs()?.pageSize ?? 25);

  protected readonly users = computed(() => this.store.users().filter((u) => u.enabled).sort((a, b) => a.realName.localeCompare(b.realName)));
  private readonly scopeProjects = computed(() => {
    const ids = this.c().projectIds;
    return ids.length ? this.ws.visibleProjects().filter((p) => ids.includes(p.id)) : this.ws.project() ? [this.ws.project()!] : this.ws.visibleProjects();
  });
  protected readonly categories = computed(() => [...new Set(this.scopeProjects().flatMap((p) => p.categories.map((c) => c.name)))].sort());
  protected readonly versions = computed(() => [...new Set(this.scopeProjects().flatMap((p) => p.versions.map((v) => v.name)))].sort());
  protected readonly sprints = computed(() => {
    const ids = new Set(this.scopeProjects().map((p) => p.id));
    return this.store.sprints().filter((s) => ids.has(s.projectId));
  });
  protected readonly savedFilters = computed(() => {
    const me = this.auth.me().id;
    return this.store.filters().filter((f) => f.ownerId === me || f.shared);
  });

  private readonly noteText = computed(() => {
    const m = new Map<number, string>();
    for (const n of this.store.comments()) m.set(n.issueId, (m.get(n.issueId) ?? '') + ' ' + plainText(n.body));
    return m;
  });

  protected readonly filtered = computed(() => {
    const crit = this.c();
    // Without an explicit project filter the toolbar project selection scopes the list.
    const base = crit.projectIds.length ? this.ws.visibleIssues() : this.ws.scopedIssues();
    return filterIssues(base, crit, {
      meId: this.auth.me().id, projects: this.store.projects(), attachmentCounts: this.store.attachmentCounts(),
      noteText: crit.searchNotes ? this.noteText() : undefined,
    });
  });
  protected readonly sorted = computed(() => sortIssues(this.filtered(), this.sort()));
  protected readonly selectedIssues = computed(() => {
    const s = new Set(this.selection());
    return this.sorted().filter((i) => s.has(i.id));
  });

  protected readonly chips = computed(() => {
    const def = emptyCriteria() as unknown as Record<string, unknown>;
    const cur = this.c() as unknown as Record<string, unknown>;
    const t = (k: string) => this.i18n.t(k);
    const user = (id: number) => (id === -1 ? t('filters.me') : id === 0 ? t('common.unassigned') : this.store.userMap().get(id)?.username ?? id);
    const fmt = (k: string, v: unknown): string => {
      const arr = Array.isArray(v) ? v : [v];
      switch (k) {
        case 'projectIds': return arr.map((id) => this.store.projectMap().get(id as number)?.name).join(', ');
        case 'statuses': case 'hideStatus': return arr.map((s) => t('status.' + s)).join(', ');
        case 'priorities': return arr.map((s) => t('priority.' + s)).join(', ');
        case 'severities': return arr.map((s) => t('severity.' + s)).join(', ');
        case 'resolutions': return arr.map((s) => t('resolution.' + s)).join(', ');
        case 'reproducibility': return arr.map((s) => t('reproducibility.' + s)).join(', ');
        case 'relationship': return t('relationship.' + v);
        case 'handlerIds': case 'reporterIds': case 'monitorId': return arr.map((id) => user(id as number)).join(', ');
        case 'sprintIds': return arr.map((id) => (id === 'none' ? t('sprints.backlog') : this.store.sprintMap().get(id as number)?.name)).join(', ');
        case 'customFieldId': return this.store.customFields().find((f) => f.id === v)?.name ?? '';
        case 'hasAttachments': return t(v ? 'filters.withFiles' : 'filters.withoutFiles');
        default: return typeof v === 'boolean' ? t(v ? 'common.yes' : 'common.no') : arr.join(', ');
      }
    };
    return Object.keys(def)
      .filter((k) => JSON.stringify(cur[k]) !== JSON.stringify(def[k]) && k !== 'includeSubprojects' && k !== 'tagsMode')
      .map((k) => ({ key: k as keyof FilterCriteria, label: t('filters.chip.' + k), value: fmt(k, cur[k]) }));
  });
  protected readonly activeCount = computed(() => this.chips().length);

  // save-filter dialog
  protected readonly editingFilter = signal<SavedFilter | null>(null);
  protected saveName = '';
  protected saveShared = false;
  protected saveDefault = false;

  // import dialog
  protected readonly importFields = ['summary', 'description', 'category', 'priority', 'severity', 'status', 'handlerId', 'tags', 'dueDate', 'storyPoints'];
  protected readonly csvRows = signal<string[][]>([]);
  protected readonly mapping = signal<string[]>([]);
  protected importProject = 0;
  protected readonly canImport = computed(() => this.csvRows().length > 1 && this.mapping().includes('summary'));

  private textTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    // Apply the user's default saved filter when opening the list without parameters.
    const initial = this.route.snapshot.queryParams;
    if (!Object.keys(initial).length) {
      const def = this.savedFilters().find((f) => f.isDefault && f.ownerId === this.auth.me().id);
      if (def) queueMicrotask(() => this.applySaved(String(def.id)));
    }
    // Reset page & selection when the filter changes.
    effect(() => {
      this.c();
      untracked(() => {
        this.page.set(0);
        this.selection.set([]);
      });
    });
    // File > Export CSV lands here with ?export=csv.
    effect(() => {
      if (this.params()['export'] === 'csv') {
        untracked(() => {
          this.exportCsv(this.sorted());
          this.navigate({ ...this.params(), export: undefined });
        });
      }
    });
  }

  private navigate(params: Record<string, string | undefined>) {
    this.router.navigate([], { relativeTo: this.route, queryParams: params, replaceUrl: true });
  }

  protected set<K extends keyof FilterCriteria>(key: K, value: FilterCriteria[K]) {
    const next = { ...this.c(), [key]: value };
    this.navigate({ ...criteriaToParams(next), sort: this.params()['sort'], filter: this.params()['filter'] });
  }

  protected setText(v: string) {
    clearTimeout(this.textTimer);
    this.textTimer = setTimeout(() => this.set('text', v), 250);
  }

  protected clear(key: keyof FilterCriteria) {
    this.set(key, emptyCriteria()[key]);
  }

  protected reset() {
    this.navigate({});
  }

  protected setSort(sort: SortKey[]) {
    this.navigate({ ...this.params(), sort: sort.map((s) => `${s.column}:${s.dir}`).join(',') || undefined });
  }

  protected setColumns(cols: ColumnId[]) {
    this.columns.set(cols);
    try { localStorage.setItem(COLS_KEY, JSON.stringify(cols)); } catch { /* ignore */ }
  }

  protected toggleColumn(c: ColumnId) {
    const cols = this.columns();
    this.setColumns(cols.includes(c) ? cols.filter((x) => x !== c) : [...cols, c]);
  }

  // ---------- saved filters ----------

  protected applySaved(id: string) {
    const f = this.store.filters().find((x) => x.id === Number(id));
    if (!f) return this.reset();
    if (f.columns.length) this.setColumns(f.columns);
    this.navigate({
      ...criteriaToParams({ ...emptyCriteria(), ...f.criteria }),
      sort: f.sort.map((s) => `${s.column}:${s.dir}`).join(',') || undefined,
      filter: String(f.id),
    });
  }

  protected openSave(f: SavedFilter | null = null) {
    this.editingFilter.set(f);
    this.saveName = f?.name ?? '';
    this.saveShared = f?.shared ?? false;
    this.saveDefault = f?.isDefault ?? false;
    this.saveDlg().open();
  }

  protected saveFilter() {
    const name = this.saveName.trim();
    if (!name) return;
    const me = this.auth.me().id;
    const editing = this.editingFilter();
    let id = editing?.id ?? 0;
    this.store.mutate((d) => {
      if (this.saveDefault) d.filters.forEach((f) => f.ownerId === me && (f.isDefault = false));
      if (editing) {
        Object.assign(d.filters.find((f) => f.id === editing.id)!, { name, shared: this.saveShared, isDefault: this.saveDefault });
      } else {
        id = this.store.nextId(d);
        d.filters.push({
          id, name, ownerId: me, shared: this.saveShared, isDefault: this.saveDefault, projectId: this.ws.projectId(),
          criteria: this.nonDefaultCriteria(), columns: this.columns(), sort: this.sort(),
        });
      }
    });
    this.saveDlg().close();
    this.toasts.success(this.i18n.t('filters.saved', { name }));
    if (!editing) this.navigate({ ...this.params(), filter: String(id) });
  }

  protected updateSaved(f: SavedFilter) {
    this.store.mutate((d) => Object.assign(d.filters.find((x) => x.id === f.id)!, {
      criteria: this.nonDefaultCriteria(), columns: this.columns(), sort: this.sort(),
    }));
    this.toasts.success(this.i18n.t('filters.saved', { name: f.name }));
  }

  protected setDefault(f: SavedFilter) {
    this.store.mutate((d) => d.filters.forEach((x) => x.ownerId === f.ownerId && (x.isDefault = x.id === f.id)));
  }

  protected async deleteSaved(f: SavedFilter) {
    const ok = await this.confirm.ask({ title: this.i18n.t('filters.delete'), message: f.name, danger: true, confirm: this.i18n.t('common.delete') });
    if (!ok) return;
    this.store.mutate((d) => (d.filters = d.filters.filter((x) => x.id !== f.id)));
    this.reset();
  }

  private nonDefaultCriteria(): Partial<FilterCriteria> {
    const def = emptyCriteria() as unknown as Record<string, unknown>;
    return Object.fromEntries(Object.entries(this.c()).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(def[k]))) as Partial<FilterCriteria>;
  }

  // ---------- bulk ----------

  protected bulkAssign(userId: number | null) {
    this.actions.assign(this.selection(), userId);
  }

  protected bulkStatus(sel: HTMLSelectElement) {
    if (sel.value) this.actions.bulkStatus(this.selection(), sel.value as Status);
    sel.value = '';
  }

  protected bulkField(field: 'priority' | 'severity', sel: HTMLSelectElement) {
    if (sel.value) {
      const patch = field === 'priority' ? { priority: sel.value as Priority } : { severity: sel.value as Severity };
      this.actions.bulkUpdate(this.selection(), patch, this.i18n.t('fields.' + field));
    }
    sel.value = '';
  }

  protected bulkSprint(sel: HTMLSelectElement) {
    if (sel.value) this.actions.bulkUpdate(this.selection(), { sprintId: sel.value === 'none' ? null : +sel.value }, this.i18n.t('fields.sprintId'));
    sel.value = '';
  }

  protected bulkVersion(sel: HTMLSelectElement) {
    if (sel.value) this.actions.bulkUpdate(this.selection(), { targetVersion: sel.value === '-' ? '' : sel.value }, this.i18n.t('fields.targetVersion'));
    sel.value = '';
  }

  protected bulkMove(sel: HTMLSelectElement) {
    if (sel.value) this.actions.move(this.selection(), +sel.value);
    sel.value = '';
  }

  protected bulkTag(add: boolean) {
    const tag = prompt(this.i18n.t(add ? 'bulk.addTag' : 'bulk.removeTag'));
    if (!tag) return;
    if (add) this.actions.addTag(this.selection(), tag);
    else this.actions.removeTag(this.selection(), tag.trim().toLowerCase());
  }

  protected bulkClone() {
    for (const id of this.selection()) this.actions.clone(id, { copyNotes: false, copyAttachments: true });
    this.toasts.success(this.i18n.t('toast.cloned', { count: this.selection().length }));
  }

  protected async bulkDelete() {
    const n = this.selection().length;
    const ok = await this.confirm.ask({
      title: this.i18n.t('common.delete'), message: this.i18n.t('bulk.deleteConfirm', { count: n }), danger: true, confirm: this.i18n.t('common.delete'),
    });
    if (ok) {
      this.actions.remove(this.selection());
      this.selection.set([]);
    }
  }

  // ---------- export / import ----------

  protected exportCsv(list: Issue[]) {
    const cols: ColumnId[] = ['id', 'project', 'category', 'summary', 'status', 'resolution', 'priority', 'severity', 'reproducibility',
      'reporter', 'handler', 'sprint', 'targetVersion', 'fixedInVersion', 'tags', 'created', 'updated', 'dueDate', 'storyPoints'];
    const t = (k: string) => this.i18n.t(k);
    const u = (id: number | null) => (id ? this.store.userMap().get(id)?.username ?? '' : '');
    const rows = list.map((i) => [
      this.store.issueKey(i), this.store.projectMap().get(i.projectId)?.name, i.category, i.summary, t('status.' + i.status),
      t('resolution.' + i.resolution), t('priority.' + i.priority), t('severity.' + i.severity), t('reproducibility.' + i.reproducibility),
      u(i.reporterId), u(i.handlerId), i.sprintId ? this.store.sprintMap().get(i.sprintId)?.name : '', i.targetVersion, i.fixedInVersion,
      i.tags.join(' '), i.created, i.updated, i.dueDate, i.storyPoints,
    ]);
    downloadText(`issues-${new Date().toISOString().slice(0, 10)}.csv`, toCsv([[...cols.map((c) => t('columns.' + c)), t('fields.description')],
      ...rows.map((r, k) => [...r, plainText(list[k].description)])]));
  }

  protected exportJson(list: Issue[]) {
    downloadText(`issues-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(list, null, 2), 'application/json');
  }

  protected print() {
    window.print();
  }

  protected openImport() {
    this.csvRows.set([]);
    this.importProject = this.ws.projectId() ?? this.ws.visibleProjects()[0]?.id ?? 0;
    this.importDlg().open();
  }

  protected async readCsv(input: HTMLInputElement) {
    const file = input.files?.[0];
    if (!file) return;
    const rows = parseCsv(await file.text());
    this.csvRows.set(rows);
    // Guess mapping from header names.
    this.mapping.set((rows[0] ?? []).map((h) => {
      const n = h.toLowerCase().replace(/[^a-z]/g, '');
      return this.importFields.find((f) => n === f.toLowerCase() || n === this.i18n.t('fields.' + f).toLowerCase().replace(/[^a-z]/g, ''))
        ?? (n === 'assignee' || n === 'handler' || n === 'assignedto' ? 'handlerId' : n === 'title' ? 'summary' : '');
    }));
  }

  protected setMapping(i: number, v: string) {
    const m = [...this.mapping()];
    m[i] = v;
    this.mapping.set(m);
  }

  protected runImport() {
    const project = this.store.projectMap().get(this.importProject);
    if (!project) return;
    const [, ...rows] = this.csvRows();
    const m = this.mapping();
    const pick = <T extends string>(list: readonly T[], v: string, def: T, prefix: string): T =>
      list.find((x) => x === v.toLowerCase() || this.i18n.t(prefix + x).toLowerCase() === v.toLowerCase()) ?? def;
    let count = 0;
    for (const r of rows) {
      const get = (f: string) => (m.indexOf(f) >= 0 ? (r[m.indexOf(f)] ?? '').trim() : '');
      if (!get('summary')) continue;
      const handler = this.store.users().find((u) => u.username === get('handlerId'));
      const created = this.actions.report({
        projectId: project.id, sprintId: null, category: project.categories.find((c) => c.name === get('category'))?.name ?? project.categories[0]?.name ?? '',
        summary: get('summary').slice(0, 128), description: get('description') ? doc(get('description')) : null, stepsToReproduce: null, additionalInfo: null,
        status: pick(STATUSES, get('status'), 'new', 'status.'), resolution: 'open', priority: pick(PRIORITIES, get('priority'), 'normal', 'priority.'),
        severity: pick(SEVERITIES, get('severity'), 'minor', 'severity.'), reproducibility: 'have_not_tried', platform: '', os: '', osBuild: '',
        productVersion: '', targetVersion: '', fixedInVersion: '', handlerId: handler?.id ?? null, viewState: 'public',
        tags: get('tags').split(/[\s,;]+/).filter(Boolean), dueDate: /^\d{4}-\d{2}-\d{2}$/.test(get('dueDate')) ? get('dueDate') : null,
        estimate: null, storyPoints: get('storyPoints') ? Number(get('storyPoints')) || null : null, customFields: {},
      });
      if (created) count++;
    }
    this.importDlg().close();
    this.toasts.success(this.i18n.t('import.done', { count }));
  }
}

function readColumns(): ColumnId[] {
  try {
    const cols = JSON.parse(localStorage.getItem(COLS_KEY) ?? 'null') as ColumnId[] | null;
    if (cols?.length) return cols.filter((c) => ALL_COLUMNS.includes(c));
  } catch { /* ignore */ }
  return DEFAULT_COLUMNS;
}
