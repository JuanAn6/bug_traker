import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { Auth } from './auth.service';
import { descendantProjectIds } from './issue-filter';
import { Permissions } from './permissions.service';
import { Store } from './store.service';
import { I18n } from '../i18n/i18n.service';
import { STATUSES } from './config';

/** UI-wide context: selected project, theme/density/language application, visible data. */
@Injectable({ providedIn: 'root' })
export class Workspace {
  private readonly store = inject(Store);
  private readonly auth = inject(Auth);
  private readonly perm = inject(Permissions);
  private readonly i18n = inject(I18n);

  /** null = all projects */
  readonly projectId = signal<number | null>(readNum('bt:project'));
  readonly navigatorOpen = signal(readNum('bt:nav') !== 0);
  readonly statusbarOpen = signal(readNum('bt:statusbar') !== 0);
  /** Ordered issue ids of the last list the user opened an issue from (prev/next navigation). */
  readonly issueNav = signal<number[]>([]);

  readonly visibleProjects = computed(() => this.store.projects().filter((p) => this.perm.canSeeProject(p)));
  readonly visibleIssues = computed(() => (this.auth.user() ? this.store.issues().filter((i) => this.perm.canSeeIssue(i)) : []));
  readonly scopeIds = computed(() => {
    const id = this.projectId();
    return id === null ? null : descendantProjectIds(this.store.projects(), [id]);
  });
  /** Visible issues inside the selected project (and its subprojects). */
  readonly scopedIssues = computed(() => {
    const scope = this.scopeIds();
    return scope ? this.visibleIssues().filter((i) => scope.has(i.projectId)) : this.visibleIssues();
  });
  readonly project = computed(() => {
    const id = this.projectId();
    return id === null ? null : this.store.projectMap().get(id) ?? null;
  });

  private readonly media = window.matchMedia?.('(prefers-color-scheme: dark)');
  private readonly systemDark = signal(!!this.media?.matches);

  constructor() {
    this.media?.addEventListener('change', (e) => this.systemDark.set(e.matches));

    effect(() => {
      const prefs = this.auth.prefs();
      const root = document.documentElement;
      const theme = prefs?.theme ?? 'system';
      root.dataset['theme'] = theme === 'system' ? (this.systemDark() ? 'dark' : 'light') : theme;
      root.dataset['density'] = prefs?.density ?? 'compact';
    });
    effect(() => {
      const lang = this.auth.prefs()?.language;
      if (lang) this.i18n.setLang(lang);
    });
    effect(() => {
      const colors = this.store.workflow().statusColors;
      for (const s of STATUSES) document.documentElement.style.setProperty(`--status-${s}`, colors[s]);
    });
    effect(() => {
      const id = this.projectId();
      if (id !== null && !this.store.projectMap().has(id)) this.projectId.set(null);
      write('bt:project', id === null ? '' : String(id));
    });
    effect(() => write('bt:nav', this.navigatorOpen() ? '1' : '0'));
    effect(() => write('bt:statusbar', this.statusbarOpen() ? '1' : '0'));
  }

  /** Visible projects for a page scope: explicit project (+ direct subprojects), else the selected project, else all. */
  projectsInScope(projectParam?: string | null) {
    const id = Number(projectParam) || this.projectId();
    const scope = id ? new Set([id, ...this.store.projects().filter((p) => p.parentId === id).map((p) => p.id)]) : null;
    return this.visibleProjects().filter((p) => !scope || scope.has(p.id));
  }

  /** Apply the user's default project right after login. */
  applyDefaults() {
    const def = this.auth.prefs()?.defaultProjectId;
    if (def !== undefined) this.projectId.set(def);
  }
}

function readNum(key: string): number | null {
  try {
    const v = localStorage.getItem(key);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}
