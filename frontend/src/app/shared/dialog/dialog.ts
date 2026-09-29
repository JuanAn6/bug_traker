import { ChangeDetectionStrategy, Component, ElementRef, input, output, signal, viewChild } from '@angular/core';
import { TPipe } from '../../i18n/i18n.service';
import { Icon } from '../icon/icon';

/** Native modal <dialog> with header, projected body and a `[footer]` slot. */
@Component({
  selector: 'app-dialog',
  imports: [Icon, TPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dialog.html',
  styleUrl: './dialog.css',
})
export class Dialog {
  readonly title = input('');
  readonly size = input<'' | 'narrow' | 'wide' | 'drawer'>('');
  readonly closed = output<void>();
  protected readonly isOpen = signal(false);
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  open() {
    this.isOpen.set(true);
    if (!this.dlg().nativeElement.open) this.dlg().nativeElement.showModal();
  }

  close() {
    this.dlg().nativeElement.close();
  }

  protected onClose() {
    this.isOpen.set(false);
    this.closed.emit();
  }

  protected backdrop(e: MouseEvent) {
    // Clicks on the backdrop target the <dialog> element itself.
    if (e.target === this.dlg().nativeElement) {
      const r = this.dlg().nativeElement.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) this.close();
    }
  }
}
