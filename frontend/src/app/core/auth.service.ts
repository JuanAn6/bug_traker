import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Store } from './store.service';
import type { UserPrefs } from './models';

const SESSION_KEY = 'bt:session';

function readSession(): number | null {
  try {
    const v = localStorage.getItem(SESSION_KEY) ?? sessionStorage.getItem(SESSION_KEY);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

/** Fake authentication: any password is accepted for enabled users. */
@Injectable({ providedIn: 'root' })
export class Auth {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly userId = signal<number | null>(readSession());

  readonly user = computed(() => {
    const id = this.userId();
    const u = id ? this.store.userMap().get(id) : undefined;
    return u?.enabled ? u : null;
  });
  /** Non-null accessor for authenticated pages (guarded by authGuard). */
  readonly me = computed(() => this.user()!);
  readonly prefs = computed(() => this.user()?.prefs);

  login(username: string, remember: boolean): boolean {
    const u = this.store.users().find((x) => x.username.toLowerCase() === username.trim().toLowerCase());
    if (!u || !u.enabled) return false;
    try {
      (remember ? localStorage : sessionStorage).setItem(SESSION_KEY, String(u.id));
    } catch { /* storage blocked: session lives in memory only */ }
    this.store.mutate((d) => {
      const du = d.users.find((x) => x.id === u.id)!;
      du.lastVisit = new Date().toISOString();
    });
    this.userId.set(u.id);
    return true;
  }

  logout() {
    try {
      localStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(SESSION_KEY);
    } catch { /* ignore */ }
    this.userId.set(null);
    this.router.navigate(['/login']);
  }

  updatePrefs(patch: Partial<UserPrefs>) {
    const id = this.userId();
    if (!id) return;
    this.store.mutate((d) => {
      const u = d.users.find((x) => x.id === id)!;
      u.prefs = { ...u.prefs, ...patch };
    });
  }
}
