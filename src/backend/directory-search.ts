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

import type { SiloDatabase } from './store/types';
import { getFilesInDirectory } from './store/operations';
import type { DirectoryTreeNode, FusedScore } from '../shared/types';
import { runTextRecipe, DIRECTORY_NAME_RECIPE } from './scorers/recipes';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DirectorySearchParams {
  query?: string;
  startPath?: string;
  maxDepth?: number;
  maxResults?: number;
  fullContents?: boolean;
}

export interface SiloDirectorySearchResult {
  dirPath: string;
  dirName: string;
  score: number;
  /** Which axis drove the directory's ranking. */
  scoreSource: string;
  /** Per-axis fused scores. */
  axes: Record<string, FusedScore>;
  fileCount: number;
  subdirCount: number;
  depth: number;
  children: DirectoryTreeNode[];
  /** Files directly inside this directory (only present when fullContents=true) */
  files?: Array<{ filePath: string; fileName: string }>;
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
    fullContents,
  } = params;

  const isEmptyQuery = !query || query.trim().length === 0;

  if (isEmptyQuery) {
    return broadQueryFallback(db, startPath, maxDepth, maxResults, fullContents);
  }

  const queryLower = query.trim().toLowerCase();

  // ── Fetch all directories ──
  // Directory tables are small (dozens to hundreds of rows) so we score
  // every entry with the recipe rather than prefiltering. This ensures
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

    const fused = runTextRecipe(DIRECTORY_NAME_RECIPE, queryLower, dir.dir_name.toLowerCase());

    scored.push({
      dirPath: dir.dir_path,
      dirName: dir.dir_name,
      score: fused.best,
      scoreSource: DIRECTORY_NAME_RECIPE.axis,
      axes: { [DIRECTORY_NAME_RECIPE.axis]: fused },
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
    result.children = expandTree(db, result.dirPath, result.depth, maxDepth, fullContents);
    if (fullContents) {
      result.files = getFilesInDirectory(db, result.dirPath);
    }
  }

  return deduplicateAncestors(topScored, maxDepth).slice(0, maxResults);
}

// ── Broad/Empty Query Fallback ──────────────────────────────────────────────

function broadQueryFallback(
  db: SiloDatabase,
  startPath: string | undefined,
  maxDepth: number,
  maxResults: number,
  fullContents?: boolean,
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

  const broadFallbackFused: FusedScore = { best: 0, bestSignal: 'levenshtein', signals: { levenshtein: 0, tokenCoverage: 0 } };

  const results = (rows as Array<{
    id: number; dir_path: string; dir_name: string;
    depth: number; file_count: number; subdir_count: number;
  }>).map((r) => ({
    dirPath: r.dir_path,
    dirName: r.dir_name,
    score: 1.0,
    scoreSource: DIRECTORY_NAME_RECIPE.axis,
    axes: { [DIRECTORY_NAME_RECIPE.axis]: broadFallbackFused },
    fileCount: r.file_count,
    subdirCount: r.subdir_count,
    depth: r.depth,
    children: expandTree(db, r.dir_path, r.depth, maxDepth, fullContents),
    files: fullContents ? getFilesInDirectory(db, r.dir_path) : undefined,
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
  fullContents?: boolean,
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

  const tree = buildTreeFromFlat(rows, rootDepth);

  if (fullContents) {
    attachFilesToTree(db, tree);
  }

  return tree;
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

/** Recursively attach file listings to each tree node using stored-key paths. */
function attachFilesToTree(db: SiloDatabase, nodes: DirectoryTreeNode[]): void {
  for (const node of nodes) {
    node.files = getFilesInDirectory(db, node.path).map((f) => ({
      filePath: f.filePath,
      fileName: f.fileName,
    }));
    if (node.children.length > 0) {
      attachFilesToTree(db, node.children);
    }
  }
}
