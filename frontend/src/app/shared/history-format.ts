import { inject, Injectable } from '@angular/core';
import type { HistoryEntry } from '../core/models';
import { Store } from '../core/store.service';
import { I18n } from '../i18n/i18n.service';

const ENUM_FIELDS: Record<string, string> = {
  status: 'status', resolution: 'resolution', priority: 'priority', severity: 'severity',
  reproducibility: 'reproducibility', viewState: 'viewState',
};

/** Human-readable rendering of history rows (shared by issue history and activity feeds). */
@Injectable({ providedIn: 'root' })
export class HistoryFormat {
  private readonly store = inject(Store);
  private readonly i18n = inject(I18n);

  field(h: HistoryEntry): string {
    if (h.type === 'field') return this.i18n.t('fields.' + h.field);
    if (h.type.startsWith('relationship')) return `${this.i18n.t('history.' + h.type)} (${this.i18n.t('relationship.' + h.field)})`;
    return this.i18n.t('history.' + h.type);
  }

  value(h: HistoryEntry, v: string): string {
    if (!v) return '';
    if (h.type.startsWith('relationship') || h.type === 'cloned') return '#' + v;
    if (h.type.startsWith('monitor')) return this.user(v);
    if (h.type.startsWith('note')) return h.type === 'note_added' ? '#' + v : v;
    const f = h.field;
    if (ENUM_FIELDS[f]) return this.i18n.t(`${ENUM_FIELDS[f]}.${v}`);
    if (f === 'handlerId' || f === 'reporterId') return this.user(v);
    if (f === 'projectId') return this.store.projectMap().get(+v)?.name ?? v;
    if (f === 'sprintId') return this.store.sprintMap().get(+v)?.name ?? v;
    if (f === 'sticky' || f === 'notePrivate') return this.i18n.t(v === 'true' ? 'common.yes' : 'common.no');
    if (f === 'dueDate') return this.i18n.date(v, 'date');
    return v;
  }

  /** One-line description, e.g. "Status: new → assigned". */
  line(h: HistoryEntry): string {
    const o = this.value(h, h.old);
    const n = this.value(h, h.new);
    if (h.type === 'created') return this.i18n.t('history.created');
    return `${this.field(h)}${o || n ? ': ' : ''}${o}${o && n ? ' → ' : ''}${n}`;
  }

  private user(id: string): string {
    return this.store.userMap().get(+id)?.username ?? id;
  }
}
