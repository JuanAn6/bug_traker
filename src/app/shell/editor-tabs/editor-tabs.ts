import { ChangeDetectionStrategy, Component, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { EditorTab, Tabs } from '../../core/tabs.service';
import { TPipe } from '../../i18n/i18n.service';
import { Icon } from '../../shared/icon/icon';
import { Menu } from '../../shared/ui';

@Component({
  selector: 'app-editor-tabs',
  imports: [TPipe, Icon, Menu],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'editor-tabs', role: 'tablist' },
  templateUrl: './editor-tabs.html',
  styleUrl: './editor-tabs.css',
})
export class EditorTabs {
  protected readonly tabs = inject(Tabs);
  private readonly router = inject(Router);
  private readonly ctx = viewChild.required<Menu>('ctx');
  protected readonly ctxTab = signal<EditorTab | null>(null);
  protected readonly over = signal(-1);
  protected from = -1;

  protected go(t: EditorTab) {
    this.router.navigateByUrl(t.url);
  }

  protected context(e: MouseEvent, t: EditorTab) {
    e.preventDefault();
    this.ctxTab.set(t);
    this.ctx().openAt(e.clientX, e.clientY);
  }

  protected drop(to: number) {
    this.over.set(-1);
    if (this.from >= 0 && this.from !== to) this.tabs.move(this.from, to);
    this.from = -1;
  }
}
