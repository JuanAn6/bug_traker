import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Store } from '../../core/store.service';
import { Permissions } from '../../core/permissions.service';
import { Workspace } from '../../core/workspace.service';
import { IssueActions } from '../../core/issue-actions.service';
import { Sprints } from '../../core/sprint.service';
import { Tabs } from '../../core/tabs.service';
import { COMPACT_COLUMNS, isResolved } from '../../core/config';
import { burndown, daysBetween, points, resolvedDates } from '../../core/metrics';
import type { Issue } from '../../core/models';
import { FmtDatePipe, I18n, TPipe } from '../../i18n/i18n.service';
import { Icon } from '../../shared/icon/icon';
import { IssueTable } from '../../shared/issue-table/issue-table';
import { LineChart } from '../../shared/line-chart/line-chart';
import { Confirm, Dialog, Empty, PriorityLabel, StatusBadge } from '../../shared/ui';
import { SprintDialog } from '../sprint-dialog/sprint-dialog';

@Component({
  selector: 'app-sprint-detail',
  imports: [FormsModule, RouterLink, TPipe, FmtDatePipe, Icon, IssueTable, LineChart, Dialog, Empty, PriorityLabel, StatusBadge, SprintDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sprint-detail.html',
  styleUrl: './sprint-detail.css',
})
export class SprintDetail {
  protected readonly store = inject(Store);
  protected readonly svc = inject(Sprints);
  private readonly perm = inject(Permissions);
  private readonly ws = inject(Workspace);
  private readonly actions = inject(IssueActions);
  private readonly tabs = inject(Tabs);
  private readonly confirm = inject(Confirm);
  private readonly i18n = inject(I18n);
  private readonly router = inject(Router);

  readonly id = input.required<string>();
  protected readonly edit = viewChild.required(SprintDialog);
  protected readonly completeDlg = viewChild.required<Dialog>('completeDlg');
  protected readonly columns = [...COMPACT_COLUMNS.slice(0, 4), 'handler' as const, 'storyPoints' as const];

  protected readonly sprint = computed(() => {
    const s = this.store.sprintMap().get(Number(this.id()));
    return s && this.ws.visibleProjects().some((p) => p.id === s.projectId) ? s : null;
  });
  protected readonly project = computed(() => this.store.projectMap().get(this.sprint()?.projectId ?? 0));
  protected readonly canManage = computed(() => this.perm.can('manageSprints', this.sprint()?.projectId));
  protected readonly scope = computed(() => this.ws.visibleIssues().filter((i) => i.sprintId === this.sprint()?.id));
  protected readonly bd = computed(() => burndown(this.sprint()!, this.store.issues(), resolvedDates(this.store.issues(), this.store.history())));
  protected readonly pct = computed(() => (this.bd().total ? Math.round((this.bd().done / this.bd().total) * 100) : 0));
  protected readonly daysLeft = computed(() => Math.max(0, daysBetween(new Date().toISOString().slice(0, 10), this.sprint()!.end)));
  protected readonly byStatus = computed(() => {
    const m = new Map<Issue['status'], number>();
    for (const i of this.scope()) m.set(i.status, (m.get(i.status) ?? 0) + 1);
    return [...m].map(([status, count]) => ({ status, count }));
  });
  protected readonly unfinished = computed(() => this.scope().filter((i) => !isResolved(i.status)));
  protected readonly otherSprints = computed(() =>
    this.store.sprints().filter((s) => s.projectId === this.sprint()?.projectId && s.id !== this.sprint()?.id && s.state !== 'closed'));

  protected readonly backlogQuery = signal('');
  protected dragId = 0;
  protected readonly dropPane = signal('');
  protected completeTarget: number | null = null;

  protected readonly panes = computed(() => {
    const s = this.sprint()!;
    const backlog = this.ws.visibleIssues().filter((i) => i.projectId === s.projectId && i.sprintId === null && !isResolved(i.status));
    const q = this.backlogQuery().toLowerCase();
    const filtered = q ? backlog.filter((i) => i.summary.toLowerCase().includes(q)) : backlog;
    return [
      { id: 'backlog', title: this.i18n.t('sprints.backlog'), issues: filtered, points: backlog.reduce((n, i) => n + points(i), 0) },
      { id: 'sprint', title: s.name, issues: this.scope(), points: this.bd().total },
    ];
  });

  constructor() {
    effect(() => {
      const s = this.sprint();
      untracked(() => s && this.tabs.setTitle(s.name));
    });
  }

  protected moveIssue(i: Issue, to: string) {
    this.actions.update(i.id, { sprintId: to === 'sprint' ? this.sprint()!.id : null });
  }

  protected drop(pane: string) {
    this.dropPane.set('');
    const i = this.store.issueMap().get(this.dragId);
    if (i && (pane === 'sprint') !== (i.sprintId === this.sprint()!.id)) this.moveIssue(i, pane);
    this.dragId = 0;
  }

  protected openComplete() {
    this.completeTarget = this.otherSprints().find((s) => s.state === 'planned')?.id ?? null;
    this.completeDlg().open();
  }

  protected complete() {
    this.svc.complete(this.sprint()!.id, this.completeTarget);
    this.completeDlg().close();
  }

  protected async remove() {
    const s = this.sprint()!;
    const ok = await this.confirm.ask({
      title: this.i18n.t('sprints.delete'), message: this.i18n.t('sprints.deleteConfirm', { name: s.name }), danger: true, confirm: this.i18n.t('common.delete'),
    });
    if (!ok) return;
    const key = this.tabs.activeKey();
    this.svc.remove(s.id);
    this.tabs.drop(key);
    this.router.navigate(['/sprints']);
  }
}
