import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store } from '../../core/store.service';
import { Workspace } from '../../core/workspace.service';
import { PRIORITIES, SEVERITIES, STATUSES, isResolved } from '../../core/config';
import { createdVsResolved, daysBetween, resolvedDates } from '../../core/metrics';
import type { Issue } from '../../core/models';
import { I18n, TPipe } from '../../i18n/i18n.service';
import { Icon } from '../../shared/icon/icon';
import { BarChart } from '../../shared/bar-chart/bar-chart';
import { LineChart } from '../../shared/line-chart/line-chart';
import { StatusBadge, UserChip } from '../../shared/ui';

/** MantisBT "Summary": statistics tables + charts for the current project scope. */
@Component({
  selector: 'app-summary',
  imports: [RouterLink, TPipe, Icon, BarChart, LineChart, StatusBadge, UserChip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './summary.html',
  styleUrl: './summary.css',
})
export class Summary {
  protected readonly store = inject(Store);
  protected readonly ws = inject(Workspace);
  private readonly i18n = inject(I18n);
  protected readonly statuses = STATUSES;

  protected readonly list = computed(() => this.ws.scopedIssues());
  protected readonly open = computed(() => this.list().filter((i) => !isResolved(i.status)));
  private readonly resolved = computed(() => resolvedDates(this.list(), this.store.history()));
  protected readonly trend = computed(() => createdVsResolved(this.list(), this.resolved()));
  protected readonly avgDays = computed(() => {
    const r = this.list().filter((i) => this.resolved().has(i.id));
    if (!r.length) return '—';
    return Math.round(r.reduce((s, i) => s + daysBetween(i.created, this.resolved().get(i.id)!), 0) / r.length);
  });
  protected readonly reopenRate = computed(() => {
    const ids = new Set(this.list().map((i) => i.id));
    const reopened = new Set(this.store.history().filter((h) => ids.has(h.issueId) && h.field === 'resolution' && h.new === 'reopened').map((h) => h.issueId));
    const everResolved = this.resolved().size + reopened.size;
    return everResolved ? Math.round((reopened.size / everResolved) * 100) : 0;
  });

  private bars<T extends string>(values: readonly T[], get: (i: Issue) => T, prefix: string, color: (v: T) => string) {
    return values.map((v) => ({ label: this.i18n.t(prefix + v), value: this.list().filter((i) => get(i) === v).length, color: color(v) }));
  }
  protected readonly byStatus = computed(() => this.bars(STATUSES, (i) => i.status, 'status.', (s) => `var(--status-${s})`));
  protected readonly byPriority = computed(() => this.bars(PRIORITIES, (i) => i.priority, 'priority.', (p) => `var(--priority-${p})`).filter((b) => b.value));
  protected readonly bySeverity = computed(() => this.bars(SEVERITIES, (i) => i.severity, 'severity.', (s) => `var(--severity-${s})`).filter((b) => b.value));
  protected readonly byCategory = computed(() => {
    const m = new Map<string, number>();
    for (const i of this.open()) m.set(i.category, (m.get(i.category) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([label, value]) => ({ label, value, color: 'var(--chart-1)' }));
  });
  protected readonly byResolution = computed(() => {
    const m = new Map<string, number>();
    for (const i of this.list().filter((x) => isResolved(x.status))) m.set(i.resolution, (m.get(i.resolution) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]).map(([r, value]) => ({ label: this.i18n.t('resolution.' + r), value, color: 'var(--chart-3)' }));
  });
  protected readonly byProject = computed(() => {
    const ids = [...new Set(this.list().map((i) => i.projectId))];
    return ids.map((id) => {
      const l = this.list().filter((i) => i.projectId === id);
      return { id, name: this.store.projectMap().get(id)?.name ?? '', counts: STATUSES.map((s) => l.filter((i) => i.status === s).length), total: l.length };
    });
  });
  protected readonly byHandler = computed(() => {
    const m = new Map<number, { id: number; open: number; resolved: number; pct: number }>();
    for (const i of this.list()) {
      const r = m.get(i.handlerId ?? 0) ?? { id: i.handlerId ?? 0, open: 0, resolved: 0, pct: 0 };
      if (isResolved(i.status)) r.resolved++;
      else r.open++;
      m.set(r.id, r);
    }
    return [...m.values()].map((r) => ({ ...r, pct: Math.round((r.resolved / (r.open + r.resolved)) * 100) })).sort((a, b) => b.open - a.open);
  });
  protected readonly byReporter = computed(() => {
    const m = new Map<number, { id: number; total: number; open: number }>();
    for (const i of this.list()) {
      const r = m.get(i.reporterId) ?? { id: i.reporterId, total: 0, open: 0 };
      r.total++;
      if (!isResolved(i.status)) r.open++;
      m.set(r.id, r);
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  });
  protected readonly longestOpen = computed(() => [...this.open()].sort((a, b) => a.created.localeCompare(b.created)).slice(0, 8));
  protected readonly mostActive = computed(() => {
    const counts = new Map<number, number>();
    for (const h of this.store.history()) counts.set(h.issueId, (counts.get(h.issueId) ?? 0) + 1);
    return this.list().map((issue) => ({ issue, n: counts.get(issue.id) ?? 0 })).sort((a, b) => b.n - a.n).slice(0, 8);
  });

  protected age(i: Issue) {
    return daysBetween(i.created, new Date().toISOString());
  }
}
