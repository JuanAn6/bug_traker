import { describe, expect, it } from 'vitest';
import type { ArgumentMetadata } from '@nestjs/common';
import { StripUndefinedPipe } from '../../src/common/pipes/strip-undefined.pipe';

/**
 * Regression guard for a data-corruption bug.
 *
 * class-transformer materializes every property declared on a DTO class, so a PATCH of one
 * field arrives with all the others set to undefined. applyPatch then computes
 * `{ ...issue, ...patch }` and diffs, so `category: undefined` overwrote a real category with
 * nothing AND logged it as a change. A bulk patch of `priority` was silently clearing
 * `category` and `severity` on every issue in the selection.
 *
 * `transformOptions.exposeUnsetFields: false` does not help — it governs instanceToPlain, the
 * other direction.
 */
describe('StripUndefinedPipe', () => {
  const pipe = new StripUndefinedPipe();
  const body: ArgumentMetadata = { type: 'body' };

  it('drops undefined keys', () => {
    const result = pipe.transform(
      { priority: 'urgent', category: undefined, severity: undefined },
      body,
    ) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(['priority']);
  });

  it('keeps null, which is a meaningful value here', () => {
    // null means unassign / clear the sprint / no due date — very different from "not sent".
    const result = pipe.transform({ handlerId: null, sprintId: null }, body) as Record<string, unknown>;
    expect(result).toEqual({ handlerId: null, sprintId: null });
  });

  it('keeps falsy values that are not undefined', () => {
    const result = pipe.transform({ sticky: false, storyPoints: 0, summary: '' }, body);
    expect(result).toEqual({ sticky: false, storyPoints: 0, summary: '' });
  });

  it('preserves the prototype so later reflection still works', () => {
    // `| undefined` spelled out because exactOptionalPropertyTypes forbids assigning undefined
    // to a plain optional — which is precisely the shape class-transformer produces.
    class Dto {
      a?: string | undefined;
      b?: string | undefined;
    }
    const instance = new Dto();
    instance.a = 'kept';
    instance.b = undefined;
    const result = pipe.transform(instance, body);
    expect(result).toBeInstanceOf(Dto);
    expect(Object.keys(result as object)).toEqual(['a']);
  });

  it('leaves everything that is not a body alone', () => {
    const value = { a: undefined };
    expect(pipe.transform(value, { type: 'query' })).toBe(value);
    expect(pipe.transform(value, { type: 'param' })).toBe(value);
  });

  it('passes through arrays, primitives and null', () => {
    const array = [{ a: undefined }];
    expect(pipe.transform(array, body)).toBe(array);
    expect(pipe.transform('text', body)).toBe('text');
    expect(pipe.transform(null, body)).toBeNull();
  });
});
