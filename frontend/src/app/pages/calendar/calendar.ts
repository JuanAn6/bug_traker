import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store } from '../../core/store.service';
import { Workspace } from '../../core/workspace.service';
import { COMPACT_COLUMNS, isResolved } from '../../core/config';
import { FmtDatePipe, I18n, TPipe } from '../../i18n/i18n.service';
import { Icon } from '../../shared/icon/icon';
import { IssueTable } from '../../shared/issue-table/issue-table';

interface Day { key: string; num: number; other: boolean; issues: ReturnType<Workspace['scopedIssues']>; sprints: { id: number; label: string }[]; }

/** Month view of issue due dates and sprint boundaries. */
@Component({
  selector: 'app-calendar',
  imports: [RouterLink, TPipe, FmtDatePipe, Icon, IssueTable],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './calendar.html',
  styleUrl: './calendar.css',
})
export class Calendar {
  protected readonly store = inject(Store);
  private readonly ws = inject(Workspace);
  private readonly i18n = inject(I18n);
  protected readonly columns = [...COMPACT_COLUMNS, 'handler' as const];
  protected readonly todayKey = localKey(new Date());
  protected readonly month = signal(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  protected readonly selected = signal(this.todayKey);
  protected readonly hideResolved = signal(false);
  protected readonly monthIso = computed(() => localKey(this.month()));

  protected readonly weekdays = computed(() => {
    const fmt = new Intl.DateTimeFormat(this.i18n.lang(), { weekday: 'short' });
    // 2024-01-01 was a Monday.
    return Array.from({ length: 7 }, (_, k) => fmt.format(new Date(2024, 0, 1 + k)));
  });

  protected readonly days = computed<Day[]>(() => {
    const first = this.month();
    const start = new Date(first);
    start.setDate(1 - ((first.getDay() + 6) % 7));
    const issues = this.ws.scopedIssues().filter((i) => i.dueDate && (!this.hideResolved() || !isResolved(i.status)));
    const scope = this.ws.scopeIds();
    const sprints = this.store.sprints().filter((s) => !scope || scope.has(s.projectId));
    return Array.from({ length: 42 }, (_, k) => {
      const d = new Date(start);
      d.setDate(start.getDate() + k);
      const key = localKey(d);
      return {
        key, num: d.getDate(), other: d.getMonth() !== first.getMonth(),
        issues: issues.filter((i) => i.dueDate === key),
        sprints: sprints.flatMap((s) => [
          ...(s.start === key ? [{ id: s.id, label: '▶ ' + s.name }] : []),
          ...(s.end === key ? [{ id: s.id, label: '■ ' + s.name }] : []),
        ]),
      };
    });
  });
  protected readonly selectedDay = computed(() => this.days().find((d) => d.key === this.selected()));

  protected shift(n: number) {
    const m = this.month();
    this.month.set(new Date(m.getFullYear(), m.getMonth() + n, 1));
  }

  protected today() {
    const now = new Date();
    this.month.set(new Date(now.getFullYear(), now.getMonth(), 1));
    this.selected.set(this.todayKey);
  }
}

function localKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
