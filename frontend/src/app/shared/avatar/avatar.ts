import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { User } from '../../core/models';

@Component({
  selector: 'app-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './avatar.html',
  styleUrl: './avatar.css',
})
export class Avatar {
  readonly user = input<User | undefined | null>();
  readonly large = input(false);
  protected readonly initials = computed(() =>
    (this.user()?.realName ?? '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase());
}
