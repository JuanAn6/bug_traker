import { inject, Injectable } from '@angular/core';
import { isResolved } from './config';
import type { Sprint } from './models';
import { IssueActions } from './issue-actions.service';
import { Store } from './store.service';
import { Toasts } from './toast.service';
import { I18n } from '../i18n/i18n.service';

@Injectable({ providedIn: 'root' })
export class Sprints {
  private readonly store = inject(Store);
  private readonly actions = inject(IssueActions);
  private readonly toasts = inject(Toasts);
  private readonly i18n = inject(I18n);

  save(s: Omit<Sprint, 'id'> & { id?: number }): number {
    let id = s.id ?? 0;
    this.store.mutate((d) => {
      if (id) Object.assign(d.sprints.find((x) => x.id === id)!, s);
      else {
        id = this.store.nextId(d);
        d.sprints.push({ ...s, id });
      }
    });
    return id;
  }

  remove(id: number) {
    const before = this.store.snapshot();
    this.store.mutate((d) => {
      d.sprints = d.sprints.filter((s) => s.id !== id);
      d.issues.forEach((i) => i.sprintId === id && (i.sprintId = null));
    });
    this.toasts.success(this.i18n.t('sprints.deleted'), { label: this.i18n.t('common.undo'), run: () => this.store.restore(before) });
  }

  start(id: number) {
    this.store.mutate((d) => {
      const s = d.sprints.find((x) => x.id === id)!;
      s.state = 'active';
      if (s.start > new Date().toISOString().slice(0, 10)) s.start = new Date().toISOString().slice(0, 10);
    });
  }

  /** Close the sprint and move unfinished issues to another sprint (or the backlog). */
  complete(id: number, moveTo: number | null) {
    const open = this.store.issues().filter((i) => i.sprintId === id && !isResolved(i.status)).map((i) => i.id);
    if (open.length) this.actions.bulkUpdate(open, { sprintId: moveTo }, this.i18n.t('fields.sprintId'));
    this.store.mutate((d) => (d.sprints.find((x) => x.id === id)!.state = 'closed'));
    this.toasts.success(this.i18n.t('sprints.completed', { count: open.length }));
  }
}
