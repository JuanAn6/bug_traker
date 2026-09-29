import { ChangeDetectionStrategy, Component, computed, inject, input, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Store } from '../../core/store.service';
import { Workspace } from '../../core/workspace.service';
import { Permissions } from '../../core/permissions.service';
import { Sprints as SprintService } from '../../core/sprint.service';
import { isResolved } from '../../core/config';
import { points } from '../../core/metrics';
import type { Sprint, SprintState } from '../../core/models';
import { FmtDatePipe, I18n, TPipe } from '../../i18n/i18n.service';
import { Icon } from '../../shared/icon/icon';
import { Confirm, Empty } from '../../shared/ui';
import { SprintDialog } from '../sprint-dialog/sprint-dialog';

@Component({
  selector: 'app-sprints',
  imports: [RouterLink, TPipe, FmtDatePipe, Icon, Empty, SprintDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sprints.html',
  styleUrl: './sprints.css',
})
export class Sprints {
  protected readonly store = inject(Store);
  protected readonly ws = inject(Workspace);
  protected readonly perm = inject(Permissions);
  protected readonly svc = inject(SprintService);
  protected readonly router = inject(Router);
  private readonly confirm = inject(Confirm);
  private readonly i18n = inject(I18n);
  protected readonly dlg = viewChild.required(SprintDialog);

  readonly new = input<string>();
  readonly project = input<string>();

  protected readonly tabs: (SprintState | 'all')[] = ['active', 'planned', 'closed', 'all'];
  protected readonly state = signal<SprintState | 'all'>('active');

  private readonly scoped = computed(() => {
    const p = Number(this.project());
    const scope = p ? new Set([p]) : this.ws.scopeIds();
    const visible = new Set(this.ws.visibleProjects().map((x) => x.id));
    return this.store.sprints().filter((s) => visible.has(s.projectId) && (!scope || scope.has(s.projectId)));
  });

  protected readonly rows = computed(() => {
    const st = this.state();
    return this.scoped()
      .filter((s) => st === 'all' || s.state === st)
      .sort((a, b) => b.start.localeCompare(a.start))
      .map((s) => {
        const list = this.store.issues().filter((i) => i.sprintId === s.id);
        const done = list.filter((i) => isResolved(i.status));
        const totalP = list.reduce((n, i) => n + points(i), 0);
        const doneP = done.reduce((n, i) => n + points(i), 0);
        return { s, total: list.length, done: done.length, totalP, doneP, pct: totalP ? Math.round((doneP / totalP) * 100) : 0 };
      });
  });

  constructor() {
    queueMicrotask(() => {
      if (this.new()) this.dlg().open(undefined, Number(this.project()) || undefined);
      if (!this.scoped().some((s) => s.state === 'active')) this.state.set('all');
    });
  }

  protected count(st: SprintState | 'all') {
    return this.scoped().filter((s) => st === 'all' || s.state === st).length;
  }

  protected async remove(s: Sprint) {
    const ok = await this.confirm.ask({
      title: this.i18n.t('sprints.delete'), message: this.i18n.t('sprints.deleteConfirm', { name: s.name }), danger: true, confirm: this.i18n.t('common.delete'),
    });
    if (ok) this.svc.remove(s.id);
  }
}
