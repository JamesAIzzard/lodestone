/**
 * V2 database operations — all reads and writes for the silo database.
 *
 * Every function takes a `db: SiloDatabase` handle and runs synchronously
 * (better-sqlite3 is sync). These are called from the store worker thread,
 * never directly from the main thread.
 *
 * The batch write path (`flushPreparedFiles`) is the heart of V2:
 *   V1: ~600 SQL statements per chunk (per-term INSERT OR CONFLICT)
 *   V2: ~30 SQL statements per chunk (batched postings, TermCache)
 */

import type { SiloDatabase, FlushUpsert, FlushDelete, FlushResult, SiloMeta, StoredSiloConfig, ChunkMeta, DirEntry } from './types';
import { SCHEMA_VERSION } from './types';
import { TermCache } from './term-cache';
import { compressText, quantizeInt8, hashToBlob } from './compression';
import { extractDirectoryPaths, fileBasename } from './paths';
import { tokenise } from '../tokeniser';

// ── Batch Write Path ─────────────────────────────────────────────────────────

/**
 * Flush a batch of prepared files to the database in a single transaction.
 *
 * The batch is processed in three phases:
 *   1. Delete — remove existing chunks, postings, and vectors for affected files
 *   2. Insert — add new chunks, vectors, and postings (sorted by term_id)
 *   3. Cleanup — recompute term doc_freq, corpus stats, and directory entries
 *
 * Files with empty chunk arrays have their chunks cleared but keep the file
 * row in the `files` table so they remain discoverable by filepath search.
 */
