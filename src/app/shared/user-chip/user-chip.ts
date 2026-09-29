import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Store } from '../../core/store.service';
import { TPipe } from '../../i18n/i18n.service';
import { Avatar } from '../avatar/avatar';

/** Avatar + name for a user id; renders a muted placeholder for null. */
@Component({
  selector: 'app-user',
  imports: [Avatar, TPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'row tight nowrap' },
  templateUrl: './user-chip.html',
  styleUrl: './user-chip.css',
})
export class UserChip {
  private readonly store = inject(Store);
  readonly id = input<number | null | undefined>();
  readonly short = input(false);
  readonly empty = input('');
  protected readonly user = computed(() => {
    const id = this.id();
    return id ? this.store.userMap().get(id) : undefined;
  });
}
