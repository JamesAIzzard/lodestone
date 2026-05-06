/**
 * Shared tokeniser for BM25 indexing and query-time scoring.
 *
 * Used at both index time (to populate the inverted index) and query time
 * (to tokenise the search query before BM25 scoring).
 *
 * Design decisions:
 *   - Lowercase, split on non-alphanumeric boundaries
 *   - No stemming (preserves exact matches for code identifiers)
 *   - Handles camelCase and snake_case by splitting on boundaries
 */

/**
 * Tokenise a text string into lowercase alphanumeric tokens.
 *
 * Splits on any non-alphanumeric character sequence, producing tokens
 * suitable for BM25 indexing. camelCase words like "getFileCount" become
 * ["getfilecount"] — we don't split on case boundaries to keep code
 * identifiers intact as single tokens.
 *
 * @returns Array of lowercase tokens (may contain duplicates).
 */
export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}
