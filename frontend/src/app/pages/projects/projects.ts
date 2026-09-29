import { ChangeDetectionStrategy, Component, computed, inject, input, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Store } from '../../core/store.service';
import { Workspace } from '../../core/workspace.service';
import { Permissions } from '../../core/permissions.service';
import { Projects as ProjectService } from '../../core/project.service';
import { Toasts } from '../../core/toast.service';
import { PROJECT_STATUSES, isResolved } from '../../core/config';
import type { Project, ProjectStatus, RichText, ViewState } from '../../core/models';
import { FmtDatePipe, I18n, TPipe } from '../../i18n/i18n.service';
import { Icon } from '../../shared/icon/icon';
import { RichEditor } from '../../shared/rich/rich-editor/rich-editor';
import { Confirm, Dialog, Empty } from '../../shared/ui';

@Component({
  selector: 'app-projects',
  imports: [FormsModule, RouterLink, TPipe, FmtDatePipe, Icon, Dialog, Empty, RichEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './projects.html',
  styleUrl: './projects.css',
})
export class Projects {
  protected readonly store = inject(Store);
  protected readonly ws = inject(Workspace);
  protected readonly perm = inject(Permissions);
  private readonly svc = inject(ProjectService);
  private readonly toasts = inject(Toasts);
  private readonly confirm = inject(Confirm);
  private readonly i18n = inject(I18n);
  private readonly router = inject(Router);
  protected readonly newDlg = viewChild.required<Dialog>('newDlg');

  readonly new = input<string>();
  protected readonly statuses = PROJECT_STATUSES;
  protected readonly query = signal('');
  protected readonly showDisabled = signal(true);
  protected draft = blank();

  protected readonly rows = computed(() => {
    const q = this.query().toLowerCase();
    return this.ws.visibleProjects()
      .filter((p) => (this.showDisabled() || p.enabled) && (!q || (p.name + ' ' + p.key).toLowerCase().includes(q)))
      .map((p) => {
        const list = this.store.issues().filter((i) => i.projectId === p.id);
        return { p, total: list.length, open: list.filter((i) => !isResolved(i.status)).length };
      });
  });

  constructor() {
    queueMicrotask(() => this.new() && this.perm.can('manageProject') && this.openNew());
  }

  protected keyError() {
    const k = this.draft.key.trim();
    if (!k) return '';
    if (!/^[A-Za-z][A-Za-z0-9]{1,9}$/.test(k)) return this.i18n.t('projects.keyInvalid');
    return this.svc.keyTaken(k) ? this.i18n.t('projects.keyTaken') : '';
  }

  protected suggestKey() {
    if (this.keyEdited) return;
    this.draft.key = this.draft.name.split(/\s+/).map((w) => w[0] ?? '').join('').toUpperCase().slice(0, 4)
      || this.draft.name.slice(0, 3).toUpperCase();
  }
  protected keyEdited = false;

  protected openNew() {
    this.draft = blank();
    this.keyEdited = false;
    this.newDlg().open();
  }

  protected create() {
    if (!this.draft.name.trim() || this.keyError() || !this.draft.key.trim()) return;
    const id = this.svc.create({ ...this.draft, name: this.draft.name.trim(), key: this.draft.key.trim() });
    this.newDlg().close();
    this.toasts.success(this.i18n.t('projects.created', { name: this.draft.name }));
    this.router.navigate(['/projects', id]);
  }

  protected async remove(p: Project) {
    const count = this.svc.issueCount(p.id);
    const ok = await this.confirm.ask({
      title: this.i18n.t('projects.delete'), message: this.i18n.t('projects.deleteConfirm', { name: p.name, count }),
      danger: true, confirm: this.i18n.t('common.delete'), typeToConfirm: p.key,
    });
    if (ok) {
      this.svc.remove(p.id);
      this.toasts.success(this.i18n.t('projects.deleted', { name: p.name }));
    }
  }
}

function blank() {
  return {
    name: '', key: '', parentId: null as number | null, status: 'development' as ProjectStatus, viewState: 'public' as ViewState,
    enabled: true, description: null as RichText,
  };
}
