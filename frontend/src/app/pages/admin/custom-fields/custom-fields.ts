import { ChangeDetectionStrategy, Component, inject, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Store } from '../../../core/store.service';
import { Toasts } from '../../../core/toast.service';
import { CUSTOM_FIELD_TYPES } from '../../../core/config';
import type { CustomField } from '../../../core/models';
import { I18n, TPipe } from '../../../i18n/i18n.service';
import { Icon } from '../../../shared/icon/icon';
import { Confirm, Dialog, Empty } from '../../../shared/ui';

type Draft = Omit<CustomField, 'id'> & { id?: number; optionsText: string; projectIds: number[] };

@Component({
  selector: 'app-custom-fields-admin',
  imports: [FormsModule, TPipe, Icon, Dialog, Empty],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './custom-fields.html',
  styleUrl: './custom-fields.css',
})
export class CustomFieldsAdmin {
  protected readonly store = inject(Store);
  private readonly toasts = inject(Toasts);
  private readonly confirm = inject(Confirm);
  private readonly i18n = inject(I18n);
  protected readonly dlg = viewChild.required<Dialog>('dlg');
  protected readonly types = CUSTOM_FIELD_TYPES;
  protected draft: Draft = blank();

  protected projectsOf(id: number) {
    return this.store.projects().filter((p) => p.customFieldIds.includes(id)).map((p) => p.key).join(', ');
  }

  protected usage(id: number) {
    return this.store.issues().filter((i) => i.customFields[id]).length;
  }

  protected open(f?: CustomField) {
    this.draft = f
      ? { ...f, optionsText: f.options.join('\n'), projectIds: this.store.projects().filter((p) => p.customFieldIds.includes(f.id)).map((p) => p.id) }
      : blank();
    this.dlg().open();
  }

  protected toggleProject(id: number) {
    const ids = this.draft.projectIds;
    this.draft.projectIds = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
  }

  protected save() {
    const { optionsText, projectIds, ...rest } = this.draft;
    const field: Omit<CustomField, 'id'> = {
      ...rest, name: rest.name.trim(),
      options: rest.type === 'list' ? optionsText.split('\n').map((o) => o.trim()).filter(Boolean) : [],
    };
    this.store.mutate((d) => {
      const id = rest.id ?? this.store.nextId(d);
      const existing = d.customFields.find((f) => f.id === id);
      if (existing) Object.assign(existing, field);
      else d.customFields.push({ ...field, id });
      for (const p of d.projects) {
        const has = p.customFieldIds.includes(id);
        if (projectIds.includes(p.id) && !has) p.customFieldIds.push(id);
        if (!projectIds.includes(p.id) && has) p.customFieldIds = p.customFieldIds.filter((x) => x !== id);
      }
    });
    this.dlg().close();
    this.toasts.success(this.i18n.t('customFields.saved', { name: field.name }));
  }

  protected async remove(f: CustomField) {
    const ok = await this.confirm.ask({
      title: this.i18n.t('customFields.delete'), message: this.i18n.t('customFields.deleteConfirm', { name: f.name, count: this.usage(f.id) }),
      danger: true, confirm: this.i18n.t('common.delete'),
    });
    if (!ok) return;
    this.store.mutate((d) => {
      d.customFields = d.customFields.filter((x) => x.id !== f.id);
      d.projects.forEach((p) => (p.customFieldIds = p.customFieldIds.filter((x) => x !== f.id)));
      d.issues.forEach((i) => delete i.customFields[f.id]);
    });
  }
}

function blank(): Draft {
  return { name: '', type: 'string', options: [], required: false, defaultValue: '', optionsText: '', projectIds: [] };
}
