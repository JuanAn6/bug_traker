import {
  type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { DomainError } from '../errors/domain-error';

interface ErrorBody {
  statusCode: number;
  /** An i18n key the frontend already owns, e.g. 'errors.transition'. */
  code: string;
  message: string;
  params?: Record<string, string | number>;
}

/**
 * Renders every error as { statusCode, code, params } so the client can translate it.
 *
 * The `code` is the contract, not `message`: the frontend has these keys in en.ts and es.ts
 * already, and shipping English prose would force it to pattern-match on sentences.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const body = this.toBody(exception);

    // 5xx is our bug and needs the stack; 4xx is the client being told no, and logging those
    // at error level would bury the real failures.
    if (body.statusCode >= 500) {
      this.logger.error(
        exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
      );
    } else {
      this.logger.debug(`${body.statusCode} ${body.code}`);
    }

    void reply.status(body.statusCode).send(body);
  }

  private toBody(exception: unknown): ErrorBody {
    if (exception instanceof DomainError) {
      return {
        statusCode: exception.status,
        code: exception.code,
        message: exception.message,
        ...(exception.params ? { params: exception.params } : {}),
      };
    }

    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      const status = exception.getStatus();
      if (typeof response === 'string') {
        // UnauthorizedException('login.invalid') and friends pass the key as the message.
        return { statusCode: status, code: response, message: response };
      }
      const record = response as { message?: unknown; code?: unknown };
      const message = Array.isArray(record.message)
        ? record.message.join('; ')
        : String(record.message ?? exception.message);
      return {
        statusCode: status,
        code: typeof record.code === 'string' ? record.code : this.codeForStatus(status),
        message,
      };
    }

    const driver = this.fromDriver(exception);
    if (driver) return driver;

    return { statusCode: 500, code: 'errors.internal', message: 'Internal server error' };
  }

  /**
   * Maps the MariaDB errors the schema is designed to raise.
   *
   * ER_DUP_ENTRY on issueRelationships is not a failure mode to avoid — the composite primary
   * key IS how "at most one relationship per issue pair" is enforced, so this translation is
   * part of the design.
   */
  private fromDriver(exception: unknown): ErrorBody | null {
    const e = exception as { code?: string; errno?: number; sqlMessage?: string };
    if (typeof e?.code !== 'string') return null;

    switch (e.code) {
      case 'ER_DUP_ENTRY':
        return {
          statusCode: 409,
          code: e.sqlMessage?.includes('issueRelationships')
            ? 'errors.relationExists'
            : 'errors.duplicate',
          message: 'Already exists',
        };
      case 'ER_NO_REFERENCED_ROW':
      case 'ER_NO_REFERENCED_ROW_2':
        return { statusCode: 409, code: 'errors.referenceMissing', message: 'Referenced row does not exist' };
      case 'ER_ROW_IS_REFERENCED':
      case 'ER_ROW_IS_REFERENCED_2':
        return { statusCode: 409, code: 'errors.stillReferenced', message: 'Row is still referenced' };
      case 'ER_CONSTRAINT_FAILED':
        // The chk_rel_no_self CHECK: a self-relationship.
        return { statusCode: 422, code: 'errors.selfRelation', message: 'Constraint failed' };
      case 'ER_LOCK_DEADLOCK':
        return { statusCode: 409, code: 'errors.retry', message: 'Deadlock; retry the request' };
      case 'ER_LOCK_WAIT_TIMEOUT':
        return { statusCode: 409, code: 'errors.busy', message: 'Lock wait timeout' };
      default:
        return null;
    }
  }

  private codeForStatus(status: number): string {
    if (status === 401) return 'login.invalid';
    if (status === 403) return 'errors.denied';
    if (status === 404) return 'errors.notFound';
    if (status === 422) return 'errors.validation';
    return 'errors.internal';
  }
}
