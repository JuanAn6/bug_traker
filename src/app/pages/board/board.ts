import { ChangeDetectionStrategy, Component, computed, inject, input, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Store } from '../../core/store.service';
import { Auth } from '../../core/auth.service';
import { Workspace } from '../../core/workspace.service';
import { Permissions } from '../../core/permissions.service';
import { IssueActions } from '../../core/issue-actions.service';
import { PRIORITIES, STATUSES } from '../../core/config';
import { groupBy, isOverdue } from '../../core/issue-filter';
import type { Issue, Status } from '../../core/models';
import { FmtDatePipe, TPipe } from '../../i18n/i18n.service';
import { Icon } from '../../shared/icon/icon';
import { RichView } from '../../shared/rich/rich-view/rich-view';
import { Avatar, Dialog, Menu, PriorityLabel, SeverityLabel, StatusBadge, UserChip, UserSelect } from '../../shared/ui';

type Lane = 'none' | 'handler' | 'priority';
const COLS_KEY = 'bt:board-columns';

@Component({
  selector: 'app-board',
  imports: [FormsModule, RouterLink, TPipe, FmtDatePipe, Icon, RichView, Avatar, Dialog, Menu, PriorityLabel, SeverityLabel, StatusBadge, UserChip, UserSelect],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './board.html',
  styleUrl: './board.css',
})
export class Board {
  protected readonly store = inject(Store);
  protected readonly perm = inject(Permissions);
  protected readonly actions = inject(IssueActions);
  private readonly auth = inject(Auth);
  private readonly ws = inject(Workspace);

  /** /sprints/:id/board */
  readonly id = input<string>();
  /** /board?sprint=… or ?project=… */
  readonly sprintParam = input<string>(undefined, { alias: 'sprint' });
  readonly project = input<string>();

  protected readonly drawerRef = viewChild.required<Dialog>('drawer');
  private readonly moveMenuRef = viewChild.required<Menu>('moveMenuRef');
  protected readonly statuses = STATUSES;
  protected readonly lane = signal<Lane>('none');
  protected readonly text = signal('');
  protected readonly onlyMine = signal(false);
  protected readonly onlyUnassigned = signal(false);
  protected readonly sprintSel = signal<string | null>(null);
  protected readonly dragging = signal<Issue | null>(null);
  protected readonly dropTarget = signal('');
  private readonly currentId = signal<number | null>(null);
  protected readonly current = computed(() => this.store.issueMap().get(this.currentId() ?? 0) ?? null);
  protected readonly menuIssue = signal<Issue | null>(null);
  private readonly localColumns = signal<Status[] | null>(readColumns());

  protected readonly columns = computed(() => this.localColumns() ?? this.store.workflow().boardColumns);
  protected readonly sprintValue = computed(() => this.sprintSel() ?? this.id() ?? this.sprintParam() ?? this.defaultSprint());
  protected readonly sprint = computed(() => this.store.sprintMap().get(Number(this.sprintValue())) ?? null);
  private readonly scopeIds = computed(() => {
    const p = Number(this.project());
    return p ? new Set([p]) : this.ws.scopeIds();
  });
  protected readonly sprints = computed(() => {
    const scope = this.scopeIds();
    return this.store.sprints().filter((s) => s.state !== 'closed' && (!scope || scope.has(s.projectId)));
  });
  private defaultSprint() {
    return String(this.sprints().find((s) => s.state === 'active')?.id ?? '');
  }

  protected readonly issues = computed(() => {
    const scope = this.scopeIds();
    const sv = this.sprintValue();
    const me = this.auth.me().id;
    const q = this.text().trim().toLowerCase();
    return this.ws.visibleIssues().filter((i) =>
      (!scope || scope.has(i.projectId))
      && (sv === '' || (sv === 'none' ? i.sprintId === null : i.sprintId === Number(sv)))
      && (!this.onlyMine() || i.handlerId === me)
      && (!this.onlyUnassigned() || !i.handlerId)
      && (!q || (this.store.issueKey(i) + ' ' + i.summary + ' ' + i.tags.join(' ')).toLowerCase().includes(q)));
  });
  protected readonly totalPoints = computed(() => this.issues().reduce((s, i) => s + (i.storyPoints ?? 0), 0));

