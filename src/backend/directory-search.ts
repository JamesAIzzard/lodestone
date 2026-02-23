/**
 * Directory search — two-axis scoring for directory exploration.
 *
 * Axes:
 *   1. Segment Levenshtein — score the directory's own name (leaf segment)
 *      against the query. Finds directories by name.
 *   2. Token coverage — tokenise query and directory name, compute what
 *      fraction of query tokens appear in the name. Finds directories
 *      matching multi-word queries.
 *
 * Directory score = max(segment, keyword).
 *
 * Directory tables are small (dozens to hundreds of rows) so every directory
 * is scored directly — no prefilter needed. This ensures fuzzy Levenshtein
 * matches are never missed.
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
 * Score a directory by comparing its own name (leaf segment) against the query
 * using normalised Levenshtein distance.
 *
 * Only the leaf is scored — ancestor segments are ignored so that searching
 * "src" doesn't give every directory under src/ a perfect score.
 *
 * Example: query "chunkers", dirName "chunkers" → 1.0
 */
function scoreSegmentLevenshtein(queryLower: string, dirName: string): number {
  const nameLower = dirName.toLowerCase();
  const maxLen = Math.max(queryLower.length, nameLower.length);
  if (maxLen === 0) return 0;
  const dist = levenshteinDistance(queryLower, nameLower);
  return 1 - dist / maxLen;
}

/**
 * Score a directory by token coverage on its own name (leaf segment) —
 * what fraction of query tokens appear in the directory name.
 *
 * Only the leaf name is tokenised — ancestor segments are ignored so that
 * "src" doesn't match every directory under src/.
 *
 * Example: query "nutrient calculator", dirName "calculator" → 0.5
 * (one of two query tokens matched).
 */
function scoreNameTokenCoverage(queryTokens: string[], dirName: string): number {
  if (queryTokens.length === 0) return 0;
  const nameTokens = tokenise(dirName);
  let matched = 0;
  for (const qt of queryTokens) {
    if (nameTokens.includes(qt)) {
      matched++;
      continue;
    }
    let found = false;
    for (const nt of nameTokens) {
      if (nt.includes(qt) || qt.includes(nt)) {
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

  const queryLower = query.trim().toLowerCase();
  const queryTokens = tokenise(query);

  // ── Fetch all directories ──
  // Directory tables are small (dozens to hundreds of rows) so we score
  // every entry with Levenshtein rather than prefiltering. This ensures
  // fuzzy matches like "chunkr" → "chunkers" are never missed.

  const dirRows = db.prepare(`
    SELECT id, dir_path, dir_name, depth, file_count, subdir_count
    FROM directories
  `).all() as Array<{
    id: number; dir_path: string; dir_name: string;
    depth: number; file_count: number; subdir_count: number;
  }>;

  // ── Score candidates ──

  const scored: SiloDirectorySearchResult[] = [];

  for (const dir of dirRows) {
    if (startPath && !dir.dir_path.includes(startPath)) continue;

    const segmentScore = scoreSegmentLevenshtein(queryLower, dir.dir_name);
    const keywordScore = scoreNameTokenCoverage(queryTokens, dir.dir_name);
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

  // Drop zero-scoring candidates (prefilter may pull in path matches that
  // don't match the leaf name) and sort by score descending
  const filtered = scored.filter((r) => r.score > 0);
  filtered.sort((a, b) => b.score - a.score);
  const topScored = filtered.slice(0, maxResults * 4);

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
