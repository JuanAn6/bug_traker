import { inject, Injectable } from '@angular/core';
import { Auth } from './auth.service';
import { Store } from './store.service';
import type { AccessLevel, Action, Comment, Issue, Project, User } from './models';

export function levelIn(user: User, project: Project | undefined): AccessLevel {
  // Administrators keep global rights; otherwise a project membership overrides the global level.
  if (user.accessLevel === 90) return 90;
  return project?.members.find((m) => m.userId === user.id)?.accessLevel ?? user.accessLevel;
}

@Injectable({ providedIn: 'root' })
export class Permissions {
  private readonly store = inject(Store);
  private readonly auth = inject(Auth);

  level(projectId?: number | null): AccessLevel {
    const u = this.auth.user();
    if (!u) return 10;
    return levelIn(u, projectId ? this.store.projectMap().get(projectId) : undefined);
  }

  can(action: Action, projectId?: number | null): boolean {
    return this.level(projectId) >= this.store.workflow().thresholds[action];
  }

  canSeeProject(p: Project): boolean {
    const u = this.auth.user();
    if (!u || !p.enabled && u.accessLevel < 70) return false;
    return p.viewState === 'public' || u.accessLevel >= 70 || p.members.some((m) => m.userId === u.id);
  }

  canSeeIssue(i: Issue): boolean {
    const p = this.store.projectMap().get(i.projectId);
    if (!p || !this.canSeeProject(p)) return false;
    const u = this.auth.user()!;
    return i.viewState === 'public' || i.reporterId === u.id || i.handlerId === u.id || this.can('viewPrivate', i.projectId);
  }

  canSeeNote(c: Comment, projectId: number): boolean {
    return !c.private || c.authorId === this.auth.user()?.id || this.can('viewPrivate', projectId);
  }

  canEditNote(c: Comment, projectId: number): boolean {
    return c.authorId === this.auth.user()?.id || this.can('editOthersNotes', projectId);
  }

  canEditIssue(i: Issue): boolean {
    return this.can('update', i.projectId) || (i.reporterId === this.auth.user()?.id && this.can('report', i.projectId));
  }
}