  protected readonly lanes = computed(() => {
    const list = this.issues();
    const mode = this.lane();
    if (mode === 'none') return [{ key: 'all' as string | number, issues: list }];
    if (mode === 'priority') {
      const g = groupBy(list, (i) => i.priority);
      return [...PRIORITIES].reverse().filter((p) => g.has(p)).map((p) => ({ key: p as string | number, issues: g.get(p)! }));
    }
    const g = groupBy(list, (i) => i.handlerId ?? 0);
    return [...g.entries()]
      .sort((a, b) => (this.store.userMap().get(a[0])?.realName ?? '~').localeCompare(this.store.userMap().get(b[0])?.realName ?? '~'))
      .map(([key, issues]) => ({ key: key as string | number, issues }));
  });

  protected byStatus(list: Issue[], s: Status) {
    const order = [...PRIORITIES].reverse();
    return list.filter((i) => i.status === s).sort((a, b) => order.indexOf(a.priority) - order.indexOf(b.priority) || b.updated.localeCompare(a.updated));
  }

  protected wip(s: Status) {
    return this.store.workflow().wipLimits[s];
  }

  protected overdue(i: Issue) {
    return isOverdue(i);
  }

  protected transitionsOf(i: Issue) {
    return this.actions.allowedTransitions(i);
  }

  protected toggleColumn(s: Status) {
    const cur = this.columns();
    const next = cur.includes(s) ? cur.filter((x) => x !== s) : STATUSES.filter((x) => cur.includes(x) || x === s);
    this.localColumns.set(next);
    try { localStorage.setItem(COLS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }

  // ---------- drag & drop ----------

  protected start(e: DragEvent, i: Issue) {
    this.dragging.set(i);
    e.dataTransfer?.setData('text/plain', String(i.id));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }

  protected canDrop(s: Status) {
    const d = this.dragging();
    return !!d && (d.status === s || this.actions.allowedTransitions(d).includes(s));
  }

  protected over(e: DragEvent, lane: string | number, s: Status) {
    if (!this.dragging()) return;
    this.dropTarget.set(lane + ':' + s);
    if (this.canDrop(s)) e.preventDefault();
  }

  protected drop(e: DragEvent, s: Status, lane: string | number) {
    e.preventDefault();
    const i = this.dragging();
    this.dragging.set(null);
    this.dropTarget.set('');
    if (!i) return;
    const handlerLane = this.lane() === 'handler' ? (lane === 0 ? null : Number(lane)) : undefined;
    if (i.status !== s) this.move(i, s);
    // Dropping into another assignee lane reassigns the issue.
    if (handlerLane !== undefined && handlerLane !== i.handlerId && this.perm.can('assign', i.projectId)) this.actions.assign([i.id], handlerLane);
  }

  protected move(i: Issue, s: Status) {
    if (!s || s === i.status) return;
    this.actions.changeStatus(i.id, s);
  }

  protected moveMenu(e: Event, i: Issue) {
    e.preventDefault();
    this.menuIssue.set(i);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const pos = e instanceof MouseEvent ? { x: e.clientX, y: e.clientY } : { x: r.left + 20, y: r.bottom };
    this.moveMenuRef().openAt(pos.x, pos.y);
  }

  protected preview(i: Issue) {
    this.currentId.set(i.id);
    this.drawerRef().open();
  }
}

function readColumns(): Status[] | null {
  try {
    return JSON.parse(localStorage.getItem(COLS_KEY) ?? 'null') as Status[] | null;
  } catch {
    return null;
  }
}
