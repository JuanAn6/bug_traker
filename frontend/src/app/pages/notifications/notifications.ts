import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store } from '../../core/store.service';
import { Notifications } from '../../core/notifications.service';
import type { NotifyEvent } from '../../core/models';
import { FmtDatePipe, RelTimePipe, TPipe } from '../../i18n/i18n.service';
import { Icon } from '../../shared/icon/icon';
import { Empty, UserChip } from '../../shared/ui';

const ICON: Record<NotifyEvent, string> = { assigned: 'user', mentioned: 'message', status: 'workflow', note: 'message', attachment: 'paperclip' };

@Component({
  selector: 'app-notifications',
  imports: [RouterLink, TPipe, FmtDatePipe, RelTimePipe, Icon, Empty, UserChip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './notifications.html',
  styleUrl: './notifications.css',
})
export class NotificationsPage {
  protected readonly store = inject(Store);
  protected readonly svc = inject(Notifications);
  protected readonly icon = ICON;
  protected readonly types = Object.keys(ICON) as NotifyEvent[];
  protected readonly unreadOnly = signal(false);
  protected readonly type = signal<string>('');
  protected readonly list = computed(() =>
    this.svc.mine().filter((n) => (!this.unreadOnly() || !n.read) && (!this.type() || n.type === this.type())));
  protected readonly readIds = computed(() => this.svc.mine().filter((n) => n.read).map((n) => n.id));
}
