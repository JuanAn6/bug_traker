/**
 * Domain errors carry an i18n key, not a sentence.
 *
 * The frontend already has these keys (`errors.denied`, `errors.transition`, …) and renders
 * them in the user's own language, so the API must not ship English prose that the client
 * would then have to pattern-match. DomainExceptionFilter maps each class to its status.
 */
export abstract class DomainError extends Error {
  abstract readonly status: number;
  abstract readonly code: string;
  params?: Record<string, string | number>;

  protected constructor(message: string, params?: Record<string, string | number>) {
    super(message);
    this.name = new.target.name;
    if (params) this.params = params;
  }
}

/** 403 — the actor's effective level is below the action's threshold. */
export class PermissionDeniedError extends DomainError {
  readonly status = 403;
  readonly code = 'errors.denied';
  constructor(action?: string, projectId?: number) {
    super(
      action ? `Denied: ${action}${projectId ? ` on project ${projectId}` : ''}` : 'Denied',
      action ? { action } : undefined,
    );
  }
}

/**
 * 404 — and deliberately also what an invisible entity returns.
 * Answering 403 for a private issue would confirm it exists, which is itself a leak.
 */
export class NotFoundError extends DomainError {
  readonly status = 404;
  readonly code: string;
  constructor(entity: string, id?: number | string) {
    super(`${entity}${id === undefined ? '' : ` ${id}`} not found`);
    this.code = entity === 'issue' ? 'errors.issueNotFound' : 'errors.notFound';
    if (id !== undefined) this.params = { id };
  }
}

/** 409 — the request is well-formed but conflicts with the current state. */
export class ConflictError extends DomainError {
  readonly status = 409;
  constructor(readonly code: string, params?: Record<string, string | number>) {
    super(`Conflict: ${code}`, params);
  }
}

/** 409 — the workflow forbids this status change from where the issue currently is. */
export class TransitionNotAllowedError extends DomainError {
  readonly status = 409;
  readonly code = 'errors.transition';
  constructor(from: string, to: string) {
    super(`Transition ${from} -> ${to} is not allowed`, { from, to });
  }
}

/** 422 — the payload is structurally wrong in a way class-validator cannot express. */
export class ValidationError extends DomainError {
  readonly status = 422;
  constructor(readonly code: string, message: string, params?: Record<string, string | number>) {
    super(message, params);
  }
}
