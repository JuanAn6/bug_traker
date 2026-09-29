import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { Severity } from '../../core/models';
import { TPipe } from '../../i18n/i18n.service';

@Component({
  selector: 'app-severity',
  imports: [TPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './severity-label.html',
  styleUrl: './severity-label.css',
})
export class SeverityLabel {
  readonly severity = input.required<Severity>();
  protected readonly strong = computed(() => ['major', 'crash', 'block'].includes(this.severity()));
}
