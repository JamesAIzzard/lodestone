/**
 * Directory search — two-axis scoring for directory exploration.
 *
 * Axes:
 *   1. Segment Levenshtein — decompose path into segments, score each
 *      against query, take best. Finds directories by name.
 *   2. Token coverage — tokenise query and path, compute what fraction
 *      of query tokens appear in path tokens. Finds directories
 *      matching multi-word queries.
 *
 * Directory score = max(segment, keyword).
 *
 * Prefilter: trigram FTS5 on dirs_fts to narrow candidates before scoring.
 *
 * Empty query with no startPath is handled upstream in SiloManager, which
 * returns the silo's configured root directories directly. The broadQueryFallback
 * here is only reached for empty queries scoped to a startPath.
 */

import type { SiloDatabase } from './store';
import type { DirectoryTreeNode, DirectoryScoreSource } from '../shared/types';
import { levenshteinDistance } from './scorers/filename';
import { tokenise } from './tokeniser';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DirectorySearchParams {
  query?: string;
  startPath?: string;
  maxDepth?: number;
  maxResults?: number;
}

export interface SiloDirectorySearchResult {
  dirPath: string;
  dirName: string;
  score: number;
  scoreSource: DirectoryScoreSource;
  segmentScore: number;
  keywordScore: number;
  fileCount: number;
  subdirCount: number;
  depth: number;
  children: DirectoryTreeNode[];
}

// ── Scorers ──────────────────────────────────────────────────────────────────

/**
 * Score a directory path by comparing each path segment against the query
 * using normalised Levenshtein distance. Returns the best (highest) score.
 *
 * Example: query "chunkers", path "src/backend/chunkers/" → high score
 * on the "chunkers" segment.
 */
function scoreSegmentLevenshtein(queryLower: string, dirPath: string): number {
  const segments = dirPath.replace(/\/$/, '').split(/[/\\]/).filter((s) => s.length > 0);
  let best = 0;
  for (const seg of segments) {
    const segLower = seg.toLowerCase();
    const maxLen = Math.max(queryLower.length, segLower.length);
    if (maxLen === 0) continue;
    const dist = levenshteinDistance(queryLower, segLower);
    const sim = 1 - dist / maxLen;
    if (sim > best) best = sim;
  }
  return best;
}

/**
 * Score a directory path by token coverage — what fraction of query tokens
 * appear in the path (as exact matches or substring containment).
 *
 * Example: query "nutrient calculator", path "src/nutrients/calculator/" → 1.0
 * (both query tokens matched by path tokens).
 */
function scorePathTokenCoverage(queryTokens: string[], dirPath: string): number {
  if (queryTokens.length === 0) return 0;
  // Tokenise the path by splitting on separators, then into alphanumeric tokens
  const pathTokens = tokenise(dirPath.replace(/[/\\]/g, ' '));
  let matched = 0;
  for (const qt of queryTokens) {
    // Exact token match
    if (pathTokens.includes(qt)) {
      matched++;
      continue;
    }
    // Substring containment (either direction) — handles partial matches
    // like "chunk" matching "chunkers" or "test" matching "tests"
    let found = false;
    for (const pt of pathTokens) {
      if (pt.includes(qt) || qt.includes(pt)) {
        found = true;
        break;
      }
    }
    if (found) matched++;
  }
  return matched / queryTokens.length;
}

// ── Main Search Function ────────────────────────────────────────────────────

