import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Store } from '../../../core/store.service';
import { Toasts } from '../../../core/toast.service';
import { I18n, TPipe } from '../../../i18n/i18n.service';
import { Icon } from '../../../shared/icon/icon';
import { Confirm, Empty } from '../../../shared/ui';

/** Tags are derived from issues; renaming onto an existing tag merges them. */
@Component({
  selector: 'app-tags-admin',
  imports: [FormsModule, RouterLink, TPipe, Icon, Empty],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './tags.html',
  styleUrl: './tags.css',
})
export class TagsAdmin {
  private readonly store = inject(Store);
  private readonly toasts = inject(Toasts);
  private readonly confirm = inject(Confirm);
  private readonly i18n = inject(I18n);
  protected readonly query = signal('');
  protected readonly list = computed(() => this.store.tags().filter(([t]) => t.includes(this.query().toLowerCase())));

  protected rename(from: string, raw: string) {
    const to = raw.trim().toLowerCase().replace(/\s+/g, '-');
    if (!to || to === from) return;
    const merge = this.store.tags().some(([t]) => t === to);
    this.store.mutate((d) => d.issues.forEach((i) => {
      if (!i.tags.includes(from)) return;
      i.tags = [...new Set(i.tags.map((t) => (t === from ? to : t)))];
    }));
    this.toasts.success(this.i18n.t(merge ? 'tags.merged' : 'tags.renamed', { from, to }));
  }

  protected async remove(tag: string, count: number) {
    const ok = await this.confirm.ask({ title: this.i18n.t('tags.delete'), message: this.i18n.t('tags.deleteConfirm', { tag, count }), danger: true });
    if (!ok) return;
    const before = this.store.snapshot();
    this.store.mutate((d) => d.issues.forEach((i) => (i.tags = i.tags.filter((t) => t !== tag))));
    this.toasts.success(this.i18n.t('tags.deleted', { tag }), { label: this.i18n.t('common.undo'), run: () => this.store.restore(before) });
  }
}
