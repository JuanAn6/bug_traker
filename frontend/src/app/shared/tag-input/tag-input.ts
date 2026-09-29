import { ChangeDetectionStrategy, Component, computed, inject, input, model, output } from '@angular/core';
import { Store } from '../../core/store.service';
import { TPipe } from '../../i18n/i18n.service';
import { Icon } from '../icon/icon';

/** Tag chips + <datalist> autocomplete input. */
@Component({
  selector: 'app-tag-input',
  imports: [TPipe, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './tag-input.html',
  styleUrl: './tag-input.css',
})
export class TagInput {
  private readonly store = inject(Store);
  readonly value = model<string[]>([]);
  readonly readonly = input(false);
  readonly added = output<string>();
  readonly removed = output<string>();
  protected readonly listId = 'tags-' + Math.random().toString(36).slice(2);
  protected readonly suggestions = computed(() => this.store.tags().map(([t]) => t).filter((t) => !this.value().includes(t)));

  protected add(inp: HTMLInputElement) {
    const t = inp.value.trim().toLowerCase().replace(/\s+/g, '-');
    inp.value = '';
    if (!t || this.value().includes(t)) return;
    this.value.set([...this.value(), t]);
    this.added.emit(t);
  }

  protected remove(t: string) {
    this.value.set(this.value().filter((x) => x !== t));
    this.removed.emit(t);
  }
}
