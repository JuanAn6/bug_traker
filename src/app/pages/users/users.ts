import { ChangeDetectionStrategy, Component, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Store } from '../../core/store.service';
import { Auth } from '../../core/auth.service';
import { Users as UserService, UserDraft } from '../../core/users.service';
import { Toasts } from '../../core/toast.service';
import { ACCESS_LEVELS, ACCESS_NAMES, AVATAR_COLORS, isResolved } from '../../core/config';
import type { AccessLevel, User } from '../../core/models';
import { FmtDatePipe, I18n, RelTimePipe, TPipe } from '../../i18n/i18n.service';
import { Icon } from '../../shared/icon/icon';
import { Avatar, Dialog, Empty, UserSelect } from '../../shared/ui';

@Component({
  selector: 'app-users',
  imports: [FormsModule, RouterLink, TPipe, FmtDatePipe, RelTimePipe, Icon, Avatar, Dialog, Empty, UserSelect],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './users.html',
  styleUrl: './users.css',
})
export class Users {
  protected readonly store = inject(Store);
  protected readonly auth = inject(Auth);
  private readonly svc = inject(UserService);
  private readonly toasts = inject(Toasts);
  private readonly i18n = inject(I18n);
  protected readonly editDlg = viewChild.required<Dialog>('editDlg');
  protected readonly deleteDlg = viewChild.required<Dialog>('deleteDlg');

  protected readonly levels = ACCESS_LEVELS;
  protected readonly names = ACCESS_NAMES;
  protected readonly query = signal('');
  protected readonly level = signal(0);
  protected readonly state = signal('');
  protected draft: UserDraft = blank();
  protected readonly deleting = signal<User | null>(null);
  protected reassignTo: number | null = null;

  protected readonly rows = computed(() => {
    const q = this.query().toLowerCase();
    return this.store.users()
      .filter((u) => (!q || (u.username + ' ' + u.realName + ' ' + u.email).toLowerCase().includes(q))
        && (!this.level() || u.accessLevel === this.level())
        && (!this.state() || (this.state() === 'enabled') === u.enabled))
      .sort((a, b) => a.username.localeCompare(b.username))
      .map((u) => ({
        u, open: this.openOf(u.id),
        projects: this.store.projects().filter((p) => p.members.some((m) => m.userId === u.id)).map((p) => p.key).join(', '),
      }));
  });

  protected openOf(id: number) {
    return this.store.issues().filter((i) => i.handlerId === id && !isResolved(i.status)).length;
  }

  protected usernameError() {
    const u = this.draft.username.trim();
    if (!u) return '';
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(u)) return this.i18n.t('users.usernameInvalid');
    return this.svc.usernameTaken(u, this.draft.id) ? this.i18n.t('users.usernameTaken') : '';
  }

  protected valid() {
    return !!this.draft.username.trim() && !this.usernameError() && !!this.draft.realName.trim() && /.+@.+\..+/.test(this.draft.email);
  }

  protected open(u?: User) {
    this.draft = u
      ? { id: u.id, username: u.username, realName: u.realName, email: u.email, accessLevel: u.accessLevel, enabled: u.enabled, avatarColor: u.avatarColor }
      : blank();
    this.editDlg().open();
  }

  protected save() {
    if (!this.valid()) return;
    this.svc.save(this.draft);
    this.editDlg().close();
    this.toasts.success(this.i18n.t('users.saved', { name: this.draft.username }));
  }

  protected toggle(u: User) {
    this.svc.save({ ...u, enabled: !u.enabled });
  }

  protected resetPassword(u: User) {
    // Demo only: no real credentials are stored.
    this.toasts.success(this.i18n.t('users.passwordReset', { email: u.email }));
  }

  protected askDelete(u: User) {
    this.deleting.set(u);
    this.reassignTo = null;
    this.deleteDlg().open();
  }

  protected remove() {
    const u = this.deleting();
    if (!u) return;
    this.svc.remove(u.id, this.reassignTo);
    this.deleteDlg().close();
    this.toasts.success(this.i18n.t('users.deleted', { name: u.username }));
  }
}

function blank(): UserDraft {
  return { username: '', realName: '', email: '', accessLevel: 25 as AccessLevel, enabled: true, avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)] };
}
