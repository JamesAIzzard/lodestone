// ── Fuzzy string matching utilities ──────────────────────────────────────────

export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Best fuzzy score of query against a name (lower = better match). */
export function fuzzyScore(query: string, name: string): number {
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  if (n.includes(q)) return 0; // substring match is best
  let best = Infinity;
  // Compare against name prefixes of varying lengths (handles typos + missed/extra chars)
  for (let len = Math.max(1, q.length - 1); len <= Math.min(n.length, q.length + 2); len++) {
    best = Math.min(best, levenshtein(q, n.slice(0, len)));
  }
  // Also compare against each word in compound names (e.g. "cellular-origins")
  for (const word of n.split(/[\s\-_]+/)) {
    if (word.length < 2) continue;
    for (let len = Math.max(1, q.length - 1); len <= Math.min(word.length, q.length + 2); len++) {
      best = Math.min(best, levenshtein(q, word.slice(0, len)));
    }
  }
  return best;
}
