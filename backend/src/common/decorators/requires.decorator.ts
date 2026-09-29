import { SetMetadata } from '@nestjs/common';
import type { Action } from '../../shared/models';

export const REQUIRES = 'auth:requires';

/** Where in the request the project id lives, so the guard can scope the threshold check. */
export interface RequiresOptions {
  /**
   * A dotted path: 'body.projectId', 'param.id', 'query.projectId'. Omit for a global check
   * against the user's own access level, which is what the frontend's route guards do.
   */
  projectFrom?: string;
  /**
   * How to turn the located id into a project id, when it is not one already. The guard
   * resolves these with a single indexed select.
   */
  resolver?: 'project' | 'issue' | 'sprint' | 'note' | 'attachment';
}

export interface RequiresMetadata extends RequiresOptions {
  action: Action;
}

/**
 * The coarse, route-level permission gate.
 *
 * It is a filter, not the whole check: anything that depends on the row itself — canEditIssue's
 * "or you are the reporter", canSeeNote, canDeleteAttachment — is re-asserted in the service,
 * because the guard cannot know an issue's project or its reporter before loading it.
 */
export const Requires = (action: Action, options: RequiresOptions = {}) =>
  SetMetadata(REQUIRES, { action, ...options } satisfies RequiresMetadata);
