import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { Priority } from '../../core/models';
import { TPipe } from '../../i18n/i18n.service';

const PRI_ARROWS: Record<Priority, string> = { none: '', low: '▾', normal: '', high: '▴', urgent: '▲', immediate: '⇈' };

@Component({
  selector: 'app-priority',
  imports: [TPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './priority-label.html',
  styleUrl: './priority-label.css',
})
export class PriorityLabel {
  readonly priority = input.required<Priority>();
  readonly label = input(true);
  protected readonly arrow = computed(() => PRI_ARROWS[this.priority()]);
}
