import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, model, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import type { ColumnId, Issue, SortKey } from '../../core/models';
import { Store } from '../../core/store.service';
import { Auth } from '../../core/auth.service';
import { IssueActions } from '../../core/issue-actions.service';
import { Permissions } from '../../core/permissions.service';
import { Workspace } from '../../core/workspace.service';
import { Toasts } from '../../core/toast.service';
import { isOverdue, sortIssues } from '../../core/issue-filter';
import { FmtDatePipe, I18n, RelTimePipe, TPipe } from '../../i18n/i18n.service';
import { Icon } from '../icon/icon';
import { Menu, PriorityLabel, SeverityLabel, StatusBadge, UserChip } from '../ui';

/** Sortable, selectable issue grid with MantisBT status colors; used on every list. */
@Component({
  selector: 'app-issue-table',
  imports: [RouterLink, FormsModule, TPipe, FmtDatePipe, RelTimePipe, Icon, StatusBadge, PriorityLabel, SeverityLabel, UserChip, Menu],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './issue-table.html',
  styleUrl: './issue-table.css',
})
export class IssueTable {
  protected readonly store = inject(Store);
  protected readonly auth = inject(Auth);
  protected readonly actions = inject(IssueActions);
  protected readonly perm = inject(Permissions);
  private readonly ws = inject(Workspace);
  private readonly router = inject(Router);
  private readonly toasts = inject(Toasts);
  private readonly i18n = inject(I18n);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly ctx = viewChild.required<Menu>('ctx');

  readonly issues = input.required<Issue[]>();
  readonly columns = model<ColumnId[]>(['id', 'priority', 'status', 'summary', 'updated']);
  readonly sort = model<SortKey[]>([]);
  readonly selection = model<number[]>([]);
  readonly selectable = input(false);
  readonly sortable = input(true);
  readonly reorderable = input(false);
  readonly statusRows = input(true);
  readonly footer = input(true);
  readonly pageSize = input(0);
  readonly maxHeight = input<string | null>(null);
  readonly emptyText = input('');
  readonly showHandlerInStatus = input(true);
  readonly page = model(0);

  protected readonly overCol = signal(-1);
  protected dragCol = -1;
  protected readonly ctxIssue = signal<Issue | null>(null);

  protected readonly sorted = computed(() =>
    sortIssues(this.issues(), this.sort(), {
      name: (col, i) => {
        switch (col) {
          case 'project': return this.store.projectMap().get(i.projectId)?.name ?? '';
          case 'reporter': return this.store.userMap().get(i.reporterId)?.username ?? '';
          case 'handler': return i.handlerId ? this.store.userMap().get(i.handlerId)?.username ?? '' : '~';
          case 'sprint': return i.sprintId ? this.store.sprintMap().get(i.sprintId)?.name ?? '' : '';
          case 'attachments': return this.store.attachmentCounts().get(i.id) ?? 0;
          case 'notes': return this.store.noteCounts().get(i.id) ?? 0;
          default: return '';
        }
      },
    }));
  protected readonly size = computed(() => this.pageSize() || Math.max(this.sorted().length, 1));
  protected readonly pages = computed(() => Math.max(1, Math.ceil(this.sorted().length / this.size())));
  protected readonly pageItems = computed(() => {
    const p = Math.min(this.page(), this.pages() - 1);
    return this.sorted().slice(p * this.size(), (p + 1) * this.size());
  });
  protected readonly rangeEnd = computed(() => Math.min(this.sorted().length, (Math.min(this.page(), this.pages() - 1) + 1) * this.size()));
  protected readonly pageList = computed(() => {
    const n = this.pages();
    const p = this.page();
    const start = Math.max(0, Math.min(p - 3, n - 7));
    return Array.from({ length: Math.min(7, n) }, (_, k) => start + k);
  });
  protected readonly selSet = computed(() => new Set(this.selection()));
  protected readonly allChecked = computed(() => this.pageItems().length > 0 && this.pageItems().every((i) => this.selSet().has(i.id)));
  protected readonly someChecked = computed(() => !this.allChecked() && this.pageItems().some((i) => this.selSet().has(i.id)));
  private readonly lastVisit = computed(() => this.auth.user()?.lastVisit ?? null);
  private lastClicked: number | null = null;

  protected sortIndex(c: ColumnId) {
    const idx = this.sort().findIndex((s) => s.column === c);
    return idx < 0 ? null : { dir: this.sort()[idx].dir, n: idx + 1 };
  }

