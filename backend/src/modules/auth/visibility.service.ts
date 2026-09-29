import { Inject, Injectable } from '@nestjs/common';
import type { WorkflowConfig } from '../../shared/models';
import { CACHE_PORT, type CachePort } from '../../core/ports/cache.port';
import { ProjectTreeService } from '../../core/project-tree/project-tree.service';
import { WorkflowService } from '../../core/workflow/workflow.service';
import type { VisibilityScope } from '../issues/issue-query.builder';
import { can, canSeeProject, type ActorLike } from './ability';

const TTL_MS = 30_000;

/**
 * Turns the per-entity visibility predicates into the two id sets the query layer needs.
 *
 * This exists because of the single most dangerous difference between the frontend and an
 * API: in the browser, visibility is applied in Workspace.visibleIssues() — OUTSIDE
 * filterIssues(). A backend that only translated the filter would return private issues to
 * anyone who asked. The scope computed here is ANDed into every issue query, before
 * pagination, so a page is never silently short.
 */
@Injectable()
export class VisibilityService {
  constructor(
    private readonly tree: ProjectTreeService,
    private readonly workflow: WorkflowService,
    @Inject(CACHE_PORT) private readonly cache: CachePort,
  ) {}

  async scope(actor: ActorLike): Promise<VisibilityScope> {
    const wf = await this.workflow.get();
    // The key carries everything the answer depends on, so an admin editing the viewPrivate
    // threshold or a membership change cannot leave a stale scope behind: WorkflowService and
    // ProjectTreeService both drop the `scope:` prefix on invalidate().
    const key = `scope:${actor.id}:${actor.accessLevel}`;
    const cached = await this.cache.get<VisibilityScope>(key);
    if (cached) return cached;

    const computed = await this.compute(actor, wf);
    await this.cache.set(key, computed, TTL_MS);
    return computed;
  }

  private async compute(actor: ActorLike, wf: WorkflowConfig): Promise<VisibilityScope> {
    const projects = await this.tree.all();
    const visibleProjectIds: number[] = [];
    const privateIssueProjectIds: number[] = [];

    for (const p of projects) {
      if (!canSeeProject(actor, p)) continue;
      visibleProjectIds.push(p.id);
      // Where this actor may read private issues — evaluated per project, because a
      // membership can raise them above the threshold in one project and not another.
      if (can(actor, 'viewPrivate', p, wf)) privateIssueProjectIds.push(p.id);
    }

    return { visibleProjectIds, privateIssueProjectIds, isAdmin: actor.accessLevel === 90 };
  }
}
