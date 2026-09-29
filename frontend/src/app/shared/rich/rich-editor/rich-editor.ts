import {
  ChangeDetectionStrategy, Component, ElementRef, OnDestroy, afterNextRender, forwardRef, inject, input, output, signal, viewChild,
} from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { Editor } from '@tiptap/core';
import type { RichText } from '../../../core/models';
import { Store } from '../../../core/store.service';
import { Attachments } from '../../../core/attachments.service';
import { I18n, TPipe } from '../../../i18n/i18n.service';
import { richExtensions } from '../extensions';

interface Btn { label: string; title: string; run: (e: Editor) => void; active?: (e: Editor) => boolean; style?: string; }

/**
 * TipTap editor as a form control (value = TipTap JSON or null when empty).
 * `uploader` enables pasting/dropping/inserting images stored as attachments.
 */
@Component({
  selector: 'app-rich-editor',
  imports: [TPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => RichEditor), multi: true }],
  host: { class: 'rich-editor', '[class.disabled]': 'disabled()', '[style.--rt-min-height]': 'minHeight()' },
  templateUrl: './rich-editor.html',
  styleUrl: './rich-editor.css',
})
export class RichEditor implements ControlValueAccessor, OnDestroy {
  private readonly store = inject(Store);
  private readonly files = inject(Attachments);
  private readonly i18n = inject(I18n);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');

  readonly placeholder = input('');
  readonly minHeight = input('90px');
  readonly autofocus = input(false);
  /** Stores a pasted/dropped image and returns the new attachment id. */
  readonly uploader = input<((file: File) => Promise<number | null>) | null>(null);
  readonly submit = output<void>();

  editor: Editor | null = null;
  protected readonly tick = signal(0);
  protected readonly disabled = signal(false);
  private value: RichText = null;
  private onChange: (v: RichText) => void = () => {};
  private onTouched: () => void = () => {};

  protected readonly groups: Btn[][] = [
    [
      { label: 'B', title: 'editor.bold', style: 'font-weight:700', run: (e) => e.chain().focus().toggleBold().run(), active: (e) => e.isActive('bold') },
      { label: 'I', title: 'editor.italic', style: 'font-style:italic', run: (e) => e.chain().focus().toggleItalic().run(), active: (e) => e.isActive('italic') },
      { label: 'U', title: 'editor.underline', style: 'text-decoration:underline', run: (e) => e.chain().focus().toggleUnderline().run(), active: (e) => e.isActive('underline') },
      { label: 'S', title: 'editor.strike', style: 'text-decoration:line-through', run: (e) => e.chain().focus().toggleStrike().run(), active: (e) => e.isActive('strike') },
      { label: '</>', title: 'editor.code', run: (e) => e.chain().focus().toggleCode().run(), active: (e) => e.isActive('code') },
    ],
    [
      { label: 'H2', title: 'editor.h2', run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(), active: (e) => e.isActive('heading', { level: 2 }) },
      { label: 'H3', title: 'editor.h3', run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(), active: (e) => e.isActive('heading', { level: 3 }) },
    ],
    [
      { label: '•', title: 'editor.bullets', run: (e) => e.chain().focus().toggleBulletList().run(), active: (e) => e.isActive('bulletList') },
      { label: '1.', title: 'editor.ordered', run: (e) => e.chain().focus().toggleOrderedList().run(), active: (e) => e.isActive('orderedList') },
      { label: '☑', title: 'editor.tasks', run: (e) => e.chain().focus().toggleTaskList().run(), active: (e) => e.isActive('taskList') },
      { label: '❝', title: 'editor.quote', run: (e) => e.chain().focus().toggleBlockquote().run(), active: (e) => e.isActive('blockquote') },
      { label: '{ }', title: 'editor.codeBlock', run: (e) => e.chain().focus().toggleCodeBlock().run(), active: (e) => e.isActive('codeBlock') },
    ],
    [
      { label: '🔗', title: 'editor.link', run: (e) => this.link(e), active: (e) => e.isActive('link') },
      { label: '▦', title: 'editor.table', run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
      { label: '―', title: 'editor.hr', run: (e) => e.chain().focus().setHorizontalRule().run() },
      { label: '@', title: 'editor.mention', run: (e) => e.chain().focus().insertContent('@').run() },
    ],
    [
      { label: '↶', title: 'editor.undo', run: (e) => e.chain().focus().undo().run() },
      { label: '↷', title: 'editor.redo', run: (e) => e.chain().focus().redo().run() },
    ],
  ];

  protected readonly tableButtons: Btn[] = [
    { label: '+≡', title: 'editor.addRow', run: (e) => e.chain().focus().addRowAfter().run() },
    { label: '+‖', title: 'editor.addCol', run: (e) => e.chain().focus().addColumnAfter().run() },
    { label: '−≡', title: 'editor.delRow', run: (e) => e.chain().focus().deleteRow().run() },
    { label: '−‖', title: 'editor.delCol', run: (e) => e.chain().focus().deleteColumn().run() },
    { label: '✕▦', title: 'editor.delTable', run: (e) => e.chain().focus().deleteTable().run() },
  ];

  constructor() {
    afterNextRender(() => {
      this.editor = new Editor({
        element: this.host().nativeElement,
        extensions: richExtensions({
          placeholder: this.placeholder(),
          users: () => this.store.users(),
          resolveImage: (id) => {
            const att = this.files.get(id);
            return att ? this.files.url(att) : Promise.resolve('');
          },
        }),
        content: this.value ?? '',
        editable: !this.disabled(),
        autofocus: this.autofocus() ? 'end' : false,
        onUpdate: ({ editor }) => {
          this.value = editor.isEmpty ? null : editor.getJSON();
          this.onChange(this.value);
        },
        onTransaction: () => this.tick.update((n) => n + 1),
        onBlur: () => this.onTouched(),
        editorProps: {
          handleKeyDown: (_view, event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              this.submit.emit();
              return true;
            }
            return false;
          },
          handlePaste: (_view, event) => this.handleFiles(event.clipboardData?.files),
          handleDrop: (_view, event) => this.handleFiles((event as DragEvent).dataTransfer?.files),
        },
      });
    });
  }