export function directorySearchSilo(
  db: SiloDatabase,
  params: DirectorySearchParams,
): SiloDirectorySearchResult[] {
  const {
    query,
    startPath,
    maxDepth = 2,
    maxResults = 20,
  } = params;

  const isEmptyQuery = !query || query.trim().length === 0;

  if (isEmptyQuery) {
    return broadQueryFallback(db, startPath, maxDepth, maxResults);
  }

  const candidateLimit = maxResults * 5;
  const queryLower = query.trim().toLowerCase();
  const queryTokens = tokenise(query);

  // ── Prefilter: trigram FTS5 + LIKE substring ──

  const candidateIds = new Set<number>();

  // Trigram prefilter
  const sanitised = sanitiseTrigramQuery(query);
  if (sanitised.length > 0) {
    try {
      const rows = db.prepare(`
        SELECT rowid FROM dirs_fts
        WHERE dirs_fts MATCH ?
        ORDER BY rank LIMIT ?
      `).all(sanitised, candidateLimit) as Array<{ rowid: number }>;
      for (const row of rows) candidateIds.add(row.rowid);
    } catch {
      // FTS5 error — skip
    }
  }

  // LIKE substring fallback
  const likePattern = `%${query.trim().replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
  try {
    const rows = db.prepare(`
      SELECT id FROM directories
      WHERE dir_path LIKE ? ESCAPE '\\'
      ORDER BY depth ASC, file_count DESC
      LIMIT ?
    `).all(likePattern, candidateLimit) as Array<{ id: number }>;
    for (const row of rows) candidateIds.add(row.id);
  } catch {
    // Skip on error
  }

  if (candidateIds.size === 0) return [];

  // ── Fetch candidate directories ──

  const idList = Array.from(candidateIds);
  const placeholders = idList.map(() => '?').join(',');
  const dirRows = db.prepare(`
    SELECT id, dir_path, dir_name, depth, file_count, subdir_count
    FROM directories
    WHERE id IN (${placeholders})
  `).all(...idList) as Array<{
    id: number; dir_path: string; dir_name: string;
    depth: number; file_count: number; subdir_count: number;
  }>;

  // ── Score candidates ──

  const scored: SiloDirectorySearchResult[] = [];

  for (const dir of dirRows) {
    if (startPath && !dir.dir_path.includes(startPath)) continue;

    const segmentScore = scoreSegmentLevenshtein(queryLower, dir.dir_path);
    const keywordScore = scorePathTokenCoverage(queryTokens, dir.dir_path);
    const score = Math.max(segmentScore, keywordScore);
    const scoreSource: DirectoryScoreSource = segmentScore >= keywordScore ? 'segment' : 'keyword';

    scored.push({
      dirPath: dir.dir_path,
      dirName: dir.dir_name,
      score,
      scoreSource,
      segmentScore,
      keywordScore,
      fileCount: dir.file_count,
      subdirCount: dir.subdir_count,
      depth: dir.depth,
      children: [], // filled below after sorting
    });
  }

  // Sort by score descending, overfetch for ancestor dedup
  scored.sort((a, b) => b.score - a.score);
  const topScored = scored.slice(0, maxResults * 4);

  // Expand trees for top results
  for (const result of topScored) {
    result.children = expandTree(db, result.dirPath, result.depth, maxDepth);
  }

  return deduplicateAncestors(topScored, maxDepth).slice(0, maxResults);
}

// ── Broad/Empty Query Fallback ──────────────────────────────────────────────

function broadQueryFallback(
  db: SiloDatabase,
  startPath: string | undefined,
  maxDepth: number,
  maxResults: number,
): SiloDirectorySearchResult[] {
  const fetchLimit = maxResults * 4;
  let rows;
  if (startPath) {
    rows = db.prepare(`
      SELECT id, dir_path, dir_name, depth, file_count, subdir_count
      FROM directories
      WHERE dir_path LIKE ? || '%'
      ORDER BY depth ASC, file_count DESC
      LIMIT ?
    `).all(startPath, fetchLimit);
  } else {
    rows = db.prepare(`
      SELECT id, dir_path, dir_name, depth, file_count, subdir_count
      FROM directories
      ORDER BY depth ASC, file_count DESC
      LIMIT ?
    `).all(fetchLimit);
  }

  const results = (rows as Array<{
    id: number; dir_path: string; dir_name: string;
    depth: number; file_count: number; subdir_count: number;
  }>).map((r) => ({
    dirPath: r.dir_path,
    dirName: r.dir_name,
    score: 1.0,
    scoreSource: 'segment' as DirectoryScoreSource,
    segmentScore: 0,
    keywordScore: 0,
    fileCount: r.file_count,
    subdirCount: r.subdir_count,
    depth: r.depth,
    children: expandTree(db, r.dir_path, r.depth, maxDepth),
  }));

  return deduplicateAncestors(results, maxDepth).slice(0, maxResults);
}

// ── Ancestor Deduplication ───────────────────────────────────────────────────

/**
 * Remove results that are already visible inside a higher-ranked ancestor's
 * expanded tree. Results are processed in score order (highest first), so an
 * ancestor is always accepted before its descendants.
 */
function deduplicateAncestors(
  results: SiloDirectorySearchResult[],
  maxDepth: number,
): SiloDirectorySearchResult[] {
  const accepted: SiloDirectorySearchResult[] = [];
  for (const result of results) {
    const subsumed = accepted.some((ancestor) => {
      if (!result.dirPath.startsWith(ancestor.dirPath)) return false;
      const depthDiff = result.depth - ancestor.depth;
      return depthDiff > 0 && depthDiff <= maxDepth;
    });
    if (!subsumed) accepted.push(result);
  }
  return accepted;
}

// ── Tree Expansion ──────────────────────────────────────────────────────────

/**
 * Expand a directory's children tree to maxDepth levels below the root.
 */
export function expandTree(
  db: SiloDatabase,
  rootPath: string,
  rootDepth: number,
  maxDepth: number,
): DirectoryTreeNode[] {
  if (maxDepth <= 0) return [];

  const maxChildDepth = rootDepth + maxDepth;
  const rows = db.prepare(`
    SELECT dir_path, dir_name, file_count, subdir_count, depth
    FROM directories
    WHERE dir_path LIKE ? || '%'
      AND dir_path != ?
      AND depth <= ?
    ORDER BY dir_path
  `).all(rootPath, rootPath, maxChildDepth) as Array<{
    dir_path: string; dir_name: string; file_count: number;
    subdir_count: number; depth: number;
  }>;

  return buildTreeFromFlat(rows, rootDepth);
}

/**
 * Assemble a flat list of directory rows (sorted by dir_path) into a nested tree.
 */
function buildTreeFromFlat(
  rows: Array<{ dir_path: string; dir_name: string; file_count: number; subdir_count: number; depth: number }>,
  rootDepth: number,
): DirectoryTreeNode[] {
  const nodeMap = new Map<string, DirectoryTreeNode>();

  for (const r of rows) {
    nodeMap.set(r.dir_path, {
      name: r.dir_name,
      path: r.dir_path,
      fileCount: r.file_count,
      subdirCount: r.subdir_count,
      children: [],
    });
  }

  const roots: DirectoryTreeNode[] = [];
  for (const r of rows) {
    const node = nodeMap.get(r.dir_path)!;
    if (r.depth === rootDepth + 1) {
      roots.push(node);
    } else {
      const parentPath = r.dir_path.replace(/[^/]+\/$/, '');
      const parent = nodeMap.get(parentPath);
      if (parent) {
        parent.children.push(node);
      }
    }
  }

  return roots;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Sanitise a query for FTS5 trigram MATCH.
 * Trigram requires terms of at least 3 characters; shorter terms are dropped.
 */
function sanitiseTrigramQuery(query: string): string {
  return query
    .replace(/"/g, '""')
    .split(/\s+/)
    .filter((term) => term.length >= 3)
    .map((term) => `"${term}"`)
    .join(' ');
}
