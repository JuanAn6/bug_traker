import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { Status } from '../../core/models';
import { TPipe } from '../../i18n/i18n.service';

@Component({
  selector: 'app-status',
  imports: [TPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './status-badge.html',
  styleUrl: './status-badge.css',
})
export class StatusBadge {
  readonly status = input.required<Status>();
}
