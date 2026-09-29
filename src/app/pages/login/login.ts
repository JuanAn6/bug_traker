import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Store } from '../../core/store.service';
import { Auth } from '../../core/auth.service';
import { Workspace } from '../../core/workspace.service';
import { ACCESS_NAMES, LANGUAGES } from '../../core/config';
import type { User } from '../../core/models';
import { I18n, TPipe } from '../../i18n/i18n.service';
import { Avatar } from '../../shared/ui';
import { Icon } from '../../shared/icon/icon';

@Component({
  selector: 'app-login',
  imports: [FormsModule, TPipe, Avatar, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './login.html',
  styleUrl: './login.css',
})
export class Login {
  private readonly store = inject(Store);
  private readonly auth = inject(Auth);
  private readonly ws = inject(Workspace);
  private readonly router = inject(Router);
  protected readonly i18n = inject(I18n);
  readonly next = input<string>();
  protected readonly languages = LANGUAGES;
  protected readonly names = ACCESS_NAMES;
  protected readonly users = computed(() => [...this.store.users()].sort((a, b) => b.accessLevel - a.accessLevel));
  protected username = '';
  protected password = '';
  protected remember = true;
  protected langChosen = false;
  protected readonly error = signal('');

  protected pick(u: User) {
    this.username = u.username;
    this.error.set('');
  }

  protected submit() {
    if (!this.auth.login(this.username, this.remember)) {
      this.error.set(this.i18n.t('login.invalid'));
      return;
    }
    // A language picked on the login screen becomes the user's preference.
    if (this.langChosen) this.auth.updatePrefs({ language: this.i18n.lang() });
    this.ws.applyDefaults();
    this.router.navigateByUrl(this.next() || '/');
  }
}
