import { type ArgumentMetadata, Injectable, type PipeTransform } from '@nestjs/common';

/**
 * Removes keys whose value is `undefined` from a request body.
 *
 * This is not cosmetic. class-transformer's `plainToInstance` materializes EVERY property
 * declared on a DTO class, so a DTO with twenty optional fields always arrives with twenty own
 * keys — nineteen of them `undefined`. For a PATCH that is catastrophic: applyPatch computes
 * `next = { ...issue, ...patch }` and then diffs field by field, so `category: undefined`
 * overwrites a real category with nothing and logs it as a change. A bulk patch of `priority`
 * was silently clearing `category` and `severity`.
 *
 * `transformOptions.exposeUnsetFields` does NOT prevent this — it applies to
 * `instanceToPlain`, the other direction — so the stripping has to be explicit. Doing it
 * globally means no endpoint can forget it, which is exactly how the bug got in.
 */
@Injectable()
export class StripUndefinedPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'body' || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value;

    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      // `null` is kept: it is a meaningful value here (unassign, clear the sprint, no due date).
      // Only `undefined` — "this field was not sent" — is dropped.
      if (source[key] !== undefined) out[key] = source[key];
    }
    // Class instances keep their prototype so any later reflection still works.
    return Object.assign(Object.create(Object.getPrototypeOf(source) as object), out);
  }
}
