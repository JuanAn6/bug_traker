import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Store } from '../../core/store.service';
import { Workspace } from '../../core/workspace.service';
import { Permissions } from '../../core/permissions.service';
import { Projects } from '../../core/project.service';
import { Tabs } from '../../core/tabs.service';
import { Toasts } from '../../core/toast.service';
import { DirtyAware } from '../../core/guards';
import { ACCESS_LEVELS, ACCESS_NAMES, PROJECT_STATUSES, STATUSES, isResolved } from '../../core/config';
import type { AccessLevel, Project } from '../../core/models';
import { FmtDatePipe, I18n, TPipe } from '../../i18n/i18n.service';
import { Icon } from '../../shared/icon/icon';
import { RichEditor } from '../../shared/rich/rich-editor/rich-editor';
import { BarChart } from '../../shared/bar-chart/bar-chart';
import { Confirm, Empty, StatusBadge, UserChip, UserSelect } from '../../shared/ui';
import { SprintDialog } from '../sprint-dialog/sprint-dialog';

type Tab = 'general' | 'categories' | 'versions' | 'members' | 'sprints' | 'fields' | 'stats';

@Component({
  selector: 'app-project-edit',
  imports: [FormsModule, RouterLink, TPipe, FmtDatePipe, Icon, RichEditor, BarChart, Empty, StatusBadge, UserChip, UserSelect, SprintDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './project-edit.html',
  styleUrl: './project-edit.css',
})
export class ProjectEdit implements DirtyAware {
  protected readonly store = inject(Store);
  protected readonly perm = inject(Permissions);
  protected readonly svc = inject(Projects);
  private readonly ws = inject(Workspace);
  private readonly tabs = inject(Tabs);
  private readonly toasts = inject(Toasts);
  private readonly confirm = inject(Confirm);
  private readonly i18n = inject(I18n);
  private readonly router = inject(Router);

  readonly id = input.required<string>();
  protected readonly sprintDlg = viewChild.required(SprintDialog);

  protected readonly tabList: { id: Tab; icon: string }[] = [
    { id: 'general', icon: 'info' }, { id: 'categories', icon: 'box' }, { id: 'versions', icon: 'flag' }, { id: 'members', icon: 'users' },
    { id: 'sprints', icon: 'zap' }, { id: 'fields', icon: 'columns' }, { id: 'stats', icon: 'chart' },
  ];
  protected readonly projectStatuses = PROJECT_STATUSES;
  protected readonly levels = ACCESS_LEVELS;
  protected readonly names = ACCESS_NAMES;
  protected readonly tab = signal<Tab>('general');

  protected readonly original = computed(() => {
    const p = this.store.projectMap().get(Number(this.id()));
    return p && this.ws.visibleProjects().some((x) => x.id === p.id) ? p : null;
  });
  protected readonly draft = signal<Project | null>(null);
  /** Original names aligned with draft rows, to propagate renames to issues. */
  protected catOrig: (string | null)[] = [];
  protected verOrig: (string | null)[] = [];
  private merges: Record<string, string> = {};
  protected readonly dirty = signal(false);
  protected newMember: number | null = null;
  protected newMemberLevel: AccessLevel = 55;

  protected readonly canManage = computed(() => this.perm.can('manageProject', this.original()?.id));
  protected readonly parentOptions = computed(() => {
    const id = this.original()?.id;
    // Prevent cycles: a project can't become a child of itself or its descendants.
    const blocked = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of this.store.projects()) if (p.parentId !== null && blocked.has(p.parentId) && !blocked.has(p.id)) { blocked.add(p.id); grew = true; }
    }
    return this.ws.visibleProjects().filter((p) => !blocked.has(p.id));
  });
  protected readonly sprints = computed(() => this.store.sprints().filter((s) => s.projectId === this.original()?.id).sort((a, b) => b.start.localeCompare(a.start)));
  protected readonly nonMembers = computed(() => {
    this.dirty();
    const members = new Set(this.draft()?.members.map((m) => m.userId));
    return this.store.users().filter((u) => !members.has(u.id)).map((u) => u.id);
  });
  protected readonly stats = computed(() => {
    const list = this.store.issues().filter((i) => i.projectId === this.original()?.id);
    return {
      byStatus: STATUSES.map((status) => ({ status, count: list.filter((i) => i.status === status).length })),
      byCategory: (this.original()?.categories ?? []).map((c, k) => ({
        label: c.name, value: list.filter((i) => i.category === c.name && !isResolved(i.status)).length, color: `var(--chart-${(k % 6) + 1})`,
      })),
    };
  });

  constructor() {
    effect(() => {
      const p = this.original();
      untracked(() => {
        if (!p) return;
        if (!this.dirty()) this.revert();
        this.tabs.setTitle(p.name);
      });
    });
  }

  isDirty(): boolean {
    return this.dirty();
  }

  protected touch() {
    this.dirty.set(true);
    this.tabs.setDirty(true);
    this.draft.update((d) => (d ? { ...d } : d));
  }

  protected error(): string {
    const d = this.draft();
    if (!d) return '';
    if (!d.name.trim()) return this.i18n.t('projects.nameRequired');
    if (!/^[A-Za-z][A-Za-z0-9]{1,9}$/.test(d.key)) return this.i18n.t('projects.keyInvalid');
    if (this.svc.keyTaken(d.key, d.id)) return this.i18n.t('projects.keyTaken');
    const cats = d.categories.map((c) => c.name.trim());
    if (cats.some((c) => !c) || new Set(cats).size !== cats.length) return this.i18n.t('projects.categoryInvalid');
    const vers = d.versions.map((v) => v.name.trim());
    if (vers.some((v) => !v) || new Set(vers).size !== vers.length) return this.i18n.t('projects.versionInvalid');
    return '';
  }

  protected revert() {
    const p = this.original();
    if (!p) return;
    this.draft.set(structuredClone(p));
    this.catOrig = p.categories.map((c) => c.name);
    this.verOrig = p.versions.map((v) => v.name);
    this.merges = {};
    this.dirty.set(false);
    this.tabs.setDirty(false);
  }

  protected save() {
    const d = this.draft();
    if (!d || this.error()) return;
    const categories: Record<string, string> = { ...this.merges };
    d.categories.forEach((c, i) => (c.name = c.name.trim()));
    d.categories.forEach((c, i) => this.catOrig[i] && this.catOrig[i] !== c.name && (categories[this.catOrig[i]!] = c.name));
    const versions: Record<string, string> = {};
    d.versions.forEach((v, i) => this.verOrig[i] && this.verOrig[i] !== v.name.trim() && (versions[this.verOrig[i]!] = v.name.trim()));
    this.svc.save({ ...d, name: d.name.trim(), versions: d.versions.map((v) => ({ ...v, name: v.name.trim() })) }, { categories, versions });
    this.dirty.set(false);
    this.tabs.setDirty(false);
    this.revert();
    this.toasts.success(this.i18n.t('projects.saved', { name: d.name }));
  }

  protected addCategory(input: HTMLInputElement) {
    const name = input.value.trim();
    const d = this.draft()!;
    if (!name || d.categories.some((c) => c.name === name)) return;
    d.categories.push({ name, defaultHandlerId: null });
    this.catOrig.push(null);
    input.value = '';
    this.touch();
  }

  protected async removeCategory(i: number) {
    const d = this.draft()!;
    const orig = this.catOrig[i];
    const count = orig ? this.svc.issueCount(d.id, orig) : 0;
    if (count) {
      const others = d.categories.filter((_, k) => k !== i);
      const target = await this.confirm.ask({
        title: this.i18n.t('projects.deleteCategory'), message: this.i18n.t('projects.mergeCategory', { count, name: orig }),
        choices: others.map((c) => ({ label: c.name, value: c.name })),
      });
      if (!target) return;
      this.merges[orig!] = target;
    }
    d.categories.splice(i, 1);
    this.catOrig.splice(i, 1);
    this.touch();
  }

  protected addVersion(input: HTMLInputElement) {
    const name = input.value.trim();
    const d = this.draft()!;
    if (!name || d.versions.some((v) => v.name === name)) return;
    d.versions.push({ name, date: null, released: false, obsolete: false, description: '' });
    this.verOrig.push(null);
    input.value = '';
    this.touch();
  }

  protected moveVersion(i: number, delta: number) {
    const d = this.draft()!;
    [d.versions[i], d.versions[i + delta]] = [d.versions[i + delta], d.versions[i]];
    [this.verOrig[i], this.verOrig[i + delta]] = [this.verOrig[i + delta], this.verOrig[i]];
    this.touch();
  }

  protected async removeVersion(i: number) {
    const d = this.draft()!;
    const orig = this.verOrig[i];
    const count = orig ? this.svc.issueCount(d.id, undefined, orig) : 0;
    if (count) {
      const ok = await this.confirm.ask({
        title: this.i18n.t('projects.deleteVersion'), message: this.i18n.t('projects.deleteVersionConfirm', { count, name: orig }), danger: true,
      });
      if (!ok) return;
    }
    d.versions.splice(i, 1);
    this.verOrig.splice(i, 1);
    this.touch();
  }

  protected addMember() {
    if (!this.newMember) return;
    this.draft()!.members.push({ userId: this.newMember, accessLevel: this.newMemberLevel });
    this.newMember = null;
    this.touch();
  }

  protected toggleField(id: number) {
    const d = this.draft()!;
    d.customFieldIds = d.customFieldIds.includes(id) ? d.customFieldIds.filter((x) => x !== id) : [...d.customFieldIds, id];
    this.touch();
  }

  protected accessName(level: AccessLevel | undefined) {
    return ACCESS_NAMES[level ?? 10];
  }
}
