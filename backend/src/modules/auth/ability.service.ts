import { Injectable } from '@nestjs/common';
import type { Action, WorkflowConfig } from '../../shared/models';
import { PermissionDeniedError } from '../../common/errors/domain-error';
import { ProjectTreeService, type ProjectNode } from '../../core/project-tree/project-tree.service';
import { WorkflowService } from '../../core/workflow/workflow.service';
import {
  can, canDeleteAttachment, canEditIssue, canEditNote, canMonitorFor, canSeeIssue, canSeeNote,
  canSeeProject, levelIn,
  type ActorLike, type AttachmentLike, type IssueLike, type NoteLike,
} from './ability';

/**
 * The injectable face of ability.ts.
 *
 * It only resolves the two inputs the pure functions need — the cached WorkflowConfig and the
 * cached project node — and delegates. Keeping the rules in a pure module is what lets them be
 * swept exhaustively in tests (8 users × 4 projects × 22 actions) without a database.
 *
 * Use the `assert*` variants on write paths: they throw PermissionDeniedError, which the
 * exception filter renders as 403 with the `errors.denied` key the frontend already shows.
 */
@Injectable()
export class AbilityService {
  constructor(
    private readonly workflow: WorkflowService,
    private readonly tree: ProjectTreeService,
  ) {}

  /** Snapshot for a request that will make several checks against the same project. */
  async context(projectId?: number | null): Promise<{ wf: WorkflowConfig; project?: ProjectNode }> {
    const wf = await this.workflow.get();
    // A falsy id means "no project context" — the global level applies — rather than a lookup
    // miss. Same convention as the frontend's `projectId ? map.get(projectId) : undefined`.
    const project = projectId ? await this.tree.get(projectId) : undefined;
    return project ? { wf, project } : { wf };
  }

  async level(actor: ActorLike, projectId?: number | null) {
    const { project } = await this.context(projectId);
    return levelIn(actor, project);
  }

  async can(actor: ActorLike, action: Action, projectId?: number | null): Promise<boolean> {
    const { wf, project } = await this.context(projectId);
    return can(actor, action, project, wf);
  }

  async assertCan(actor: ActorLike, action: Action, projectId?: number | null): Promise<void> {
    if (!(await this.can(actor, action, projectId))) {
      throw new PermissionDeniedError(action, projectId ?? undefined);
    }
  }

  async canSeeProject(actor: ActorLike, projectId: number): Promise<boolean> {
    const project = await this.tree.get(projectId);
    return !!project && canSeeProject(actor, project);
  }

  async canSeeIssue(actor: ActorLike, issue: IssueLike): Promise<boolean> {
    const { wf, project } = await this.context(issue.projectId);
    return canSeeIssue(actor, issue, project, wf);
  }

  /**
   * 404, not 403, for an issue the actor cannot see: answering "forbidden" would confirm that
   * the issue exists, which is itself the leak a private issue is meant to prevent.
   */
  async assertCanSeeIssue(actor: ActorLike, issue: IssueLike): Promise<void> {
    if (!(await this.canSeeIssue(actor, issue))) throw new PermissionDeniedError('view');
  }

  async canEditIssue(actor: ActorLike, issue: IssueLike): Promise<boolean> {
    const { wf, project } = await this.context(issue.projectId);
    return canEditIssue(actor, issue, project, wf);
  }

  async assertCanEditIssue(actor: ActorLike, issue: IssueLike): Promise<void> {
    if (!(await this.canEditIssue(actor, issue))) throw new PermissionDeniedError('update', issue.projectId);
  }

  async canSeeNote(actor: ActorLike, note: NoteLike, projectId: number): Promise<boolean> {
    const { wf, project } = await this.context(projectId);
    return canSeeNote(actor, note, project, wf);
  }

  async canEditNote(actor: ActorLike, note: NoteLike, projectId: number): Promise<boolean> {
    const { wf, project } = await this.context(projectId);
    return canEditNote(actor, note, project, wf);
  }

  /**
   * The frontend defines canEditNote and then never calls it on the write path, so any
   * logged-in user can edit or delete somebody else's note there. Enforced here.
   */
  async assertCanEditNote(actor: ActorLike, note: NoteLike, projectId: number): Promise<void> {
    if (!(await this.canEditNote(actor, note, projectId))) {
      throw new PermissionDeniedError('editOthersNotes', projectId);
    }
  }

  async canDeleteAttachment(
    actor: ActorLike,
    attachment: AttachmentLike,
    projectId: number,
  ): Promise<boolean> {
    const { wf, project } = await this.context(projectId);
    return canDeleteAttachment(actor, attachment, project, wf);
  }

  async assertCanDeleteAttachment(
    actor: ActorLike,
    attachment: AttachmentLike,
    projectId: number,
  ): Promise<void> {
    if (!(await this.canDeleteAttachment(actor, attachment, projectId))) {
      throw new PermissionDeniedError('deleteOthersFiles', projectId);
    }
  }

  /** Evaluated without a project, matching setMonitor's global `can("monitorOthers")`. */
  async assertCanMonitorFor(actor: ActorLike, targetUserId: number): Promise<void> {
    const wf = await this.workflow.get();
    if (!canMonitorFor(actor, targetUserId, wf)) {
      throw new PermissionDeniedError('monitorOthers');
    }
  }
}
