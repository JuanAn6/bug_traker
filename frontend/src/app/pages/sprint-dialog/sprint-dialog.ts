import { ChangeDetectionStrategy, Component, computed, inject, output, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Store } from '../../core/store.service';
import { Workspace } from '../../core/workspace.service';
import { Permissions } from '../../core/permissions.service';
import { Sprints } from '../../core/sprint.service';
import { SPRINT_STATES } from '../../core/config';
import type { Sprint } from '../../core/models';
import { TPipe } from '../../i18n/i18n.service';
import { Dialog } from '../../shared/ui';

type SprintDraft = Omit<Sprint, 'id'> & { id?: number };

/** Create / edit sprint dialog shared by the sprint list and detail pages. */
@Component({
  selector: 'app-sprint-dialog',
  imports: [FormsModule, TPipe, Dialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sprint-dialog.html',
  styleUrl: './sprint-dialog.css',
})
export class SprintDialog {
  private readonly store = inject(Store);
  private readonly ws = inject(Workspace);
  private readonly perm = inject(Permissions);
  private readonly sprints = inject(Sprints);
  protected readonly dlg = viewChild.required<Dialog>('dlg');
  readonly saved = output<number>();
  protected readonly states = SPRINT_STATES;
  protected draft: SprintDraft = blank(0);
  protected readonly projects = computed(() => this.ws.visibleProjects().filter((p) => this.perm.can('manageSprints', p.id)));

  protected invalidDates() {
    return !this.draft.start || !this.draft.end || this.draft.end < this.draft.start;
  }

  open(sprint?: Sprint, projectId?: number) {
    if (sprint) this.draft = { ...sprint };
    else {
      const pid = projectId ?? this.ws.projectId() ?? this.projects()[0]?.id ?? 0;
      const n = this.store.sprints().filter((s) => s.projectId === pid).length + 1;
      this.draft = { ...blank(pid), name: `Sprint ${n}` };
    }
    this.dlg().open();
  }

  protected save() {
    if (this.invalidDates()) return;
    const id = this.sprints.save({ ...this.draft, name: this.draft.name.trim(), capacity: Number(this.draft.capacity) || 0 });
    this.dlg().close();
    this.saved.emit(id);
  }
}

function blank(projectId: number): SprintDraft {
  const today = new Date();
  const end = new Date(today.getTime() + 13 * 86_400_000);
  return {
    projectId, name: '', goal: '', start: today.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), state: 'planned', capacity: 20,
  };
}