  protected ariaSort(c: ColumnId) {
    const s = this.sortIndex(c);
    return s ? (s.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  }

  /** Click = single sort (toggle dir), Shift+click = add/toggle secondary sort. */
  protected sortBy(c: ColumnId, e: MouseEvent) {
    if (!this.sortable()) return;
    const cur = this.sort();
    const existing = cur.find((s) => s.column === c);
    const dir = existing?.dir === 'desc' ? 'asc' : existing ? 'desc' : ['updated', 'created', 'priority', 'severity', 'id'].includes(c) ? 'desc' : 'asc';
    if (e.shiftKey) {
      this.sort.set(existing ? cur.map((s) => (s.column === c ? { ...s, dir } : s)) : [...cur, { column: c, dir }]);
    } else {
      this.sort.set([{ column: c, dir }]);
    }
  }

  protected dropCol(to: number) {
    this.overCol.set(-1);
    if (this.dragCol < 0 || this.dragCol === to) return;
    const cols = [...this.columns()];
    const [c] = cols.splice(this.dragCol, 1);
    cols.splice(to, 0, c);
    this.columns.set(cols);
    this.dragCol = -1;
  }

  protected toggle(id: number, e: MouseEvent) {
    const sel = new Set(this.selection());
    // Shift+click selects a range, like a desktop grid.
    if (e.shiftKey && this.lastClicked !== null) {
      const ids = this.sorted().map((i) => i.id);
      const [a, b] = [ids.indexOf(this.lastClicked), ids.indexOf(id)].sort((x, y) => x - y);
      const on = !sel.has(id);
      ids.slice(a, b + 1).forEach((x) => (on ? sel.add(x) : sel.delete(x)));
    } else if (sel.has(id)) sel.delete(id);
    else sel.add(id);
    this.lastClicked = id;
    this.selection.set([...sel]);
  }

  protected toggleAll() {
    const ids = this.pageItems().map((i) => i.id);
    const sel = new Set(this.selection());
    if (this.allChecked()) ids.forEach((id) => sel.delete(id));
    else ids.forEach((id) => sel.add(id));
    this.selection.set([...sel]);
  }

  protected isUnread(i: Issue) {
    const lv = this.lastVisit();
    return !!lv && i.updated > lv;
  }

  protected overdue(i: Issue) {
    return isOverdue(i);
  }

  /** Remember the list order for prev/next navigation on the issue page. */
  protected remember() {
    this.ws.issueNav.set(this.sorted().map((i) => i.id));
  }

  protected open(i: Issue) {
    this.remember();
    this.router.navigate(['/issues', i.id]);
  }

  protected key(e: KeyboardEvent, i: Issue, row: number) {
    const rows = this.host.nativeElement.querySelectorAll<HTMLTableRowElement>('tbody tr[tabindex]');
    const focus = (n: number) => rows[Math.max(0, Math.min(rows.length - 1, n))]?.focus();
    switch (e.key) {
      case 'ArrowDown': case 'j': e.preventDefault(); focus(row + 1); break;
      case 'ArrowUp': case 'k': e.preventDefault(); focus(row - 1); break;
      case 'Home': e.preventDefault(); focus(0); break;
      case 'End': e.preventDefault(); focus(rows.length - 1); break;
      case 'Enter': e.preventDefault(); this.open(i); break;
      case ' ': case 'x':
        if (this.selectable()) { e.preventDefault(); this.toggle(i.id, new MouseEvent('click', { shiftKey: e.shiftKey })); }
        break;
      case 'ContextMenu': {
        e.preventDefault();
        const r = rows[row].getBoundingClientRect();
        this.ctxIssue.set(i);
        this.ctx().openAt(r.left + 40, r.bottom);
      }
    }
  }

  protected context(e: MouseEvent, i: Issue) {
    e.preventDefault();
    this.ctxIssue.set(i);
    this.ctx().openAt(e.clientX, e.clientY);
  }

  protected link(i: Issue) {
    return `${location.origin}/issues/${i.id}`;
  }

  protected copy(text: string) {
    navigator.clipboard?.writeText(text).then(() => this.toasts.success(this.i18n.t('toast.copied')));
  }

  protected cloneIssue(i: Issue) {
    const id = this.actions.clone(i.id, { copyNotes: false, copyAttachments: true });
    if (id) this.router.navigate(['/issues', id]);
  }
}
