import { inject, Injectable } from '@angular/core';
import { AVATAR_COLORS, defaultPrefs } from './config';
import type { User } from './models';
import { Store } from './store.service';

export type UserDraft = Pick<User, 'username' | 'realName' | 'email' | 'accessLevel' | 'enabled' | 'avatarColor'> & { id?: number };

@Injectable({ providedIn: 'root' })
export class Users {
  private readonly store = inject(Store);

  usernameTaken(username: string, exceptId = 0) {
    return this.store.users().some((u) => u.username.toLowerCase() === username.trim().toLowerCase() && u.id !== exceptId);
  }

  save(draft: UserDraft): number {
    let id = draft.id ?? 0;
    this.store.mutate((d) => {
      if (id) Object.assign(d.users.find((u) => u.id === id)!, { ...draft, username: draft.username.trim() });
      else {
        id = this.store.nextId(d);
        d.users.push({
          ...draft, id, username: draft.username.trim(), prefs: defaultPrefs(), lastVisit: null, created: new Date().toISOString(),
          avatarColor: draft.avatarColor || AVATAR_COLORS[id % AVATAR_COLORS.length],
        });
      }
    });
    return id;
  }

  /** Delete a user, handing their open issues to another user (or unassigning them). */
  remove(id: number, reassignTo: number | null) {
    this.store.mutate((d) => {
      d.users = d.users.filter((u) => u.id !== id);
      for (const i of d.issues) {
        if (i.handlerId === id) i.handlerId = reassignTo;
        i.monitorIds = i.monitorIds.filter((m) => m !== id);
      }
      d.projects.forEach((p) => (p.members = p.members.filter((m) => m.userId !== id)));
      d.projects.forEach((p) => p.categories.forEach((c) => c.defaultHandlerId === id && (c.defaultHandlerId = null)));
      d.notifications = d.notifications.filter((n) => n.userId !== id);
      d.filters = d.filters.filter((f) => f.ownerId !== id);
    });
  }
}
