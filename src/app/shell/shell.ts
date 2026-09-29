import { ChangeDetectionStrategy, Component, computed, inject, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { Store } from '../core/store.service';
import { Auth } from '../core/auth.service';
import { Workspace } from '../core/workspace.service';
import { Permissions } from '../core/permissions.service';
import { Notifications } from '../core/notifications.service';
import { Tabs } from '../core/tabs.service';
import { Attachments } from '../core/attachments.service';
import { ACCESS_NAMES, LANGUAGES, isResolved } from '../core/config';
import { isOverdue } from '../core/issue-filter';
import { isTyping } from '../core/csv';
import type { Theme } from '../core/models';
import { FmtDatePipe, I18n, RelTimePipe, TPipe } from '../i18n/i18n.service';
import { Icon } from '../shared/icon/icon';
import { Avatar, Dialog, Menu } from '../shared/ui';
import { Navigator } from './navigator/navigator';
import { EditorTabs } from './editor-tabs/editor-tabs';
import { CommandPalette } from './command-palette/command-palette';

export const SHORTCUTS: [string, string][] = [
  ['Ctrl+K', 'shortcuts.palette'], ['/', 'shortcuts.search'], ['N', 'shortcuts.newIssue'], ['?', 'shortcuts.help'],
  ['G H', 'shortcuts.goHome'], ['G I', 'shortcuts.goIssues'], ['G B', 'shortcuts.goBoard'], ['G S', 'shortcuts.goSprints'],
  ['G P', 'shortcuts.goProjects'], ['G R', 'shortcuts.goRoadmap'], ['Alt+W', 'shortcuts.closeTab'],
  ['J / K', 'shortcuts.rows'], ['Enter', 'shortcuts.openRow'], ['X', 'shortcuts.selectRow'],
  ['E', 'shortcuts.edit'], ['A', 'shortcuts.assignMe'], ['C', 'shortcuts.comment'], ['[ / ]', 'shortcuts.prevNext'],
  ['Ctrl+Enter', 'shortcuts.submit'], ['Esc', 'shortcuts.close'],
];

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, FormsModule, TPipe, RelTimePipe, FmtDatePipe, Icon, Avatar, Menu, Dialog, Navigator, EditorTabs, CommandPalette],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'app', '(document:keydown)': 'onKey($event)' },
  templateUrl: './shell.html',
  styleUrl: './shell.css',
})
export class Shell {
  protected readonly store = inject(Store);
  protected readonly auth = inject(Auth);
  protected readonly ws = inject(Workspace);
  protected readonly perm = inject(Permissions);
  protected readonly notif = inject(Notifications);
  protected readonly i18n = inject(I18n);
  private readonly tabs = inject(Tabs);
  private readonly router = inject(Router);

  protected readonly palette = viewChild.required(CommandPalette);
  protected readonly shortcuts = viewChild.required<Dialog>('shortcutsDlg');
  protected readonly about = viewChild.required<Dialog>('aboutDlg');

  protected readonly languages = LANGUAGES;
  protected readonly themes: Theme[] = ['light', 'dark', 'system'];
  protected readonly densities = ['compact', 'comfortable'] as const;
  protected readonly shortcutList = SHORTCUTS;
  protected readonly notifIcon = { assigned: 'user', mentioned: 'message', status: 'workflow', note: 'message', attachment: 'paperclip' };
  protected readonly prefs = this.auth.prefs;
  protected readonly accessName = computed(() => ACCESS_NAMES[this.auth.user()?.accessLevel ?? 10]);
  protected readonly isAdmin = computed(() =>
    this.perm.can('manageUsers') || this.perm.can('manageProject') || this.perm.can('manageWorkflow'));
  protected readonly counts = computed(() => {
    const list = this.ws.scopedIssues();
    const open = list.filter((i) => !isResolved(i.status));
    return { total: list.length, open: open.length, overdue: open.filter((i) => isOverdue(i)).length };
  });
  private gPressed = 0;

  constructor() {
    // Clean up blobs of deleted attachments from previous sessions.
    inject(Attachments).purgeOrphans().catch(() => {});
  }

  protected isDark() {
    return document.documentElement.dataset['theme'] === 'dark';
  }

  protected toggleTheme() {
    this.auth.updatePrefs({ theme: this.isDark() ? 'light' : 'dark' });
  }

  protected print() {
    window.print();
  }

  protected focusSearch() {
    document.querySelector<HTMLInputElement>('.toolbar .search input')?.focus();
  }

  protected search(text: string) {
    const q = text.trim();
    if (!q) return;
    const m = /^(?:[a-z]+-|#)?(\d+)$/i.exec(q);
    if (m && this.store.issueMap().has(+m[1])) this.router.navigate(['/issues', +m[1]]);
    else this.router.navigate(['/issues'], { queryParams: { text: q, hideStatus: '' } });
  }

  protected openNotification(id: number, issueId: number) {
    this.notif.markRead([id]);
    this.router.navigate(['/issues', issueId]);
  }

  protected onKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      this.palette().open();
      return;
    }
    if (e.altKey && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      this.tabs.close(this.tabs.activeKey());
      return;
    }
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    if (Date.now() - this.gPressed < 1200) {
      this.gPressed = 0;
      const dest: Record<string, string> = { h: '/', i: '/issues', b: '/board', s: '/sprints', p: '/projects', r: '/roadmap', c: '/calendar', n: '/notifications' };
      if (dest[k]) { e.preventDefault(); this.router.navigateByUrl(dest[k]); }
      return;
    }
    switch (e.key) {
      case 'g': this.gPressed = Date.now(); break;
      case '/': e.preventDefault(); this.focusSearch(); break;
      case '?': e.preventDefault(); this.shortcuts().open(); break;
      case 'n': if (this.perm.can('report')) { e.preventDefault(); this.router.navigate(['/report']); } break;
    }
  }
}
