import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Store } from '../../../core/store.service';
import { Toasts } from '../../../core/toast.service';
import { ACCESS_LEVELS, ACCESS_NAMES, STATUSES, defaultWorkflow } from '../../../core/config';
import type { AccessLevel, Action, Status, WorkflowConfig } from '../../../core/models';
import { I18n, TPipe } from '../../../i18n/i18n.service';
import { Icon } from '../../../shared/icon/icon';
import { Confirm, StatusBadge } from '../../../shared/ui';

/** Workflow admin: transitions, thresholds, colors, board. Changes apply immediately. */
@Component({
  selector: 'app-workflow-admin',
  imports: [FormsModule, TPipe, Icon, StatusBadge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './workflow.html',
  styleUrl: './workflow.css',
})
export class WorkflowAdmin {
  private readonly store = inject(Store);
  private readonly toasts = inject(Toasts);
  private readonly confirm = inject(Confirm);
  private readonly i18n = inject(I18n);
  protected readonly statuses = STATUSES;
  protected readonly levels = ACCESS_LEVELS;
  protected readonly names = ACCESS_NAMES;
  protected readonly wf = this.store.workflow;
  protected readonly actions = Object.keys(defaultWorkflow().thresholds) as Action[];

  protected patch(p: Partial<WorkflowConfig>) {
    this.store.mutate((d) => Object.assign(d.workflow, p));
  }

  protected toggle(from: Status, to: Status) {
    this.store.mutate((d) => {
      const list = d.workflow.transitions[from];
      d.workflow.transitions[from] = list.includes(to) ? list.filter((s) => s !== to) : STATUSES.filter((s) => list.includes(s) || s === to);
    });
  }

  protected setThreshold(a: Action, level: AccessLevel) {
    this.store.mutate((d) => (d.workflow.thresholds[a] = level));
  }

  protected setColor(s: Status, color: string) {
    this.store.mutate((d) => (d.workflow.statusColors[s] = color));
  }

  protected toggleColumn(s: Status) {
    this.store.mutate((d) => {
      const cols = d.workflow.boardColumns;
      d.workflow.boardColumns = cols.includes(s) ? cols.filter((x) => x !== s) : STATUSES.filter((x) => cols.includes(x) || x === s);
    });
  }

  protected setWip(s: Status, v: string | number | null) {
    this.store.mutate((d) => {
      const n = Number(v);
      if (v === '' || v === null || !n) delete d.workflow.wipLimits[s];
      else d.workflow.wipLimits[s] = n;
    });
  }

  protected async reset() {
    const ok = await this.confirm.ask({ title: this.i18n.t('workflow.reset'), message: this.i18n.t('workflow.resetConfirm'), danger: true });
    if (!ok) return;
    const before = this.store.snapshot();
    this.store.mutate((d) => (d.workflow = defaultWorkflow()));
    this.toasts.success(this.i18n.t('workflow.resetDone'), { label: this.i18n.t('common.undo'), run: () => this.store.restore(before) });
  }
}
