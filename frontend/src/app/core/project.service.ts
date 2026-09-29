import { inject, Injectable } from '@angular/core';
import type { Project } from './models';
import { Store } from './store.service';
import { Auth } from './auth.service';

/** Project administration, keeping issues consistent when categories/versions change. */
@Injectable({ providedIn: 'root' })
export class Projects {
  private readonly store = inject(Store);
  private readonly auth = inject(Auth);

  keyTaken(key: string, exceptId = 0): boolean {
    return this.store.projects().some((p) => p.key.toUpperCase() === key.toUpperCase() && p.id !== exceptId);
  }

  create(p: Omit<Project, 'id' | 'created' | 'categories' | 'versions' | 'members' | 'customFieldIds'>): number {
    let id = 0;
    this.store.mutate((d) => {
      id = this.store.nextId(d);
      d.projects.push({
        ...p, id, key: p.key.toUpperCase(), created: new Date().toISOString(),
        categories: [{ name: 'General', defaultHandlerId: null }], versions: [],
        members: [{ userId: this.auth.me().id, accessLevel: 70 }], customFieldIds: [],
      });
    });
    return id;
  }

  /** Save the whole project; renamed categories/versions are propagated to its issues. */
  save(next: Project, renames: { categories: Record<string, string>; versions: Record<string, string> }) {
    this.store.mutate((d) => {
      const idx = d.projects.findIndex((p) => p.id === next.id);
      d.projects[idx] = structuredClone({ ...next, key: next.key.toUpperCase() });
      for (const i of d.issues.filter((x) => x.projectId === next.id)) {
        if (renames.categories[i.category] !== undefined) i.category = renames.categories[i.category];
        for (const f of ['productVersion', 'targetVersion', 'fixedInVersion'] as const) {
          if (renames.versions[i[f]] !== undefined) i[f] = renames.versions[i[f]];
        }
      }
    });
  }

  remove(id: number) {
    this.store.mutate((d) => {
      const issueIds = new Set(d.issues.filter((i) => i.projectId === id).map((i) => i.id));
      d.projects = d.projects.filter((p) => p.id !== id);
      d.projects.forEach((p) => p.parentId === id && (p.parentId = null));
      d.issues = d.issues.filter((i) => !issueIds.has(i.id));
      d.issues.forEach((i) => (i.relationships = i.relationships.filter((r) => !issueIds.has(r.issueId))));
      d.sprints = d.sprints.filter((s) => s.projectId !== id);
      d.comments = d.comments.filter((c) => !issueIds.has(c.issueId));
      d.attachments = d.attachments.filter((a) => !issueIds.has(a.issueId));
      d.history = d.history.filter((h) => !issueIds.has(h.issueId));
      d.notifications = d.notifications.filter((n) => !issueIds.has(n.issueId));
      d.users.forEach((u) => u.prefs.defaultProjectId === id && (u.prefs.defaultProjectId = null));
    });
  }

  issueCount(projectId: number, category?: string, version?: string): number {
    return this.store.issues().filter((i) => i.projectId === projectId
      && (category === undefined || i.category === category)
      && (version === undefined || i.targetVersion === version || i.fixedInVersion === version || i.productVersion === version)).length;
  }
}
