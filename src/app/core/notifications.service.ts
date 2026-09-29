import { computed, inject, Injectable } from '@angular/core';
import { Auth } from './auth.service';
import { Store } from './store.service';

/** In-app notifications of the current user (created by IssueActions). */
@Injectable({ providedIn: 'root' })
export class Notifications {
  private readonly store = inject(Store);
  private readonly auth = inject(Auth);

  readonly mine = computed(() => {
    const me = this.auth.user()?.id;
    return this.store.notifications().filter((n) => n.userId === me).sort((a, b) => b.date.localeCompare(a.date));
  });
  readonly unread = computed(() => this.mine().filter((n) => !n.read).length);

  markRead(ids: number[], read = true) {
    const set = new Set(ids);
    this.store.mutate((d) => d.notifications.forEach((n) => set.has(n.id) && (n.read = read)));
  }

  markAllRead() {
    const me = this.auth.user()?.id;
    this.store.mutate((d) => d.notifications.forEach((n) => n.userId === me && (n.read = true)));
  }

  remove(ids: number[]) {
    const set = new Set(ids);
    this.store.mutate((d) => (d.notifications = d.notifications.filter((n) => !set.has(n.id))));
  }
}
