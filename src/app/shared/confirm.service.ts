import { Injectable, signal } from '@angular/core';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirm?: string;
  danger?: boolean;
  /** Extra choices rendered as buttons; the promise resolves to the chosen value. */
  choices?: { label: string; value: string; danger?: boolean }[];
  /** Require typing this text to enable the confirm button. */
  typeToConfirm?: string;
}

/** Programmatic confirm dialog, rendered once by <app-confirm-host>. */
@Injectable({ providedIn: 'root' })
export class Confirm {
  readonly current = signal<(ConfirmOptions & { resolve: (v: string | false) => void }) | null>(null);

  ask(opts: ConfirmOptions): Promise<string | false> {
    return new Promise((resolve) => this.current.set({ ...opts, resolve }));
  }
}
