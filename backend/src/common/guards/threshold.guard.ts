import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import { PermissionDeniedError } from '../errors/domain-error';
import { REQUIRES, type RequiresMetadata } from '../decorators/requires.decorator';
import type { RequestWithUser } from '../decorators/current-user.decorator';
import { DRIZZLE, type Db } from '../../core/database/drizzle.service';
import * as s from '../../core/database/schema';
import { ProjectTreeService } from '../../core/project-tree/project-tree.service';
import { WorkflowService } from '../../core/workflow/workflow.service';
import { can } from '../../modules/auth/ability';

interface ScopedRequest extends RequestWithUser {
  body?: Record<string, unknown>;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
}

/**
 * Enforces `@Requires(action)` against the RUNTIME workflow thresholds.
 *
 * Reading them from the cached WorkflowConfig rather than from a constant is the whole point:
 * authorization here is data an administrator edits at /admin/workflow, and raising a
 * threshold has to take effect on the next request.
 */
@Injectable()
export class ThresholdGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly workflow: WorkflowService,
    private readonly tree: ProjectTreeService,
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<RequiresMetadata | undefined>(REQUIRES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!meta) return true;

    const request = context.switchToHttp().getRequest<ScopedRequest>();
    const user = request.authUser;
    if (!user) throw new PermissionDeniedError(meta.action);

    const projectId = await this.resolveProjectId(request, meta);
    // An unresolvable project means no project context, which falls back to the global level —
    // matching the frontend, where `projectId ? map.get(projectId) : undefined` treats a falsy
    // id as "no project" rather than as a missing one.
    const project = projectId ? await this.tree.get(projectId) : undefined;

    const wf = await this.workflow.get();
    if (!can(user, meta.action, project, wf)) {
      throw new PermissionDeniedError(meta.action, projectId ?? undefined);
    }
    return true;
  }

  private async resolveProjectId(
    request: ScopedRequest,
    meta: RequiresMetadata,
  ): Promise<number | null> {
    if (!meta.projectFrom) return null;

    const [source, key] = meta.projectFrom.split('.');
    const bag =
      source === 'body' ? request.body : source === 'param' ? request.params : request.query;
    const raw = key ? bag?.[key] : undefined;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) return null;

    switch (meta.resolver) {
      case 'issue':
        return this.issueProject(id);
      case 'sprint':
        return this.sprintProject(id);
      case 'note':
        return this.noteProject(id);
      case 'attachment':
        return this.attachmentProject(id);
      case 'project':
      default:
        return id;
    }
  }


  private async issueProject(issueId: number): Promise<number | null> {
    const rows = await this.db
      .select({ projectId: s.issues.projectId })
      .from(s.issues)
      .where(eq(s.issues.id, issueId))
      .limit(1);
    return rows[0]?.projectId ?? null;
  }

  private async sprintProject(sprintId: number): Promise<number | null> {
    const rows = await this.db
      .select({ projectId: s.sprints.projectId })
      .from(s.sprints)
      .where(eq(s.sprints.id, sprintId))
      .limit(1);
    return rows[0]?.projectId ?? null;
  }

  private async noteProject(noteId: number): Promise<number | null> {
    const rows = await this.db
      .select({ projectId: s.issues.projectId })
      .from(s.comments)
      .innerJoin(s.issues, eq(s.issues.id, s.comments.issueId))
      .where(eq(s.comments.id, noteId))
      .limit(1);
    return rows[0]?.projectId ?? null;
  }

  private async attachmentProject(attachmentId: number): Promise<number | null> {
    const rows = await this.db
      .select({ projectId: s.issues.projectId })
      .from(s.attachments)
      .innerJoin(s.issues, eq(s.issues.id, s.attachments.issueId))
      .where(eq(s.attachments.id, attachmentId))
      .limit(1);
    return rows[0]?.projectId ?? null;
  }
}
