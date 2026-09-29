import { ChangeDetectionStrategy, Component, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TPipe } from '../../i18n/i18n.service';
import { Confirm } from '../confirm.service';
import { Dialog } from '../dialog/dialog';

@Component({
  selector: 'app-confirm-host',
  imports: [Dialog, TPipe, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './confirm-host.html',
  styleUrl: './confirm-host.css',
})
export class ConfirmHost {
  private readonly svc = inject(Confirm);
  protected readonly c = this.svc.current;
  protected readonly typed = signal('');
  private readonly d = viewChild.required<Dialog>('d');

  constructor() {
    // Open whenever a request arrives.
    effect(() => {
      if (!this.c()) return;
      untracked(() => {
        this.typed.set('');
        this.d().open();
      });
    });
  }

  protected answer(v: string | false) {
    const cur = this.c();
    if (!cur) return;
    this.svc.current.set(null);
    this.d().close();
    cur.resolve(v);
  }
}
