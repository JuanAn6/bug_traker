import { inject, Injectable, signal } from '@angular/core';
import { ActivatedRouteSnapshot, NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import { I18n } from '../i18n/i18n.service';

export interface EditorTab {
  /** Path without query string: one tab per page/entity. */
  key: string;
  /** Last full URL (keeps filters/query params when switching back). */
  url: string;
  /** i18n key from route data, or literal title set by the page. */
  titleKey: string;
  title: string | null;
  icon: string;
  dirty: boolean;
}

const KEY = 'bt:tabs';
const MAX_TABS = 14;

/** DBeaver-style editor tabs mirroring router navigation. */
@Injectable({ providedIn: 'root' })
export class Tabs {
  private readonly router = inject(Router);
  private readonly i18n = inject(I18n);
  readonly tabs = signal<EditorTab[]>(read());
  readonly activeKey = signal<string>('');
  bypassDirty = false;

  constructor() {
    this.router.events.pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd)).subscribe((e) => {
      let snap: ActivatedRouteSnapshot = this.router.routerState.snapshot.root;
      while (snap.firstChild) snap = snap.firstChild;
      const data = snap.data as { tab?: string; icon?: string; noTab?: boolean };
      if (data.noTab) return;
      const url = e.urlAfterRedirects;
      const key = url.split('?')[0].split('#')[0];
      this.activeKey.set(key);
      this.tabs.update((list) => {
        const existing = list.find((t) => t.key === key);
        if (existing) return list.map((t) => (t.key === key ? { ...t, url } : t));
        const next = [...list, { key, url, titleKey: data.tab ?? 'nav.home', title: null, icon: data.icon ?? 'file', dirty: false }];
        while (next.length > MAX_TABS) {
          const idx = next.findIndex((t) => !t.dirty && t.key !== key);
          if (idx < 0) break;
          next.splice(idx, 1);
        }
        return next;
      });
      this.persist();
    });
  }

  setTitle(title: string, key = this.activeKey()) {
    this.tabs.update((l) => l.map((t) => (t.key === key ? { ...t, title } : t)));
    this.persist();
  }

  setDirty(dirty: boolean, key = this.activeKey()) {
    this.tabs.update((l) => l.map((t) => (t.key === key && t.dirty !== dirty ? { ...t, dirty } : t)));
  }

  close(key: string) {
    const list = this.tabs();
    const idx = list.findIndex((t) => t.key === key);
    if (idx < 0) return;
    if (list[idx].dirty && !confirm(this.i18n.t('common.discardChanges'))) return;
    // Already confirmed here, so the canDeactivate guard must not ask again.
    if (list[idx].dirty && key === this.activeKey()) this.bypassDirty = true;
    const next = list.filter((t) => t.key !== key);
    this.tabs.set(next);
    this.persist();
    if (key === this.activeKey()) {
      const target = next[Math.min(idx, next.length - 1)];
      this.router.navigateByUrl(target?.url ?? '/');
    }
  }

  closeOthers(key: string) {
    this.tabs.update((l) => l.filter((t) => t.key === key || t.dirty));
    this.persist();
    const t = this.tabs().find((x) => x.key === key);
    if (t && key !== this.activeKey()) this.router.navigateByUrl(t.url);
  }

  closeAll() {
    this.tabs.update((l) => l.filter((t) => t.dirty));
    this.persist();
    this.router.navigateByUrl('/');
  }

  move(from: number, to: number) {
    this.tabs.update((l) => {
      const next = [...l];
      const [t] = next.splice(from, 1);
      next.splice(to, 0, t);
      return next;
    });
    this.persist();
  }

  /** Remove tabs pointing at entities that no longer exist (e.g. after delete). */
  drop(key: string) {
    this.tabs.update((l) => l.filter((t) => t.key !== key));
    this.persist();
  }

  private persist() {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(this.tabs().map((t) => ({ ...t, dirty: false }))));
    } catch { /* ignore */ }
  }
}

function read(): EditorTab[] {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? '[]') as EditorTab[];
  } catch {
    return [];
  }
}
