import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store } from '../../core/store.service';
import { Workspace } from '../../core/workspace.service';
import { isResolved } from '../../core/config';
import { groupBy } from '../../core/issue-filter';
import type { Issue } from '../../core/models';
import { FmtDatePipe, TPipe } from '../../i18n/i18n.service';
import { Icon } from '../../shared/icon/icon';
import { Empty, StatusBadge, UserChip } from '../../shared/ui';

/** Roadmap: unreleased versions and active/planned sprints with progress. */
@Component({
  selector: 'app-roadmap',
  imports: [RouterLink, TPipe, FmtDatePipe, Icon, Empty, StatusBadge, UserChip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './roadmap.html',
  styleUrl: './roadmap.css',
})
export class Roadmap {
  protected readonly store = inject(Store);
  private readonly ws = inject(Workspace);
  readonly project = input<string>();

  protected readonly groups = computed(() => {
    const issues = this.ws.visibleIssues();
    return this.ws.projectsInScope(this.project()).map((project) => {
      const mine = issues.filter((i) => i.projectId === project.id);
      const byVersion = groupBy(mine, (i) => i.targetVersion);
      const versions = project.versions.filter((v) => !v.released && !v.obsolete).map((v) => {
        const list = byVersion.get(v.name) ?? [];
        return { kind: 'version', id: 0, name: v.name, date: v.date, description: v.description, issues: sortRoadmap(list), done: list.filter((i) => isResolved(i.status)).length };
      });
      const sprints = this.store.sprints().filter((s) => s.projectId === project.id && s.state !== 'closed').map((s) => {
        const list = mine.filter((i) => i.sprintId === s.id);
        return { kind: 'sprint', id: s.id, name: s.name, date: s.end, description: s.goal, issues: sortRoadmap(list), done: list.filter((i) => isResolved(i.status)).length };
      });
      return { project, versions: [...versions, ...sprints] };
    });
  });

  protected resolved(i: Issue) {
    return isResolved(i.status);
  }
}

function sortRoadmap(list: Issue[]) {
  return [...list].sort((a, b) => Number(isResolved(a.status)) - Number(isResolved(b.status)) || a.category.localeCompare(b.category) || a.id - b.id);
}
