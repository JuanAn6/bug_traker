import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store } from '../../core/store.service';
import { Workspace } from '../../core/workspace.service';
import { isResolved } from '../../core/config';
import { groupBy } from '../../core/issue-filter';
import { FmtDatePipe, TPipe } from '../../i18n/i18n.service';
import { Icon } from '../../shared/icon/icon';
import { Empty } from '../../shared/ui';

/** Change log: released versions with the issues fixed in them, grouped by category. */
@Component({
  selector: 'app-changelog',
  imports: [RouterLink, TPipe, FmtDatePipe, Icon, Empty],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './changelog.html',
  styleUrl: './changelog.css',
})
export class Changelog {
  protected readonly store = inject(Store);
  private readonly ws = inject(Workspace);
  readonly project = input<string>();

  protected readonly groups = computed(() => {
    const issues = this.ws.visibleIssues();
    return this.ws.projectsInScope(this.project()).map((project) => ({
      project,
      versions: project.versions.filter((v) => v.released).reverse().map((v) => {
        const fixed = issues.filter((i) => i.projectId === project.id && i.fixedInVersion === v.name && isResolved(i.status));
        const byCat = groupBy(fixed, (i) => i.category);
        return { ...v, total: fixed.length, categories: [...byCat].sort((a, b) => a[0].localeCompare(b[0])).map(([name, list]) => ({ name, issues: list })) };
      }),
    }));
  });
}
