import type { Issue, RichText } from '../../../shared/models';
import { norm } from '../../../shared/norm';
import { plainText } from '../../../shared/rich';

/**
 * Builds `issues.searchNorm`.
 *
 * The haystack has to be byte-identical to the one issue-filter.ts assembles
 * (issue-filter.ts:79-82) or the SQL search and the UI search will disagree: summary, the
 * plain text of the three rich fields, then the tags. Note text is NOT included — it lives
 * in comments.bodyNorm behind a visibility predicate, because a private note must not be
 * searchable by someone who cannot read it.
 */
export const issueSearchNorm = (
  i: Pick<Issue, 'summary' | 'description' | 'stepsToReproduce' | 'additionalInfo'> & { tags: string[] },
): string =>
  norm(
    [
      i.summary,
      plainText(i.description as RichText),
      plainText(i.stepsToReproduce as RichText),
      plainText(i.additionalInfo as RichText),
      i.tags.join(' '),
    ].join(' '),
  );

/** Builds `comments.bodyNorm`. */
export const commentSearchNorm = (body: RichText): string => norm(plainText(body));

/** `issues.tagsSorted` — insertion order preserved, which is what `ORDER BY tags` compares. */
export const tagsSorted = (tags: string[]): string => tags.join(',').slice(0, 255);
