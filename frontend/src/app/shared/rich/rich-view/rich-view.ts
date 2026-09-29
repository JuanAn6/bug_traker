import { ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, computed, inject, input, output } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { generateHTML } from '@tiptap/core';
import type { RichText } from '../../../core/models';
import { Attachments } from '../../../core/attachments.service';
import { STATIC_EXTENSIONS } from '../extensions';

/** Read-only rendering of TipTap JSON. */
@Component({
  selector: 'app-rich-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'rich', '(click)': 'onClick($event)' },
  templateUrl: './rich-view.html',
  styleUrl: './rich-view.css',
})
export class RichView {
  private readonly sanitizer = inject(DomSanitizer);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly files = inject(Attachments);

  readonly content = input<RichText>(null);
  readonly empty = input<string>('');
  readonly imageClick = output<number>();

  protected readonly html = computed(() => {
    const c = this.content();
    if (!c?.content?.length) return null;
    try {
      // Safe: HTML is produced by the TipTap schema serializer (text escaped, links protocol-checked),
      // never from raw user HTML. Bypassing keeps data-* attributes and task checkboxes.
      return this.sanitizer.bypassSecurityTrustHtml(generateHTML(c, STATIC_EXTENSIONS));
    } catch {
      return null;
    }
  });

  constructor() {
    afterRenderEffect(() => {
      this.html();
      const root = this.el.nativeElement;
      root.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((c) => (c.disabled = true));
      root.querySelectorAll<HTMLImageElement>('img[src^="attachment:"]').forEach((img) => {
        const id = Number(img.getAttribute('src')!.slice(11));
        img.dataset['attachmentId'] = String(id);
        img.removeAttribute('src');
        const att = this.files.get(id);
        if (att) this.files.url(att).then((u) => (img.src = u));
      });
    });
  }

  protected onClick(e: MouseEvent) {
    const img = (e.target as HTMLElement).closest('img[data-attachment-id]') as HTMLImageElement | null;
    if (img) this.imageClick.emit(Number(img.dataset['attachmentId']));
  }
}
