/**
 * Pattern matching for ignore rules.
 *
 * Patterns are matched against basenames (not full paths).
 * Supports three conventions:
 *
 *   "node_modules"  → exact match (backward-compatible)
 *   "temp*"         → starts with "temp"
 *   "*cache"        → ends with "cache"
 *   "*temp*"        → contains "temp"
 *
 * All matching is case-insensitive.
 */

/**
 * Test whether a basename matches a single pattern.
 */
export function matchesPattern(basename: string, pattern: string): boolean {
  const name = basename.toLowerCase();
  const pat = pattern.toLowerCase();

  if (!pat.includes('*')) {
    return name === pat;
  }

  const startsWithStar = pat.startsWith('*');
  const endsWithStar = pat.endsWith('*');

  if (startsWithStar && endsWithStar && pat.length > 2) {
    // *text* → contains
    return name.includes(pat.slice(1, -1));
  }
  if (startsWithStar) {
    // *text → endsWith
    return name.endsWith(pat.slice(1));
  }
  if (endsWithStar) {
    // text* → startsWith
    return name.startsWith(pat.slice(0, -1));
  }

  // Fallback: exact match
  return name === pat;
}

/**
 * Test whether a basename matches any pattern in a list.
 */
export function matchesAnyPattern(basename: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(basename, pattern));
}
