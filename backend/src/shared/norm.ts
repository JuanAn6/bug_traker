/**
 * Text normalization used for every accent-insensitive comparison.
 *
 * This is the `norm()` that issue-filter.ts defines privately (it is not exported there,
 * which is the only reason this file is hand-written rather than copied). Two callers must
 * agree on it byte for byte:
 *
 *   - the writer that fills `issues.searchNorm` / `comments.bodyNorm`
 *   - the query builder that normalizes the incoming search text
 *
 * Storing the normalized form rather than relying on the `utf8mb4_unicode_ci` collation
 * makes accent-insensitivity a property of the data instead of a hope about how InnoDB's
 * FULLTEXT tokenizer treats diacritics.
 *
 * norm.spec.ts extracts the regex literal out of the copied filter-semantics.ts and
 * asserts this implementation still matches it.
 */
export const norm = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Splits a query into the words that must ALL appear (the frontend's AND-of-words). */
export const searchWords = (text: string): string[] => {
  const t = norm(text).trim();
  return t ? t.split(/\s+/) : [];
};

/**
 * `#123` and `KEY-123` short-circuit the text filter to an exact id lookup.
 * Mirrors issue-filter.ts exactly, including the quirk that the project key is *not*
 * validated against the issue's project (searching `MOB-2` finds issue 2 even in WEB).
 */
export const issueIdShortcut = (text: string): number | null => {
  const t = norm(text).trim();
  const m = /^#?(\d+)$/.exec(t) ?? /^[a-z]+-(\d+)$/.exec(t);
  return m?.[1] ? Number(m[1]) : null;
};