export function flushPreparedFiles(
  db: SiloDatabase,
  termCache: TermCache,
  upserts: FlushUpsert[],
  deletes: FlushDelete[],
): FlushResult {
  const t = performance.now();
  let upserted = 0;
  let cleared = 0;
  let deleted = 0;

  db.transaction(() => {
    // Term IDs whose doc_freq needs recomputing after all mutations
    const dirtyTermIds = new Set<number>();

    // All chunk IDs to delete (across upserts + deletes), collected in phase 1
    const allOldChunkIds: number[] = [];

    // Per-upsert state: file_id resolved in phase 1, used in phase 2
    const upsertFileIds: number[] = [];

    // ── Prepared statements ──────────────────────────────────────────────

    const upsertFile = db.prepare(`
      INSERT INTO files (stored_key, file_name, mtime_ms) VALUES (?, ?, ?)
      ON CONFLICT(stored_key) DO UPDATE SET mtime_ms = excluded.mtime_ms
      RETURNING id
    `);
    const selectFileId = db.prepare(
      'SELECT id FROM files WHERE stored_key = ?',
    );
    const selectChunksByFile = db.prepare(
      'SELECT id FROM chunks WHERE file_id = ?',
    );
    const deleteVecChunk = db.prepare(
      'DELETE FROM vec_chunks WHERE rowid = ?',
    );
    const deleteChunksByFile = db.prepare(
      'DELETE FROM chunks WHERE file_id = ?',
    );
    const deleteFileRow = db.prepare(
      'DELETE FROM files WHERE id = ?',
    );
    const insertVec = db.prepare(
      'INSERT INTO vec_chunks(embedding) VALUES (vec_int8(?))',
    );
    const insertChunk = db.prepare(`
      INSERT INTO chunks (id, file_id, chunk_index, section_path, text, location_hint, metadata, content_hash, token_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertPosting = db.prepare(
      'INSERT INTO postings (term_id, chunk_id, term_freq) VALUES (?, ?, ?)',
    );

    // ── Phase 1: Resolve files and collect existing chunk IDs ─────────────

    // 1a. Upserts — resolve file_id and collect old chunk IDs
    for (const up of upserts) {
      const fileRow = upsertFile.get(
        up.storedKey,
        fileBasename(up.storedKey),
        up.mtimeMs ?? null,
      ) as { id: number };
      upsertFileIds.push(fileRow.id);

      const oldChunks = selectChunksByFile.all(fileRow.id) as Array<{ id: number }>;
      for (const { id } of oldChunks) allOldChunkIds.push(id);
    }

    // 1b. Deletes — collect old chunk IDs
    const deleteFileIdMap: Array<{ fileId: number; storedKey: string }> = [];
    for (const del of deletes) {
      const fileRow = selectFileId.get(del.storedKey) as { id: number } | undefined;
      if (!fileRow) continue;
      deleteFileIdMap.push({ fileId: fileRow.id, storedKey: del.storedKey });

      const oldChunks = selectChunksByFile.all(fileRow.id) as Array<{ id: number }>;
      for (const { id } of oldChunks) allOldChunkIds.push(id);
    }

    // ── Phase 2: Batch-delete old postings and chunks ────────────────────

    if (allOldChunkIds.length > 0) {
      // Load chunk IDs into a temp table for efficient batch operations
      db.exec('CREATE TEMP TABLE IF NOT EXISTS _del_chunks (id INTEGER PRIMARY KEY)');
      db.exec('DELETE FROM _del_chunks');
      const insertDelId = db.prepare('INSERT INTO _del_chunks (id) VALUES (?)');
      for (const id of allOldChunkIds) insertDelId.run(id);

      // Collect affected term_ids before deleting postings
      const affectedTerms = db.prepare(
        'SELECT DISTINCT term_id FROM postings WHERE chunk_id IN (SELECT id FROM _del_chunks)',
      ).all() as Array<{ term_id: number }>;
      for (const { term_id } of affectedTerms) dirtyTermIds.add(term_id);

      // Batch-delete postings
      db.prepare(
        'DELETE FROM postings WHERE chunk_id IN (SELECT id FROM _del_chunks)',
      ).run();

      // Delete vec_chunks one-by-one (sqlite-vec virtual table requirement)
      for (const id of allOldChunkIds) deleteVecChunk.run(id);

      // Delete chunk rows per file
      for (let i = 0; i < upserts.length; i++) {
        deleteChunksByFile.run(upsertFileIds[i]);
      }
      for (const { fileId } of deleteFileIdMap) {
        deleteChunksByFile.run(fileId);
      }
    }

    // ── Phase 3: Insert new chunks and accumulate postings ───────────────

    // Buffer all postings in memory, then sort by term_id for sequential
    // B-tree writes (reduces random page access).
    const allPostings: Array<{ termId: number; chunkId: number; freq: number }> = [];

    for (let i = 0; i < upserts.length; i++) {
      const up = upserts[i];
      const fileId = upsertFileIds[i];

      if (up.chunks.length === 0) {
        // Empty file — chunks removed, file row kept for filepath search
        cleared++;
        ensureAncestorDirectories(db, up.storedKey);
        continue;
      }

      for (let j = 0; j < up.chunks.length; j++) {
        const chunk = up.chunks[j];
        const embedding = up.embeddings[j];

        // Insert quantized int8 vector → get rowid (becomes chunk.id)
        const vecResult = insertVec.run(quantizeInt8(embedding));
        const chunkId = Number(vecResult.lastInsertRowid);

        // Tokenise once — used for both token_count and term frequencies
        const tokens = tokenise(chunk.text);

        // Insert chunk row with compressed text and binary hash
        insertChunk.run(
          chunkId,
          fileId,
          chunk.chunkIndex,
          JSON.stringify(chunk.sectionPath),
          compressText(chunk.text),
          JSON.stringify(chunk.locationHint),
          JSON.stringify(chunk.metadata),
          hashToBlob(chunk.contentHash),
          tokens.length,
        );

        // Build term frequency map for this chunk
        const termFreqs = new Map<string, number>();
        for (const token of tokens) {
          termFreqs.set(token, (termFreqs.get(token) ?? 0) + 1);
        }

        // Resolve term IDs via TermCache (O(1) hit, INSERT on miss)
        for (const [term, freq] of termFreqs) {
          const termId = termCache.getOrInsert(db, term);
          allPostings.push({ termId, chunkId, freq });
          dirtyTermIds.add(termId);
        }
      }

      ensureAncestorDirectories(db, up.storedKey);
      upserted++;
    }

    // Sort postings by term_id for sequential B-tree page access
    allPostings.sort((a, b) => a.termId - b.termId);
    for (const p of allPostings) {
      insertPosting.run(p.termId, p.chunkId, p.freq);
    }

    // ── Phase 4: Finalize deletes (remove file rows) ─────────────────────

    for (const { fileId } of deleteFileIdMap) {
      deleteFileRow.run(fileId);
      deleted++;
    }

    // ── Phase 5: Recompute doc_freq for affected terms ───────────────────

    if (dirtyTermIds.size > 0) {
      const recomputeFreq = db.prepare(
        'UPDATE terms SET doc_freq = (SELECT COUNT(*) FROM postings WHERE term_id = ?) WHERE id = ?',
      );
      for (const termId of dirtyTermIds) {
        recomputeFreq.run(termId, termId);
      }

      // Remove terms with zero postings from both DB and TermCache
      termCache.removeZeroFreq(db);
    }

    // ── Phase 6: Update corpus-level BM25 stats ──────────────────────────

    updateCorpusStats(db);
  })();

  return { upserted, cleared, deleted, durationMs: performance.now() - t };
}

// ── Mtime Operations (merged into files table) ───────────────────────────────

/**
 * Load the stored-key → mtime_ms map from the files table.
 * Only returns files with a non-null mtime (indexed files).
 */
export function loadMtimes(db: SiloDatabase): Map<string, number> {
  const rows = db.prepare(
    'SELECT stored_key, mtime_ms FROM files WHERE mtime_ms IS NOT NULL',
  ).all() as Array<{ stored_key: string; mtime_ms: number }>;
  return new Map(rows.map((r) => [r.stored_key, r.mtime_ms]));
}

/** Update a single file's modification time. File row must already exist. */
export function setMtime(db: SiloDatabase, storedKey: string, mtimeMs: number): void {
  db.prepare('UPDATE files SET mtime_ms = ? WHERE stored_key = ?').run(mtimeMs, storedKey);
}

/** Clear a file's modification time (set to NULL). */
export function deleteMtime(db: SiloDatabase, storedKey: string): void {
  db.prepare('UPDATE files SET mtime_ms = NULL WHERE stored_key = ?').run(storedKey);
}

/** Count files with a non-null mtime (i.e. indexed files). */
export function countMtimes(db: SiloDatabase): number {
  const row = db.prepare(
    'SELECT COUNT(*) as cnt FROM files WHERE mtime_ms IS NOT NULL',
  ).get() as { cnt: number };
  return row.cnt;
}

// ── Meta Operations ──────────────────────────────────────────────────────────

/** Load silo metadata. Returns null if no metadata has been stored. */
export function loadMeta(db: SiloDatabase): SiloMeta | null {
  const rows = db.prepare('SELECT key, value FROM meta').all() as Array<{
    key: string;
    value: string;
  }>;
  if (rows.length === 0) return null;

  const map = new Map(rows.map((r) => [r.key, r.value]));
  const model = map.get('model');
  const dimensions = map.get('dimensions');
  if (!model || !dimensions) return null;

  return {
    model,
    dimensions: parseInt(dimensions, 10),
    createdAt: map.get('createdAt') ?? new Date().toISOString(),
    version: parseInt(map.get('version') ?? String(SCHEMA_VERSION), 10),
  };
}

/** Save silo metadata (preserves createdAt from existing meta). */
export function saveMeta(db: SiloDatabase, model: string, dimensions: number): void {
  const existing = loadMeta(db);
  const meta: SiloMeta = {
    model,
    dimensions,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    version: SCHEMA_VERSION,
  };

  const upsert = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  db.transaction(() => {
    upsert.run('model', meta.model);
    upsert.run('dimensions', String(meta.dimensions));
    upsert.run('createdAt', meta.createdAt);
    upsert.run('version', String(meta.version));
  })();
}

/** Save a silo configuration snapshot as a JSON blob in the meta table. */
export function saveConfigBlob(db: SiloDatabase, config: StoredSiloConfig): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    .run('config', JSON.stringify(config));
}

/** Load the stored silo configuration. Returns null if not stored. */
export function loadConfigBlob(db: SiloDatabase): StoredSiloConfig | null {
  const row = db.prepare(
    "SELECT value FROM meta WHERE key = 'config'",
  ).get() as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as StoredSiloConfig;
  } catch {
    return null;
  }
}

// ── Stats ────────────────────────────────────────────────────────────────────

/** Total number of chunks in the database. */
export function getChunkCount(db: SiloDatabase): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number };
  return row.cnt;
}

/** Total number of files in the database. */
export function getFileCount(db: SiloDatabase): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM files').get() as { cnt: number };
  return row.cnt;
}

/**
 * Recompute corpus-level BM25 statistics and store in the meta table.
 * Called once per batch flush (not per file).
 */
export function updateCorpusStats(db: SiloDatabase): void {
  const stats = db.prepare(
    'SELECT COUNT(*) AS cnt, COALESCE(AVG(token_count), 0) AS avg_tc FROM chunks',
  ).get() as { cnt: number; avg_tc: number };

  const upsert = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  upsert.run('corpus_chunk_count', String(stats.cnt));
  upsert.run('corpus_avg_token_count', String(stats.avg_tc));
}

// ── Chunk Metadata (for signal implementations) ──────────────────────────────

/**
 * Fetch chunk metadata for a set of chunk IDs.
 * Joins through the files table to resolve stored_key (V2 schema uses file_id FK).
 * Uses a temp table for efficient batch lookup.
 */
export function fetchChunkMeta(db: SiloDatabase, chunkIds: Set<number>): Map<number, ChunkMeta> {
  const result = new Map<number, ChunkMeta>();
  if (chunkIds.size === 0) return result;

  db.exec('CREATE TEMP TABLE IF NOT EXISTS _signal_ids (id INTEGER PRIMARY KEY)');
  db.exec('DELETE FROM _signal_ids');
  const insert = db.prepare('INSERT INTO _signal_ids (id) VALUES (?)');
  for (const id of chunkIds) insert.run(id);

  const rows = db.prepare(`
    SELECT c.id, c.file_id, f.stored_key, c.section_path, c.location_hint
    FROM chunks c
    JOIN files f ON f.id = c.file_id
    JOIN _signal_ids t ON t.id = c.id
  `).all() as ChunkMeta[];

  for (const row of rows) result.set(row.id, row);
  return result;
}

// ── Directory Operations ─────────────────────────────────────────────────────

/**
 * Insert a single directory entry if it doesn't already exist.
 * Returns true if the row was newly inserted.
 */
export function insertDirEntry(db: SiloDatabase, dirPath: string): boolean {
  const colonIdx = dirPath.indexOf(':');
  if (colonIdx === -1) return false;
  const rel = dirPath.slice(colonIdx + 1, -1); // strip trailing '/'
  const segments = rel.split('/').filter(Boolean);
  if (segments.length === 0) return false;
  const dirName = segments[segments.length - 1];
  const depth = segments.length;
  const result = db.prepare(
    'INSERT OR IGNORE INTO directories (dir_path, dir_name, depth, file_count, subdir_count) VALUES (?, ?, ?, 0, 0)',
  ).run(dirPath, dirName, depth);
  return result.changes > 0;
}

/**
 * Delete a single directory entry by stored dir-key.
 * Returns the deleted directory id, or null if not found.
 */
export function deleteDirEntry(db: SiloDatabase, dirPath: string): number | null {
  const row = db.prepare('SELECT id FROM directories WHERE dir_path = ?').get(dirPath) as { id: number } | undefined;
  if (!row) return null;
  db.prepare('DELETE FROM directories WHERE id = ?').run(row.id);
  return row.id;
}

/**
 * List files directly inside a directory (not recursive).
 *
 * @param dirStoredKey The stored directory key (e.g. "0:src/backend/") or
 *                     a silo root prefix (e.g. "0:") for root-level files.
 */
export function getFilesInDirectory(
  db: SiloDatabase,
  dirStoredKey: string,
): Array<{ filePath: string; fileName: string }> {
  return db.prepare(`
    SELECT stored_key AS filePath, file_name AS fileName FROM files
    WHERE stored_key LIKE ? || '%'
      AND stored_key NOT LIKE ? || '%/%'
    ORDER BY file_name
  `).all(dirStoredKey, dirStoredKey) as Array<{ filePath: string; fileName: string }>;
}

/**
 * Sync directory structure with disk — insert new directories, remove orphans.
 * Count recomputation is handled separately by `recomputeDirectoryCounts`.
 *
 * Returns the list of removed directory stored-key paths.
 */
export function syncDirectoriesWithDisk(
  db: SiloDatabase,
  diskDirPaths: DirEntry[],
): string[] {
  const diskSet = new Set(diskDirPaths.map((d) => d.dirPath));

  return db.transaction(() => {
    // Insert new directories
    const insertDir = db.prepare(
      'INSERT OR IGNORE INTO directories (dir_path, dir_name, depth, file_count, subdir_count) VALUES (?, ?, ?, 0, 0)',
    );
    for (const d of diskDirPaths) {
      insertDir.run(d.dirPath, d.dirName, d.depth);
    }

    // Find directories in DB but not on disk
    const allDbDirs = db.prepare('SELECT id, dir_path FROM directories').all() as Array<{
      id: number;
      dir_path: string;
    }>;
    const toRemove = allDbDirs.filter((d) => !diskSet.has(d.dir_path));

    // Remove orphaned directories
    const deleteDir = db.prepare('DELETE FROM directories WHERE id = ?');
    for (const d of toRemove) deleteDir.run(d.id);

    return toRemove.map((d) => d.dir_path);
  })();
}

/**
 * Recompute file_count and subdir_count for all directories.
 *
 * V2: runs synchronously in the worker thread — no async batching needed
 * since blocking the worker doesn't freeze the UI.
 */
export function recomputeDirectoryCounts(db: SiloDatabase): void {
  const allDirs = db.prepare(
    'SELECT id, dir_path, depth FROM directories',
  ).all() as Array<{ id: number; dir_path: string; depth: number }>;

  if (allDirs.length === 0) return;

  const updateFileCount = db.prepare(`
    UPDATE directories SET file_count = (
      SELECT COUNT(*) FROM files
      WHERE stored_key LIKE ? || '%'
        AND stored_key NOT LIKE ? || '%/%'
    ) WHERE id = ?
  `);

  const updateSubdirCount = db.prepare(`
    UPDATE directories SET subdir_count = (
      SELECT COUNT(*) FROM directories d2
      WHERE d2.dir_path LIKE ? || '%'
        AND d2.dir_path != ?
        AND d2.depth = ? + 1
    ) WHERE id = ?
  `);

  db.transaction(() => {
    for (const dir of allDirs) {
      updateFileCount.run(dir.dir_path, dir.dir_path, dir.id);
      updateSubdirCount.run(dir.dir_path, dir.dir_path, dir.depth, dir.id);
    }
  })();
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Ensure all ancestor directory rows exist for a stored key.
 * Called during flush for each upserted file.
 */
function ensureAncestorDirectories(db: SiloDatabase, storedKey: string): void {
  const dirPaths = extractDirectoryPaths(storedKey);
  if (dirPaths.length === 0) return;

  const insertDir = db.prepare(
    'INSERT OR IGNORE INTO directories (dir_path, dir_name, depth, file_count, subdir_count) VALUES (?, ?, ?, 0, 0)',
  );
  for (const d of dirPaths) {
    insertDir.run(d.dirPath, d.dirName, d.depth);
  }

  updateDirectoryCounts(db, dirPaths);
}

/**
 * Recompute file_count and subdir_count for a specific set of directories.
 * More targeted than `recomputeDirectoryCounts` — used per-file during flush.
 */
function updateDirectoryCounts(db: SiloDatabase, dirPaths: DirEntry[]): void {
  const updateFileCount = db.prepare(`
    UPDATE directories SET file_count = (
      SELECT COUNT(*) FROM files
      WHERE stored_key LIKE ? || '%'
        AND stored_key NOT LIKE ? || '%/%'
    ) WHERE dir_path = ?
  `);
  const updateSubdirCount = db.prepare(`
    UPDATE directories SET subdir_count = (
      SELECT COUNT(*) FROM directories
      WHERE dir_path LIKE ? || '%'
        AND dir_path != ?
        AND depth = ?
    ) WHERE dir_path = ?
  `);

  for (const d of dirPaths) {
    updateFileCount.run(d.dirPath, d.dirPath, d.dirPath);
    updateSubdirCount.run(d.dirPath, d.dirPath, d.depth + 1, d.dirPath);
  }
}
