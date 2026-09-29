import { Injectable, signal } from '@angular/core';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'warning' | 'error';
  action?: { label: string; run: () => void };
}

@Injectable({ providedIn: 'root' })
export class Toasts {
  readonly items = signal<Toast[]>([]);
  private seq = 0;

  show(text: string, kind: Toast['kind'] = 'info', action?: Toast['action'], ms = 6000) {
    const t: Toast = { id: ++this.seq, text, kind, action };
    this.items.update((l) => [...l, t]);
    setTimeout(() => this.dismiss(t.id), ms);
    return t.id;
  }

  success = (text: string, action?: Toast['action']) => this.show(text, 'success', action);
  error = (text: string) => this.show(text, 'error', undefined, 9000);
  warn = (text: string) => this.show(text, 'warning');

  dismiss(id: number) {
    this.items.update((l) => l.filter((t) => t.id !== id));
  }
}
