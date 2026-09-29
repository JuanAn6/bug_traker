import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Toasts } from './core/toast.service';
import { Workspace } from './core/workspace.service';
import { TPipe } from './i18n/i18n.service';
import { ConfirmHost } from './shared/ui';
import { Icon } from './shared/icon/icon';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ConfirmHost, Icon, TPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly toasts = inject(Toasts);
  // Instantiated eagerly so theme/density/language apply on every page, including login.
  private readonly ws = inject(Workspace);
}
