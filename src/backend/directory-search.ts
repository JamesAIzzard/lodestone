/**
 * Directory search — 3-signal RRF pipeline for directory exploration.
 *
 * Signals:
 *   1. Semantic   — sqlite-vec cosine similarity on directory embeddings
 *   2. Trigram    — FTS5 trigram search on dir_path and dir_name
 *   3. Filepath   — LIKE substring match on directories.dir_path
 *
 * When the query is empty/broad, falls back to ordering by file_count descending.
 */

import type { SiloDatabase } from './store';
import type { SearchWeights, ScoreBreakdown, DirectoryTreeNode } from '../shared/types';
import { DEFAULT_EXPLORE_WEIGHTS } from '../shared/types';

const DIR_RRF_K = 60;

// ── Types ────────────────────────────────────────────────────────────────────

export interface DirectorySearchParams {
  query?: string;
  startPath?: string;
  maxDepth?: number;
  maxResults?: number;
  weights?: SearchWeights;
}

export interface SiloDirectorySearchResult {
  dirPath: string;
  dirName: string;
  score: number;
  bestCosineSimilarity: number;
  breakdown: ScoreBreakdown;
  fileCount: number;
  subdirCount: number;
  depth: number;
  children: DirectoryTreeNode[];
}

// ── Main Search Function ────────────────────────────────────────────────────

