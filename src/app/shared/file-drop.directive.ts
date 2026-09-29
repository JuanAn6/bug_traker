import { Directive, ElementRef, computed, inject, input, output, signal } from '@angular/core';
import { I18n } from '../i18n/i18n.service';

/** Adds drag-over styling and emits dropped files. */
@Directive({
  selector: '[appFileDrop]',
  host: {
    class: 'dropzone',
    '[class.dragging]': 'over()',
    '[attr.data-drop-label]': 'label()',
    '(dragenter)': 'enter($event)',
    '(dragover)': 'enter($event)',
    '(dragleave)': 'leave($event)',
    '(drop)': 'drop($event)',
  },
})
export class FileDrop {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly i18n = inject(I18n);
  readonly files = output<File[]>({ alias: 'appFileDrop' });
  readonly disabled = input(false, { alias: 'dropDisabled' });
  protected readonly over = signal(false);
  protected readonly label = computed(() => this.i18n.t('files.dropHere'));

  private hasFiles(e: DragEvent) {
    return !this.disabled() && !!e.dataTransfer?.types.includes('Files');
  }

  protected enter(e: DragEvent) {
    if (!this.hasFiles(e)) return;
    e.preventDefault();
    this.over.set(true);
  }

  protected leave(e: DragEvent) {
    if (!this.el.nativeElement.contains(e.relatedTarget as Node)) this.over.set(false);
  }

  protected drop(e: DragEvent) {
    if (!this.hasFiles(e)) return;
    e.preventDefault();
    this.over.set(false);
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) this.files.emit(files);
  }
}
