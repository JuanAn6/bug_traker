import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { Store } from '../../core/store.service';
import { Workspace } from '../../core/workspace.service';
import { Permissions } from '../../core/permissions.service';
import { I18n, TPipe } from '../../i18n/i18n.service';
import { Icon } from '../../shared/icon/icon';

interface Cmd { label: string; kind: string; icon: string; run: () => void; }

/** Ctrl+K palette: jump to issues, projects, users and pages. */
@Component({
  selector: 'app-command-palette',
  imports: [TPipe, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './command-palette.html',
  styleUrl: './command-palette.css',
})
export class CommandPalette {
  private readonly store = inject(Store);
  private readonly ws = inject(Workspace);
  private readonly perm = inject(Permissions);
  private readonly router = inject(Router);
  private readonly i18n = inject(I18n);
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');
  private readonly inp = viewChild.required<ElementRef<HTMLInputElement>>('inp');
  protected readonly query = signal('');
  protected readonly active = signal(0);

  private readonly pages = computed<Cmd[]>(() => {
    const t = (k: string) => this.i18n.t(k);
    const go = (url: string) => () => this.router.navigateByUrl(url);
    const kind = t('palette.page');
    const list: Cmd[] = [
      { label: t('nav.home'), kind, icon: 'home', run: go('/') },
      { label: t('nav.issues'), kind, icon: 'list', run: go('/issues') },
      { label: t('nav.report'), kind, icon: 'plus', run: go('/report') },
      { label: t('nav.board'), kind, icon: 'board', run: go('/board') },
      { label: t('nav.sprints'), kind, icon: 'zap', run: go('/sprints') },
      { label: t('nav.roadmap'), kind, icon: 'map', run: go('/roadmap') },
      { label: t('nav.changelog'), kind, icon: 'file-text', run: go('/changelog') },
      { label: t('nav.summary'), kind, icon: 'chart', run: go('/summary') },
      { label: t('nav.calendar'), kind, icon: 'calendar', run: go('/calendar') },
      { label: t('nav.notifications'), kind, icon: 'bell', run: go('/notifications') },
      { label: t('nav.account'), kind, icon: 'user', run: go('/account') },
      { label: t('nav.settings'), kind, icon: 'sliders', run: go('/settings') },
      { label: t('nav.projects'), kind, icon: 'database', run: go('/projects') },
    ];
    if (this.perm.can('manageUsers')) list.push({ label: t('nav.users'), kind, icon: 'users', run: go('/users') });
    if (this.perm.can('manageWorkflow')) list.push({ label: t('nav.workflow'), kind, icon: 'workflow', run: go('/admin/workflow') });
    if (this.perm.can('manageCustomFields')) list.push({ label: t('nav.customFields'), kind, icon: 'columns', run: go('/admin/custom-fields') });
    if (this.perm.can('manageTags')) list.push({ label: t('nav.tags'), kind, icon: 'tag', run: go('/admin/tags') });
    return list;
  });

  protected readonly results = computed<Cmd[]>(() => {
    const q = this.query().trim().toLowerCase();
    const issueKind = this.i18n.t('palette.issue');
    const idMatch = /^(?:[a-z]+-)?#?(\d+)$/.exec(q);
    const issues = this.ws.visibleIssues()
      .filter((i) => !q || (idMatch ? String(i.id).startsWith(idMatch[1]) : fuzzy(q, `${this.store.issueKey(i)} ${i.summary}`)))
      .slice(0, q ? 12 : 6)
      .map<Cmd>((i) => ({ label: `${this.store.issueKey(i)} ${i.summary}`, kind: issueKind, icon: 'bug', run: () => this.router.navigate(['/issues', i.id]) }));
    const projects = this.ws.visibleProjects().filter((p) => fuzzy(q, p.name + ' ' + p.key))
      .map<Cmd>((p) => ({ label: p.name, kind: this.i18n.t('palette.project'), icon: 'database', run: () => { this.ws.projectId.set(p.id); this.router.navigate(['/issues']); } }));
    const users = this.store.users().filter((u) => q && fuzzy(q, u.realName + ' ' + u.username))
      .map<Cmd>((u) => ({ label: `${u.realName} (@${u.username})`, kind: this.i18n.t('palette.user'), icon: 'user',
        run: () => this.router.navigate(['/issues'], { queryParams: { handlerIds: u.id } }) }));
    const pages = this.pages().filter((c) => fuzzy(q, c.label));
    return [...(idMatch ? issues : []), ...pages, ...(idMatch ? [] : issues), ...projects, ...users].slice(0, 30);
  });

  open() {
    this.active.set(0);
    this.dlg().nativeElement.showModal();
    this.inp().nativeElement.focus();
  }

  protected key(e: KeyboardEvent) {
    const n = this.results().length;
    if (e.key === 'ArrowDown') { e.preventDefault(); this.active.set((this.active() + 1) % Math.max(n, 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.active.set((this.active() - 1 + n) % Math.max(n, 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = this.results()[this.active()]; if (c) this.run(c); }
  }

  protected run(c: Cmd) {
    this.dlg().nativeElement.close();
    c.run();
  }
}

/** Subsequence match: every query char appears in order. */
function fuzzy(q: string, text: string): boolean {
  if (!q) return true;
  const t = text.toLowerCase();
  if (t.includes(q)) return true;
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  return i === q.length;
}
