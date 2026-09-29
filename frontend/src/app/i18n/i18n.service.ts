import { Injectable, Pipe, PipeTransform, inject, signal } from '@angular/core';
import { en } from './en';
import { es } from './es';

type Dict = { [k: string]: string | Dict };

/** Register new languages here (and in LANGUAGES in core/config.ts). */
const DICTS: Record<string, Dict> = { en, es: es as Dict };

function lookup(d: Dict | undefined, key: string): string | undefined {
  let cur: string | Dict | undefined = d;
  for (const part of key.split('.')) {
    if (!cur || typeof cur === 'string') return undefined;
    cur = cur[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

export type Params = Record<string, string | number | null | undefined>;

@Injectable({ providedIn: 'root' })
export class I18n {
  readonly lang = signal<string>(initialLang());

  setLang(code: string) {
    this.lang.set(DICTS[code] ? code : 'en');
    document.documentElement.lang = this.lang();
    try { localStorage.setItem('bt:lang', this.lang()); } catch { /* ignore */ }
  }

  /** `t('issue.count', {count: 3})` picks `issue.count_one|_other` via Intl.PluralRules when present. */
  t(key: string, params?: Params): string {
    const lang = this.lang();
    let k = key;
    if (params && typeof params['count'] === 'number') {
      const form = new Intl.PluralRules(lang).select(params['count']);
      if (lookup(DICTS[lang], `${key}_${form}`) ?? lookup(en, `${key}_${form}`)) k = `${key}_${form}`;
    }
    const raw = lookup(DICTS[lang], k) ?? lookup(en, k);
    if (raw === undefined) {
      if (isDevMode) console.warn('[i18n] missing key', key);
      return key;
    }
    return params ? raw.replace(/\{(\w+)\}/g, (_, p: string) => String(params[p] ?? '')) : raw;
  }

  date(iso: string | null | undefined, style: 'date' | 'datetime' | 'short' | 'time' | 'month' = 'datetime'): string {
    if (!iso) return '';
    const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
    const opts: Intl.DateTimeFormatOptions =
      style === 'date' ? { dateStyle: 'medium' }
      : style === 'short' ? { day: '2-digit', month: 'short' }
      : style === 'time' ? { timeStyle: 'short' }
      : style === 'month' ? { month: 'long', year: 'numeric' }
      : { dateStyle: 'medium', timeStyle: 'short' };
    return new Intl.DateTimeFormat(this.lang(), opts).format(d);
  }

  relative(iso: string | null | undefined, now = Date.now()): string {
    if (!iso) return '';
    const diff = (new Date(iso).getTime() - now) / 1000;
    const rtf = new Intl.RelativeTimeFormat(this.lang(), { numeric: 'auto' });
    const units: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
    for (const [u, s] of units) if (Math.abs(diff) >= s) return rtf.format(Math.round(diff / s), u);
    return rtf.format(Math.round(diff), 'second');
  }

  number(n: number, opts?: Intl.NumberFormatOptions) {
    return new Intl.NumberFormat(this.lang(), opts).format(n);
  }

  bytes(n: number): string {
    const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return this.number(n, { style: 'unit', unit: units[i], unitDisplay: 'short', maximumFractionDigits: i ? 1 : 0 });
  }

  minutes(total: number): string {
    const h = Math.floor(total / 60);
    const m = total % 60;
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
  }
}

const isDevMode = typeof ngDevMode === 'undefined' || !!ngDevMode;
declare const ngDevMode: unknown;

function initialLang(): string {
  try {
    const saved = localStorage.getItem('bt:lang');
    if (saved && DICTS[saved]) return saved;
  } catch { /* ignore */ }
  const nav = navigator.language.slice(0, 2);
  return DICTS[nav] ? nav : 'en';
}

// Impure pipes re-run on every change detection and read the `lang` signal,
// so templates update instantly when the language changes.
@Pipe({ name: 't', pure: false })
export class TPipe implements PipeTransform {
  private readonly i18n = inject(I18n);
  transform(key: string, params?: Params): string {
    return this.i18n.t(key, params);
  }
}

@Pipe({ name: 'fmtDate', pure: false })
export class FmtDatePipe implements PipeTransform {
  private readonly i18n = inject(I18n);
  transform(iso: string | null | undefined, style: 'date' | 'datetime' | 'short' | 'time' | 'month' = 'datetime'): string {
    return this.i18n.date(iso, style);
  }
}

@Pipe({ name: 'relTime', pure: false })
export class RelTimePipe implements PipeTransform {
  private readonly i18n = inject(I18n);
  transform(iso: string | null | undefined): string {
    return this.i18n.relative(iso);
  }
}

@Pipe({ name: 'bytes', pure: false })
export class BytesPipe implements PipeTransform {
  private readonly i18n = inject(I18n);
  transform(n: number): string {
    return this.i18n.bytes(n);
  }
}

export const I18N_PIPES = [TPipe, FmtDatePipe, RelTimePipe, BytesPipe] as const;
