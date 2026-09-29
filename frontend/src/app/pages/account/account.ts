import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Store } from '../../core/store.service';
import { Auth } from '../../core/auth.service';
import { Workspace } from '../../core/workspace.service';
import { Users } from '../../core/users.service';
import { Toasts } from '../../core/toast.service';
import { ACCESS_NAMES, LANGUAGES } from '../../core/config';
import type { NotifyEvent } from '../../core/models';
import { I18n, TPipe } from '../../i18n/i18n.service';
import { Icon } from '../../shared/icon/icon';
import { Avatar } from '../../shared/ui';

@Component({
  selector: 'app-account',
  imports: [FormsModule, RouterLink, TPipe, Icon, Avatar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './account.html',
  styleUrl: './account.css',
})
export class Account {
  protected readonly auth = inject(Auth);
  protected readonly ws = inject(Workspace);
  private readonly store = inject(Store);
  private readonly users = inject(Users);
  private readonly toasts = inject(Toasts);
  private readonly i18n = inject(I18n);
  protected readonly names = ACCESS_NAMES;
  protected readonly languages = LANGUAGES;
  protected readonly events: NotifyEvent[] = ['assigned', 'mentioned', 'status', 'note', 'attachment'];
  protected readonly me = this.auth.me;
  protected readonly prefs = computed(() => this.me().prefs);
  protected readonly monitored = computed(() => this.store.issues().filter((i) => i.monitorIds.includes(this.me().id)).length);

  protected realName = this.me().realName;
  protected email = this.me().email;
  protected color = this.me().avatarColor;
  protected pwCurrent = '';
  protected pwNew = '';
  protected pwConfirm = '';

  protected pwError(): string {
    if (!this.pwNew && !this.pwConfirm) return '';
    if (!this.pwCurrent) return this.i18n.t('account.currentRequired');
    if (this.pwNew.length < 8) return this.i18n.t('account.passwordShort');
    if (this.pwNew !== this.pwConfirm) return this.i18n.t('account.passwordMismatch');
    return '';
  }

  protected saveProfile() {
    const u = this.me();
    this.users.save({ ...u, realName: this.realName.trim(), email: this.email.trim(), avatarColor: this.color });
    this.toasts.success(this.i18n.t('account.saved'));
  }

  protected changePassword() {
    if (this.pwError()) return;
    // Demo only: there is no credential store.
    this.pwCurrent = this.pwNew = this.pwConfirm = '';
    this.toasts.success(this.i18n.t('account.passwordChanged'));
  }

  protected toggleNotify(e: NotifyEvent) {
    const n = this.prefs().notify;
    this.auth.updatePrefs({ notify: { ...n, [e]: !n[e] } });
  }
}
