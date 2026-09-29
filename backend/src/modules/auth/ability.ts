import type { AccessLevel, Action, Status, ViewState, WorkflowConfig } from '../../shared/models';

/**
 * The authorization rules, as pure functions over plain data.
 *
 * A direct port of frontend/src/app/core/permissions.service.ts. Two details there are easy
 * to lose in translation and are preserved exactly:
 *
 *  - a project membership REPLACES the global level (it can lower it, not just raise it),
 *    except for administrators, whom no membership can demote;
 *  - the project/issue visibility overrides compare the GLOBAL level against 70, not the
 *    project-effective level from levelIn().
 *
 * Structural parameter types so both a seeded `Project` from shared/models and a row loaded
 * out of MariaDB satisfy them without adapters.
 */

export interface ActorLike {
  id: number;
  accessLevel: AccessLevel;
}

export interface MemberLike {
  userId: number;
  accessLevel: AccessLevel;
}

export interface ProjectLike {
  id: number;
  viewState: ViewState;
  enabled: boolean;
  members: readonly MemberLike[];
}

export interface IssueLike {
  projectId: number;
  viewState: ViewState;
  reporterId: number;
  handlerId: number | null;
}

export interface NoteLike {
  authorId: number;
  private: boolean;
}

export interface AttachmentLike {
  uploaderId: number;
}

/** The level at which a user acts inside one project. */
export function levelIn(user: ActorLike, project: ProjectLike | undefined): AccessLevel {
  // Administrators keep global rights; otherwise a project membership overrides the global level.
  if (user.accessLevel === 90) return 90;
  return project?.members.find((m) => m.userId === user.id)?.accessLevel ?? user.accessLevel;
}

/**
 * `project` being undefined means "no project context", which falls back to the global level.
 * Note the frontend passes `projectId ? map.get(projectId) : undefined`, so a falsy project id
 * (0, null) is treated as no context rather than as a missing project.
 */
export function can(
  user: ActorLike | null,
  action: Action,
  project: ProjectLike | undefined,
  wf: WorkflowConfig,
): boolean {
  // An unauthenticated caller acts as a viewer (10), not as denied-by-default. That still
  // fails every threshold above `view`, but it keeps the comparison uniform.
  const level = user ? levelIn(user, project) : 10;
  return level >= wf.thresholds[action];
}

export function canSeeProject(user: ActorLike | null, project: ProjectLike): boolean {
  // Precedence matters: `!enabled && accessLevel < 70` binds tighter than the `||` below, so
  // a disabled project is visible only to managers and above.
  if (!user || (!project.enabled && user.accessLevel < 70)) return false;
  return (
    project.viewState === 'public' ||
    user.accessLevel >= 70 ||
    project.members.some((m) => m.userId === user.id)
  );
}

export function canSeeIssue(
  user: ActorLike | null,
  issue: IssueLike,
  project: ProjectLike | undefined,
  wf: WorkflowConfig,
): boolean {
  if (!user || !project || !canSeeProject(user, project)) return false;
  return (
    issue.viewState === 'public' ||
    issue.reporterId === user.id ||
    issue.handlerId === user.id ||
    can(user, 'viewPrivate', project, wf)
  );
}

export function canSeeNote(
  user: ActorLike | null,
  note: NoteLike,
  project: ProjectLike | undefined,
  wf: WorkflowConfig,
): boolean {
  if (!note.private) return true;
  if (!user) return false;
  return note.authorId === user.id || can(user, 'viewPrivate', project, wf);
}

export function canEditNote(
  user: ActorLike | null,
  note: NoteLike,
  project: ProjectLike | undefined,
  wf: WorkflowConfig,
): boolean {
  if (!user) return false;
  return note.authorId === user.id || can(user, 'editOthersNotes', project, wf);
}

/** The reporter may edit their own issue with only `report`, not the full `update` threshold. */
export function canEditIssue(
  user: ActorLike | null,
  issue: IssueLike,
  project: ProjectLike | undefined,
  wf: WorkflowConfig,
): boolean {
  if (!user) return false;
  return (
    can(user, 'update', project, wf) ||
    (issue.reporterId === user.id && can(user, 'report', project, wf))
  );
}

export function canDeleteAttachment(
  user: ActorLike | null,
  attachment: AttachmentLike,
  project: ProjectLike | undefined,
  wf: WorkflowConfig,
): boolean {
  if (!user) return false;
  return attachment.uploaderId === user.id || can(user, 'deleteOthersFiles', project, wf);
}

/**
 * Whether the actor may monitor somebody else's issue on their behalf.
 * Evaluated WITHOUT a project, matching setMonitor's `can("monitorOthers")` call — so a
 * project membership cannot grant it.
 */
export function canMonitorFor(
  user: ActorLike | null,
  targetUserId: number,
  wf: WorkflowConfig,
): boolean {
  if (!user) return false;
  return targetUserId === user.id || can(user, 'monitorOthers', undefined, wf);
}

/** Convenience for the status-transition rules, which need the reporter identity. */
export const isReporter = (user: ActorLike | null, issue: { reporterId: number }): boolean =>
  !!user && issue.reporterId === user.id;

export type { Status };
