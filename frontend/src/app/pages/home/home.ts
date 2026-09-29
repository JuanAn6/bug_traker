import { ChangeDetectionStrategy, Component, computed, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store } from '../../core/store.service';
import { Auth } from '../../core/auth.service';
import { Workspace } from '../../core/workspace.service';
import { Permissions } from '../../core/permissions.service';
import { Notifications } from '../../core/notifications.service';
import { COMPACT_COLUMNS, HOME_WIDGETS, STATUSES, isResolved } from '../../core/config';
import { filterIssues, isOverdue } from '../../core/issue-filter';
import { burndown, daysBetween, resolvedDates } from '../../core/metrics';
import type { FilterCriteria, HomeWidget, Issue, SortKey } from '../../core/models';
import { I18n, RelTimePipe, TPipe } from '../../i18n/i18n.service';
import { Icon } from '../../shared/icon/icon';
import { IssueTable } from '../../shared/issue-table/issue-table';
import { Dialog, UserChip } from '../../shared/ui';
import { LineChart } from '../../shared/line-chart/line-chart';
import { HistoryFormat } from '../../shared/history-format';

interface WidgetDef { criteria: Partial<FilterCriteria>; sort: SortKey[]; icon: string; }

const WIDGETS: Record<HomeWidget, WidgetDef> = {
  assigned: { criteria: { handlerIds: [-1], hideStatus: 'resolved' }, sort: [{ column: 'priority', dir: 'desc' }], icon: 'user' },
  reported: { criteria: { reporterIds: [-1], hideStatus: 'closed' }, sort: [{ column: 'updated', dir: 'desc' }], icon: 'edit' },
  unassigned: { criteria: { handlerIds: [0], hideStatus: 'resolved' }, sort: [{ column: 'priority', dir: 'desc' }], icon: 'inbox' },
  recent: { criteria: { hideStatus: '' }, sort: [{ column: 'updated', dir: 'desc' }], icon: 'clock' },
  monitored: { criteria: { monitorId: -1, hideStatus: 'closed' }, sort: [{ column: 'updated', dir: 'desc' }], icon: 'eye' },
  feedback: { criteria: { reporterIds: [-1], statuses: ['feedback', 'resolved'] }, sort: [{ column: 'updated', dir: 'desc' }], icon: 'message' },
  due: { criteria: { hideStatus: 'resolved', dueTo: '' }, sort: [{ column: 'dueDate', dir: 'asc' }], icon: 'calendar' },
};

@Component({
  selector: 'app-home',
  imports: [RouterLink, TPipe, RelTimePipe, Icon, IssueTable, UserChip, Dialog, LineChart],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home.html',
  styleUrl: './home.css',
})
export class Home {
  protected readonly store = inject(Store);
  protected readonly auth = inject(Auth);
  protected readonly ws = inject(Workspace);
  protected readonly perm = inject(Permissions);
  protected readonly notif = inject(Notifications);
  protected readonly fmt = inject(HistoryFormat);
  private readonly i18n = inject(I18n);
  protected readonly customize = viewChild.required<Dialog>('customizeDlg');
  protected readonly columns = COMPACT_COLUMNS;
  protected readonly weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

  private readonly ctx = computed(() => ({
    meId: this.auth.me().id, projects: this.store.projects(), attachmentCounts: this.store.attachmentCounts(),
  }));

  protected readonly widgets = computed(() => {
    const issues = this.ws.scopedIssues();
    const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    return (this.auth.prefs()?.homeWidgets ?? []).map((key) => {
      const def = WIDGETS[key];
      const criteria = key === 'due' ? { ...def.criteria, dueTo: soon, dueFrom: '0000-01-01' } : def.criteria;
      let list: Issue[] = filterIssues(issues, criteria, this.ctx());
      if (key === 'recent') list = [...list].sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 20);
      const params: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(criteria)) params[k] = Array.isArray(v) ? v.join(',') : String(v ?? '');
      return { key, def, issues: list, params };
    });
  });

  protected readonly kpi = computed(() => {
    const list = this.ws.scopedIssues();
    const me = this.auth.me().id;
    const open = list.filter((i) => !isResolved(i.status));
    const resolved = resolvedDates(list, this.store.history());
    return {
      open: open.length,
      mine: open.filter((i) => i.handlerId === me).length,
      overdue: open.filter((i) => isOverdue(i)).length,
      unassigned: open.filter((i) => !i.handlerId).length,
      resolvedWeek: [...resolved.values()].filter((d) => d.slice(0, 10) >= this.weekAgo).length,
    };
  });

  protected readonly sprintCards = computed(() => {
    const scope = this.ws.scopeIds();
    const resolved = resolvedDates(this.store.issues(), this.store.history());
    const today = new Date().toISOString().slice(0, 10);
    return this.store.sprints()
      .filter((s) => s.state === 'active' && (!scope || scope.has(s.projectId)) && this.ws.visibleProjects().some((p) => p.id === s.projectId))
      .map((sprint) => {
        const bd = burndown(sprint, this.store.issues(), resolved);
        return {
          sprint, bd, project: this.store.projectMap().get(sprint.projectId)?.key ?? '',
          pct: bd.total ? Math.round((bd.done / bd.total) * 100) : 0, daysLeft: Math.max(0, daysBetween(today, sprint.end)),
        };
      });
  });

  protected readonly statusDist = computed(() => {
    const list = this.ws.scopedIssues();
    return STATUSES.map((status) => ({ status, count: list.filter((i) => i.status === status).length }));
  });

  protected readonly activity = computed(() => {
    const visible = new Set(this.ws.scopedIssues().map((i) => i.id));
    return this.store.history().filter((h) => visible.has(h.issueId)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 15);
  });

  protected readonly unreadNotifications = computed(() => this.notif.mine().filter((n) => !n.read).slice(0, 5));

  // Customize dialog state
  protected readonly order = signal<HomeWidget[]>([]);
  protected readonly enabled = signal(new Set<HomeWidget>());

  constructor() {
    const current = this.auth.prefs()?.homeWidgets ?? [];
    this.order.set([...current, ...HOME_WIDGETS.filter((w) => !current.includes(w))]);
    this.enabled.set(new Set(current));
  }

  protected toggleWidget(w: HomeWidget) {
    const s = new Set(this.enabled());
    if (s.has(w)) s.delete(w);
    else s.add(w);
    this.enabled.set(s);
  }

  protected moveWidget(i: number, delta: number) {
    const o = [...this.order()];
    [o[i], o[i + delta]] = [o[i + delta], o[i]];
    this.order.set(o);
  }

  protected saveWidgets() {
    this.auth.updatePrefs({ homeWidgets: this.order().filter((w) => this.enabled().has(w)) });
    this.customize().close();
  }
}
