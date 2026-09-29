import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store } from '../../core/store.service';
import { Permissions } from '../../core/permissions.service';
import { Attachments } from '../../core/attachments.service';
import { Toasts } from '../../core/toast.service';
import { downloadText } from '../../core/csv';
import { BytesPipe, I18n, TPipe } from '../../i18n/i18n.service';
import { Icon } from '../../shared/icon/icon';
import { Confirm } from '../../shared/ui';

@Component({
  selector: 'app-settings',
  imports: [RouterLink, TPipe, BytesPipe, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings.html',
  styleUrl: './settings.css',
})
export class Settings {
  protected readonly store = inject(Store);
  protected readonly perm = inject(Permissions);
  private readonly files = inject(Attachments);
  private readonly toasts = inject(Toasts);
  private readonly confirm = inject(Confirm);
  private readonly i18n = inject(I18n);

  protected readonly dataSize = computed(() => new Blob([this.store.exportJson()]).size);
  protected readonly filesSize = computed(() => this.store.attachments().reduce((s, a) => s + a.size, 0));
  protected readonly quota = signal<{ usage: number; quota: number } | null>(null);

  constructor() {
    navigator.storage?.estimate().then((e) => this.quota.set({ usage: e.usage ?? 0, quota: e.quota ?? 0 })).catch(() => {});
  }

  protected exportAll() {
    downloadText(`bugtracker-backup-${new Date().toISOString().slice(0, 10)}.json`, this.store.exportJson(), 'application/json');
  }

  protected async importAll(input: HTMLInputElement) {
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    const ok = await this.confirm.ask({ title: this.i18n.t('settings.import'), message: this.i18n.t('settings.importConfirm'), danger: true });
    if (!ok) return;
    try {
      const before = this.store.snapshot();
      this.store.importJson(await f.text());
      this.toasts.success(this.i18n.t('settings.imported'), { label: this.i18n.t('common.undo'), run: () => this.store.restore(before) });
    } catch (e) {
      this.toasts.error(this.i18n.t('settings.importFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  protected async purge() {
    const n = await this.files.purgeOrphans();
    this.toasts.success(this.i18n.t('settings.purged', { count: n }));
  }

  protected async clearFiles() {
    const ok = await this.confirm.ask({
      title: this.i18n.t('settings.clearFiles'), message: this.i18n.t('settings.clearFilesConfirm', { count: this.store.attachments().length }),
      danger: true, confirm: this.i18n.t('common.delete'),
    });
    if (ok) await this.files.clearAll();
  }

  protected async reset() {
    const ok = await this.confirm.ask({
      title: this.i18n.t('settings.reset'), message: this.i18n.t('settings.resetConfirm'), danger: true, confirm: this.i18n.t('settings.reset'), typeToConfirm: 'RESET',
    });
    if (!ok) return;
    this.store.reset();
    await this.files.purgeOrphans();
    this.toasts.success(this.i18n.t('settings.resetDone'));
  }
}
