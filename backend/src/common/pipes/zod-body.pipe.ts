import { type ArgumentMetadata, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { ValidationError } from '../errors/domain-error';

/**
 * Validates a body against a Zod schema.
 *
 * class-validator covers the ordinary flat DTOs, but a few payloads are nested records keyed
 * by enum values — the workflow's `transitions: Record<Status, Status[]>` and its 22-entry
 * `thresholds` map — which decorators express badly and Zod expresses exactly. Used only where
 * that is the case, not as a second parallel validation stack.
 */
@Injectable()
export class ZodBodyPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, metadata: ArgumentMetadata): T {
    if (metadata.type !== 'body') return value as T;
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const detail = result.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new ValidationError('errors.validation', detail);
    }
    return result.data;
  }
}
