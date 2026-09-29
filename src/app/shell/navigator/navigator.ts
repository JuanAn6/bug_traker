import { ChangeDetectionStrategy, Component, computed, inject, signal, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import type { Project } from '../../core/models';
import { Store } from '../../core/store.service';
import { Workspace } from '../../core/workspace.service';
import { Permissions } from '../../core/permissions.service';
import { Auth } from '../../core/auth.service';
import { isResolved } from '../../core/config';
import { TPipe } from '../../i18n/i18n.service';
import { Icon } from '../../shared/icon/icon';
import { Menu } from '../../shared/ui';

interface TreeProject { p: Project; children: TreeProject[]; }

/** DBeaver-like "Database Navigator": Projects › Sprints / Versions / Categories, plus saved filters. */
@Component({
  selector: 'app-navigator',
  imports: [RouterLink, NgTemplateOutlet, TPipe, Icon, Menu],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'view navigator' },
  templateUrl: './navigator.html',
  styleUrl: './navigator.css',
})
export class Navigator {
  protected readonly store = inject(Store);
  protected readonly ws = inject(Workspace);
  protected readonly perm = inject(Permissions);
  protected readonly router = inject(Router);
  private readonly auth = inject(Auth);
  private readonly ctx = viewChild.required<Menu>('ctx');
  protected readonly ctxProject = signal<Project | null>(null);
  private readonly open = signal<Set<string>>(readOpen());

  protected readonly tree = computed(() => {
    const visible = this.ws.visibleProjects();
    const ids = new Set(visible.map((p) => p.id));
    const build = (p: Project): TreeProject => ({ p, children: visible.filter((c) => c.parentId === p.id).map(build) });
    // Roots: projects whose parent is not visible (or that have none).
    return visible.filter((p) => p.parentId === null || !ids.has(p.parentId)).map(build);
  });

  protected readonly filters = computed(() => {
    const me = this.auth.user()?.id;
    return this.store.filters().filter((f) => f.ownerId === me || f.shared);
  });

  private readonly openCounts = computed(() => {
    const m = new Map<number | null, number>();
    for (const i of this.ws.visibleIssues()) {
      if (isResolved(i.status)) continue;
      m.set(i.projectId, (m.get(i.projectId) ?? 0) + 1);
      m.set(null, (m.get(null) ?? 0) + 1);
    }
    return m;
  });

  protected openCount(id: number | null) {
    return this.openCounts().get(id) ?? 0;
  }

  protected sprintsOf(projectId: number) {
    return this.store.sprints().filter((s) => s.projectId === projectId).sort((a, b) => b.start.localeCompare(a.start));
  }

  protected isOpen(key: string | number) {
    return this.open().has(String(key));
  }

  protected setOpen(key: string | number, e: Event) {
    const isOpen = (e.target as HTMLDetailsElement).open;
    const next = new Set(this.open());
    if (isOpen) next.add(String(key));
    else next.delete(String(key));
    this.open.set(next);
    try { localStorage.setItem('bt:tree', JSON.stringify([...next])); } catch { /* ignore */ }
  }

  protected selectProject(p: Project, e: MouseEvent) {
    // Clicking the label selects the project; the twisty only expands.
    if ((e.target as HTMLElement).closest('.twisty')) return;
    e.preventDefault();
    this.ws.projectId.set(p.id);
    const next = new Set(this.open());
    next.add(String(p.id));
    this.open.set(next);
  }

  protected context(e: MouseEvent, p: Project) {
    e.preventDefault();
    this.ctxProject.set(p);
    this.ctx().openAt(e.clientX, e.clientY);
  }
}

function readOpen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem('bt:tree') ?? '["1","filters"]') as string[]);
  } catch {
    return new Set();
  }
}
