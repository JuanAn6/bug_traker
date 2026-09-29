import { ChangeDetectionStrategy, Component, computed, inject, input, model } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Store } from '../../core/store.service';
import { ACCESS_NAMES } from '../../core/config';
import { TPipe } from '../../i18n/i18n.service';

/** Native <select> of enabled users, optionally with an empty ("unassigned") option. */
@Component({
  selector: 'app-user-select',
  imports: [FormsModule, TPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './user-select.html',
  styleUrl: './user-select.css',
})
export class UserSelect {
  private readonly store = inject(Store);
  readonly value = model<number | null>(null);
  readonly allowNone = input(true);
  readonly noneLabel = input('common.unassigned');
  readonly label = input('common.user');
  readonly minLevel = input(10);
  readonly showLevel = input(false);
  readonly disabled = input(false);
  /** Restrict to these user ids (e.g. project members). */
  readonly only = input<number[] | null>(null);
  protected readonly names = ACCESS_NAMES;
  protected readonly users = computed(() => {
    const only = this.only();
    return this.store.users()
      .filter((u) => u.enabled && u.accessLevel >= this.minLevel() && (!only || only.includes(u.id) || u.accessLevel === 90))
      .sort((a, b) => a.realName.localeCompare(b.realName));
  });
}