  private handleFiles(list: FileList | undefined | null): boolean {
    const images = [...(list ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!images.length || !this.uploader()) return false;
    this.uploadAndInsert(images);
    return true;
  }

  private async uploadAndInsert(files: File[]) {
    for (const f of files) {
      const id = await this.uploader()!(f);
      if (id) this.editor?.chain().focus().setImage({ src: `attachment:${id}`, alt: f.name }).run();
    }
  }

  protected insertImages(input: HTMLInputElement) {
    this.uploadAndInsert([...(input.files ?? [])]);
    input.value = '';
  }

  private link(e: Editor) {
    const prev = e.getAttributes('link')['href'] as string | undefined;
    const url = prompt(this.i18n.t('editor.linkPrompt'), prev ?? 'https://');
    if (url === null) return;
    if (!url || url === 'https://') e.chain().focus().extendMarkRange('link').unsetLink().run();
    else e.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }

  focus() {
    this.editor?.commands.focus('end');
  }

  clear() {
    this.editor?.commands.clearContent(true);
  }

  /** Insert a quoted copy of another note. */
  quote(content: RichText, prefix: string) {
    if (!this.editor || !content?.content) return;
    this.editor.chain().focus('end').insertContent([
      { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: prefix, marks: [{ type: 'bold' }] }] }, ...content.content] },
      { type: 'paragraph' },
    ]).run();
  }

  writeValue(v: RichText): void {
    this.value = v ?? null;
    if (this.editor && JSON.stringify(this.editor.getJSON()) !== JSON.stringify(v)) {
      this.editor.commands.setContent(v ?? '', { emitUpdate: false });
    }
  }
  registerOnChange(fn: (v: RichText) => void): void { this.onChange = fn; }
  registerOnTouched(fn: () => void): void { this.onTouched = fn; }
  setDisabledState(d: boolean): void {
    this.disabled.set(d);
    this.editor?.setEditable(!d);
  }

  ngOnDestroy(): void {
    this.editor?.destroy();
  }
}
