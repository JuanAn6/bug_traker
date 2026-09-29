import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store } from '../../core/store.service';
import { Workspace } from '../../core/workspace.service';
import { Permissions } from '../../core/permissions.service';
import { Tabs } from '../../core/tabs.service';
import { ACCESS_NAMES, COMPACT_COLUMNS, isResolved } from '../../core/config';
import { levelIn } from '../../core/permissions.service';
import { FmtDatePipe, I18n, RelTimePipe, TPipe } from '../../i18n/i18n.service';
import { Icon } from '../../shared/icon/icon';
import { IssueTable } from '../../shared/issue-table/issue-table';
import { HistoryFormat } from '../../shared/history-format';
import { Avatar, Empty } from '../../shared/ui';

type Tab = 'assigned' | 'reported' | 'monitored' | 'activity';

@Component({
  selector: 'app-user-detail',
  imports: [RouterLink, TPipe, FmtDatePipe, RelTimePipe, Icon, IssueTable, Avatar, Empty],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './user-detail.html',
  styleUrl: './user-detail.css',
})
export class UserDetail {
  protected readonly store = inject(Store);
  protected readonly perm = inject(Permissions);
  protected readonly i18n = inject(I18n);
  protected readonly fmt = inject(HistoryFormat);
  private readonly ws = inject(Workspace);
  private readonly tabs = inject(Tabs);
  readonly id = input.required<string>();
  protected readonly names = ACCESS_NAMES;
  protected readonly columns = [...COMPACT_COLUMNS.slice(0, 3), 'project' as const, 'summary' as const, 'updated' as const];
  protected readonly tabList: Tab[] = ['assigned', 'reported', 'monitored', 'activity'];
  protected readonly tab = signal<Tab>('assigned');

  protected readonly user = computed(() => this.store.userMap().get(Number(this.id())) ?? null);
  protected readonly memberships = computed(() => {
    const u = this.user();
    return u ? this.store.projects().filter((p) => p.members.some((m) => m.userId === u.id)).map((p) => ({ p, level: levelIn(u, p) })) : [];
  });
  protected readonly lists = computed(() => {
    const id = this.user()?.id;
    const visible = this.ws.visibleIssues();
    return {
      assigned: visible.filter((i) => i.handlerId === id && !isResolved(i.status)),
      reported: visible.filter((i) => i.reporterId === id),
      monitored: visible.filter((i) => id !== undefined && i.monitorIds.includes(id)),
      activity: [],
    };
  });
  protected readonly stats = computed(() => {
    const id = this.user()?.id;
    return {
      assigned: this.lists().assigned.length,
      reported: this.lists().reported.length,
      resolved: this.store.history().filter((h) => h.userId === id && h.field === 'status' && (h.new === 'resolved' || h.new === 'closed')).length,
      time: this.store.comments().filter((c) => c.authorId === id).reduce((s, c) => s + c.timeSpent, 0),
    };
  });
  protected readonly activity = computed(() => {
    const visible = new Set(this.ws.visibleIssues().map((i) => i.id));
    return this.store.history().filter((h) => h.userId === this.user()?.id && visible.has(h.issueId)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 40);
  });

  constructor() {
    effect(() => {
      const u = this.user();
      untracked(() => u && this.tabs.setTitle(u.realName));
    });
  }
}
