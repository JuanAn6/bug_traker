import { Directive, ElementRef, inject, input } from '@angular/core';

/** Native `popover` menus anchored to their invoker (or opened at pointer coordinates as context menus). */
@Directive({
  selector: '[popover][appMenu]',
  exportAs: 'appMenu',
  host: { class: 'menu', '(toggle)': 'onToggle($event)', '(click)': 'onClick($event)', role: 'menu' },
})
export class Menu {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  /** Element to align under (or to the right of, with placement="right"). */
  readonly anchor = input<HTMLElement | null | ''>(null, { alias: 'appMenu' });
  readonly placement = input<'below' | 'right' | 'below-end'>('below');

  protected onToggle(e: Event) {
    if ((e as ToggleEvent).newState !== 'open') return;
    const a = this.anchor();
    if (a) {
      const r = a.getBoundingClientRect();
      const p = this.placement();
      this.place(p === 'right' || p === 'below-end' ? r.right : r.left, p === 'right' ? r.top : r.bottom + 2, p === 'below-end');
    }
    this.el.nativeElement.querySelector<HTMLElement>('button:not(:disabled),a')?.focus();
  }

  protected onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    if (t.closest('button,a') && !t.closest('[data-keep-open]')) this.el.nativeElement.hidePopover();
  }

  /** Context-menu usage: open at pointer coordinates. */
  openAt(x: number, y: number) {
    this.el.nativeElement.showPopover();
    this.place(x, y, false);
  }

  private place(x: number, y: number, alignEnd: boolean) {
    const el = this.el.nativeElement;
    el.style.left = '0px';
    el.style.top = '0px';
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(4, Math.min(alignEnd ? x - w : x, innerWidth - w - 4));
    const top = y + h > innerHeight - 4 ? Math.max(4, y - h) : y;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }
}