export function directorySearchSilo(
  db: SiloDatabase,
  params: DirectorySearchParams,
  queryEmbedding?: number[],
): SiloDirectorySearchResult[] {
  const {
    query,
    startPath,
    maxDepth = 2,
    maxResults = 20,
    weights = DEFAULT_EXPLORE_WEIGHTS,
  } = params;

  const isEmptyQuery = !query || query.trim().length === 0;

  if (isEmptyQuery) {
    return broadQueryFallback(db, startPath, maxDepth, maxResults);
  }

  const candidateLimit = maxResults * 5;
  const k = DIR_RRF_K;

  // Normalise weights (only semantic, trigram, filepath are active)
  const wTotal = weights.semantic + weights.trigram + weights.filepath;
  const w = wTotal > 0 ? {
    semantic: weights.semantic / wTotal,
    trigram: weights.trigram / wTotal,
    filepath: weights.filepath / wTotal,
  } : { semantic: 0.4, trigram: 0.3, filepath: 0.3 };

  // ── Signal 1: Semantic (sqlite-vec on dirs_vec) ──

  const vecRankMap = new Map<number, number>();
  const cosineSims = new Map<number, number>();
  if (queryEmbedding && w.semantic > 0) {
    try {
      const vecRows = db.prepare(`
        SELECT v.rowid, v.distance
        FROM dirs_vec v
        WHERE v.embedding MATCH ?
          AND k = ?
        ORDER BY v.distance
      `).all(float32Buffer(queryEmbedding), candidateLimit) as Array<{ rowid: number; distance: number }>;

      for (let i = 0; i < vecRows.length; i++) {
        const cosine = 1 - vecRows[i].distance / 2;
        vecRankMap.set(vecRows[i].rowid, i + 1);
        cosineSims.set(vecRows[i].rowid, cosine);
      }
    } catch {
      // Skip if dirs_vec is empty or query fails
    }
  }

  // ── Signal 2: Trigram (FTS5 on dirs_fts) ──

  const trigramRankMap = new Map<number, number>();
  const sanitised = sanitiseTrigramQuery(query!);
  if (sanitised.length > 0 && w.trigram > 0) {
    try {
      const rows = db.prepare(`
        SELECT rowid, rank FROM dirs_fts
        WHERE dirs_fts MATCH ?
        ORDER BY rank LIMIT ?
      `).all(sanitised, candidateLimit) as Array<{ rowid: number; rank: number }>;
      for (let i = 0; i < rows.length; i++) {
        trigramRankMap.set(rows[i].rowid, i + 1);
      }
    } catch {
      // FTS5 error — skip signal
    }
  }

  // ── Signal 3: Filepath (LIKE substring match on dir_path) ──

  const filepathRankMap = new Map<number, number>();
  if (query!.trim().length > 0 && w.filepath > 0) {
    const likePattern = `%${query!.trim().replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
    try {
      const rows = db.prepare(`
        SELECT id FROM directories
        WHERE dir_path LIKE ? ESCAPE '\\'
        ORDER BY depth ASC, file_count DESC
        LIMIT ?
      `).all(likePattern, candidateLimit) as Array<{ id: number }>;
      for (let i = 0; i < rows.length; i++) {
        filepathRankMap.set(rows[i].id, i + 1);
      }
    } catch {
      // Skip on error
    }
  }

  // ── Union candidates and compute RRF ──

  const allIds = new Set([
    ...vecRankMap.keys(),
    ...trigramRankMap.keys(),
    ...filepathRankMap.keys(),
  ]);

  if (allIds.size === 0) return [];

  const penaltyRank = candidateLimit + 1;
  const rrfScores = new Map<number, number>();
  const breakdowns = new Map<number, ScoreBreakdown>();

  for (const id of allIds) {
    const vecRank = vecRankMap.get(id) ?? penaltyRank;
    const triRank = trigramRankMap.get(id) ?? penaltyRank;
    const fpRank = filepathRankMap.get(id) ?? penaltyRank;

    const semanticContrib = w.semantic / (k + vecRank);
    const trigramContrib = w.trigram / (k + triRank);
    const filepathContrib = w.filepath / (k + fpRank);

    const rrf = semanticContrib + trigramContrib + filepathContrib;
    rrfScores.set(id, rrf);
    breakdowns.set(id, {
      semantic:  { rank: vecRankMap.get(id) ?? 0, rawScore: cosineSims.get(id) ?? 0, rrfContribution: semanticContrib },
      bm25:      { rank: 0, rawScore: 0, rrfContribution: 0 },
      trigram:   { rank: trigramRankMap.get(id) ?? 0, rawScore: 0, rrfContribution: trigramContrib },
      filepath:  { rank: filepathRankMap.get(id) ?? 0, rawScore: 0, rrfContribution: filepathContrib },
      tags:      { rank: 0, rawScore: 0, rrfContribution: 0 },
    });
  }

  // Sort by RRF score — overfetch to account for startPath filtering + ancestor dedup
  const sortedIds = Array.from(rrfScores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxResults * 4)
    .map(([id]) => id);

  // Fetch directory data for top results
  const placeholders = sortedIds.map(() => '?').join(',');
  const dirRows = db.prepare(`
    SELECT id, dir_path, dir_name, depth, file_count, subdir_count
    FROM directories
    WHERE id IN (${placeholders})
  `).all(...sortedIds) as Array<{
    id: number; dir_path: string; dir_name: string;
    depth: number; file_count: number; subdir_count: number;
  }>;

  const dirMap = new Map(dirRows.map((r) => [r.id, r]));

  // Build results, filtering by startPath if specified
  const results: SiloDirectorySearchResult[] = [];
  for (const id of sortedIds) {
    const dir = dirMap.get(id);
    if (!dir) continue;
    if (startPath && !dir.dir_path.includes(startPath)) continue;

    const children = expandTree(db, dir.dir_path, dir.depth, maxDepth);

    results.push({
      dirPath: dir.dir_path,
      dirName: dir.dir_name,
      score: rrfScores.get(id) ?? 0,
      bestCosineSimilarity: cosineSims.get(id) ?? 0,
      breakdown: breakdowns.get(id)!,
      fileCount: dir.file_count,
      subdirCount: dir.subdir_count,
      depth: dir.depth,
      children,
    });
  }

  // Remove results already visible inside a higher-ranked ancestor's tree
  return deduplicateAncestors(results, maxDepth).slice(0, maxResults);
}

// ── Broad/Empty Query Fallback ──────────────────────────────────────────────

function broadQueryFallback(
  db: SiloDatabase,
  startPath: string | undefined,
  maxDepth: number,
  maxResults: number,
): SiloDirectorySearchResult[] {
  // Overfetch to account for ancestor dedup
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

  const zeroBreakdown: ScoreBreakdown = {
    semantic:  { rank: 0, rawScore: 0, rrfContribution: 0 },
    bm25:      { rank: 0, rawScore: 0, rrfContribution: 0 },
    trigram:   { rank: 0, rawScore: 0, rrfContribution: 0 },
    filepath:  { rank: 0, rawScore: 0, rrfContribution: 0 },
    tags:      { rank: 0, rawScore: 0, rrfContribution: 0 },
  };

  const results = (rows as Array<{
    id: number; dir_path: string; dir_name: string;
    depth: number; file_count: number; subdir_count: number;
  }>).map((r) => ({
    dirPath: r.dir_path,
    dirName: r.dir_name,
    score: r.file_count / 100, // rough normalised score
    bestCosineSimilarity: 0,
    breakdown: zeroBreakdown,
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
 * ancestor is always accepted before its descendants. A descendant is dropped
 * when it is a sub-path of an accepted result AND falls within that result's
 * tree expansion depth.
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
 * Queries the directories table and assembles into a nested tree.
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
 * Directories at rootDepth+1 become root-level children; deeper ones nest under parents.
 */
function buildTreeFromFlat(
  rows: Array<{ dir_path: string; dir_name: string; file_count: number; subdir_count: number; depth: number }>,
  rootDepth: number,
): DirectoryTreeNode[] {
  const nodeMap = new Map<string, DirectoryTreeNode>();

  // Create nodes
  for (const r of rows) {
    nodeMap.set(r.dir_path, {
      name: r.dir_name,
      path: r.dir_path,
      fileCount: r.file_count,
      subdirCount: r.subdir_count,
      children: [],
    });
  }

  // Link children to parents
  const roots: DirectoryTreeNode[] = [];
  for (const r of rows) {
    const node = nodeMap.get(r.dir_path)!;
    if (r.depth === rootDepth + 1) {
      roots.push(node);
    } else {
      // Find parent by trimming the last path segment
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

/** Convert number[] to Buffer for sqlite-vec queries. */
function float32Buffer(vec: number[]): Buffer {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

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
