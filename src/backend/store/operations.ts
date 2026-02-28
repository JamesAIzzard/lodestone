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

  // ── Instrumentation accumulators ────────────────────────────────────
  let tPhase1 = 0, tPhase2 = 0, tPhase3 = 0, tPhase5 = 0, tPhase6 = 0;
  let tVecInsert = 0, tChunkSql = 0, tCompress = 0;
  let tTermFreqMap = 0, tTermResolve = 0, tDirEntries = 0;
  let totalChunks = 0, totalPostings = 0, totalDirtyTerms = 0;
  let addedTokenSum = 0, removedTokenSum = 0, removedChunkCount = 0;
  let subTxCount = 0;

  // ── Prepared statements (reused across all sub-transactions) ──────────

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

  // State accumulated across sub-transactions
  const dirtyTermIds = new Set<number>();
  const allPostings: Array<{ termId: number; chunkId: number; freq: number }> = [];
  const upsertFileIds: number[] = [];
  const allOldChunkIds: number[] = [];
  const deleteFileIdMap: Array<{ fileId: number; storedKey: string }> = [];

  // ── Transaction 1: Resolve files + delete old chunks ───────────────────

  db.transaction(() => {
    const p1 = performance.now();

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
    for (const del of deletes) {
      const fileRow = selectFileId.get(del.storedKey) as { id: number } | undefined;
      if (!fileRow) continue;
      deleteFileIdMap.push({ fileId: fileRow.id, storedKey: del.storedKey });

      const oldChunks = selectChunksByFile.all(fileRow.id) as Array<{ id: number }>;
      for (const { id } of oldChunks) allOldChunkIds.push(id);
    }

    tPhase1 = performance.now() - p1;

    // Phase 2: Batch-delete old postings and chunks
    const p2 = performance.now();

    if (allOldChunkIds.length > 0) {
      db.exec('CREATE TEMP TABLE IF NOT EXISTS _del_chunks (id INTEGER PRIMARY KEY)');
      db.exec('DELETE FROM _del_chunks');
      const insertDelId = db.prepare('INSERT INTO _del_chunks (id) VALUES (?)');
      for (const id of allOldChunkIds) insertDelId.run(id);

      // Sum token_counts of chunks about to be deleted (for incremental corpus stats)
      const removedStats = db.prepare(
        'SELECT COUNT(*) AS cnt, COALESCE(SUM(token_count), 0) AS total_tc FROM chunks WHERE id IN (SELECT id FROM _del_chunks)',
      ).get() as { cnt: number; total_tc: number };
      removedChunkCount = removedStats.cnt;
      removedTokenSum = removedStats.total_tc;

      const affectedTerms = db.prepare(
        'SELECT DISTINCT term_id FROM postings WHERE chunk_id IN (SELECT id FROM _del_chunks)',
      ).all() as Array<{ term_id: number }>;
      for (const { term_id } of affectedTerms) dirtyTermIds.add(term_id);

      db.prepare(
        'DELETE FROM postings WHERE chunk_id IN (SELECT id FROM _del_chunks)',
      ).run();

      for (const id of allOldChunkIds) deleteVecChunk.run(id);

      for (let i = 0; i < upserts.length; i++) {
        deleteChunksByFile.run(upsertFileIds[i]);
      }
      for (const { fileId } of deleteFileIdMap) {
        deleteChunksByFile.run(fileId);
      }
    }

    tPhase2 = performance.now() - p2;
  })();

  // ── Phase 3: Insert chunks in sub-transactions ─────────────────────────
  //
  // Large batches (2303 chunks from a big PDF) cause catastrophic slowdowns
  // in a single transaction: the WAL grows huge, every subsequent INSERT
  // gets slower. Splitting into sub-transactions of ~500 chunks keeps each
  // transaction small and allows PASSIVE WAL checkpoints between batches.

  const SUB_TX_LIMIT = 500;
  const p3 = performance.now();
  let chunksInSubTx = 0;
  let subTxOpen = false;

  const beginSubTx = () => { db.exec('BEGIN IMMEDIATE'); subTxOpen = true; chunksInSubTx = 0; };
  const commitSubTx = () => {
    db.exec('COMMIT');
    subTxOpen = false;
    subTxCount++;
    // Passive WAL checkpoint between sub-transactions keeps the WAL small
    try { db.pragma('wal_checkpoint(PASSIVE)'); } catch { /* non-critical */ }
  };

  beginSubTx();

  for (let i = 0; i < upserts.length; i++) {
    const up = upserts[i];
    const fileId = upsertFileIds[i];

    if (up.chunks.length === 0) {
      cleared++;
      const dS = performance.now();
      ensureAncestorDirectories(db, up.storedKey);
      tDirEntries += performance.now() - dS;
      continue;
    }

    for (let j = 0; j < up.chunks.length; j++) {
      const chunk = up.chunks[j];

      // Compress, serialize, quantize inline (one chunk at a time — no OOM risk)
      let s = performance.now();
      const compressedText = compressText(chunk.text);
      const sectionPathJson = JSON.stringify(chunk.sectionPath);
      const locationHintJson = JSON.stringify(chunk.locationHint);
      const metadataJson = JSON.stringify(chunk.metadata);
      const hashBlob = hashToBlob(chunk.contentHash);
      const quantizedVec = quantizeInt8(up.embeddings[j]);
      const tokens = tokenise(chunk.text);
      tCompress += performance.now() - s;

      // Insert quantized int8 vector → get rowid (becomes chunk.id)
      s = performance.now();
      const vecResult = insertVec.run(quantizedVec);
      const chunkId = Number(vecResult.lastInsertRowid);
      tVecInsert += performance.now() - s;

      // Insert chunk row
      s = performance.now();
      insertChunk.run(
        chunkId,
        fileId,
        chunk.chunkIndex,
        sectionPathJson,
        compressedText,
        locationHintJson,
        metadataJson,
        hashBlob,
        tokens.length,
      );
      tChunkSql += performance.now() - s;
      addedTokenSum += tokens.length;

      // Build term frequency map for this chunk
      s = performance.now();
      const termFreqs = new Map<string, number>();
      for (const token of tokens) {
        termFreqs.set(token, (termFreqs.get(token) ?? 0) + 1);
      }
      tTermFreqMap += performance.now() - s;

      // Resolve term IDs via TermCache (O(1) hit, INSERT on miss)
      s = performance.now();
      for (const [term, freq] of termFreqs) {
        const termId = termCache.getOrInsert(db, term);
        allPostings.push({ termId, chunkId, freq });
        dirtyTermIds.add(termId);
      }
      tTermResolve += performance.now() - s;

      totalChunks++;
      chunksInSubTx++;

      // Commit sub-transaction when limit reached (but not on the very last chunk)
      if (chunksInSubTx >= SUB_TX_LIMIT && !(i === upserts.length - 1 && j === up.chunks.length - 1)) {
        commitSubTx();
        beginSubTx();
      }
    }

    const dS = performance.now();
    ensureAncestorDirectories(db, up.storedKey);
    tDirEntries += performance.now() - dS;
    upserted++;
  }

  if (subTxOpen) commitSubTx();

  tPhase3 = performance.now() - p3;

  // ── Final transaction: postings, cleanup, doc_freq, corpus stats ───────

  db.transaction(() => {
    // Sort postings by term_id for sequential B-tree page access
    let sPost = performance.now();
    allPostings.sort((a, b) => a.termId - b.termId);
    const tPostingSort = performance.now() - sPost;

    sPost = performance.now();
    for (const p of allPostings) {
      insertPosting.run(p.termId, p.chunkId, p.freq);
    }
    const tPostingInsert = performance.now() - sPost;

    totalPostings = allPostings.length;

    // Phase 4: Finalize deletes (remove file rows)
    for (const { fileId } of deleteFileIdMap) {
      deleteFileRow.run(fileId);
      deleted++;
    }

    // Phase 5: Recompute doc_freq for affected terms
    const p5 = performance.now();

    if (dirtyTermIds.size > 0) {
      const recomputeFreq = db.prepare(
        'UPDATE terms SET doc_freq = (SELECT COUNT(*) FROM postings WHERE term_id = ?) WHERE id = ?',
      );
      for (const termId of dirtyTermIds) {
        recomputeFreq.run(termId, termId);
      }

      termCache.removeZeroFreq(db);
    }

    totalDirtyTerms = dirtyTermIds.size;
    tPhase5 = performance.now() - p5;

    // Phase 6: Update corpus-level BM25 stats
    const p6 = performance.now();

    updateCorpusStats(db, {
      addedChunks: totalChunks,
      addedTokenSum,
      removedChunks: removedChunkCount,
      removedTokenSum,
    });

    tPhase6 = performance.now() - p6;

    // ── Instrumentation log ──────────────────────────────────────────────

    const total = performance.now() - t;
    console.log(
      `\n[FLUSH TIMING] ${totalChunks} chunks, ${totalPostings} postings, ${totalDirtyTerms} dirty terms` +
      ` (${subTxCount} sub-transactions)\n` +
      `  Phase 1 (resolve files):     ${tPhase1.toFixed(1)} ms\n` +
      `  Phase 2 (delete old):        ${tPhase2.toFixed(1)} ms  (${allOldChunkIds.length} old chunks)\n` +
      `  Phase 3 (insert chunks):     ${tPhase3.toFixed(1)} ms\n` +
      `    ├─ compress+tok+quant:        ${tCompress.toFixed(1)} ms\n` +
      `    ├─ vecInsert (SQL only):      ${tVecInsert.toFixed(1)} ms\n` +
      `    ├─ chunkSQL (INSERT only):    ${tChunkSql.toFixed(1)} ms  (${totalChunks > 0 ? (tChunkSql / totalChunks).toFixed(1) : '0.0'} ms/chunk)\n` +
      `    ├─ termFreqMap:               ${tTermFreqMap.toFixed(1)} ms\n` +
      `    ├─ termResolve (TermCache):   ${tTermResolve.toFixed(1)} ms\n` +
      `    └─ dirEntries:                ${tDirEntries.toFixed(1)} ms\n` +
      `  Final tx (postings+cleanup):\n` +
      `    ├─ postingSort:               ${tPostingSort.toFixed(1)} ms\n` +
      `    ├─ postingInsert:             ${tPostingInsert.toFixed(1)} ms\n` +
      `    ├─ doc_freq recomp:           ${tPhase5.toFixed(1)} ms  (${totalDirtyTerms} terms)\n` +
      `    └─ corpus stats:              ${tPhase6.toFixed(1)} ms\n` +
      `  TOTAL:                        ${total.toFixed(1)} ms`,
    );
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

/**
 * Total number of chunks in the database.
 * Uses the cached corpus_chunk_count from meta when available (O(1)),
 * falls back to COUNT(*) scan otherwise.
 */
export function getChunkCount(db: SiloDatabase): number {
  const meta = db.prepare("SELECT value FROM meta WHERE key = 'corpus_chunk_count'").get() as { value: string } | undefined;
  if (meta) return parseInt(meta.value, 10);
  const row = db.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number };
  return row.cnt;
}

/** Total number of files in the database. */
export function getFileCount(db: SiloDatabase): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM files').get() as { cnt: number };
  return row.cnt;
}

/**
 * Incrementally update corpus-level BM25 statistics in the meta table.
 *
 * Instead of a full `SELECT COUNT(*), AVG(token_count) FROM chunks` scan
 * (which took 104s on a 16 GB database), we maintain running totals and
 * apply deltas from the current flush batch.
 *
 * Falls back to a full recount if the stored totals are missing (first flush
 * or after a schema migration).
 */
export function updateCorpusStats(
  db: SiloDatabase,
  delta?: { addedChunks: number; addedTokenSum: number; removedChunks: number; removedTokenSum: number },
): void {
  const upsert = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');

  if (delta) {
    // Try incremental path — read existing totals from meta
    const countRow = db.prepare("SELECT value FROM meta WHERE key = 'corpus_chunk_count'").get() as { value: string } | undefined;
    const sumRow = db.prepare("SELECT value FROM meta WHERE key = 'corpus_total_token_count'").get() as { value: string } | undefined;

    if (countRow && sumRow) {
      const oldCount = parseInt(countRow.value, 10);
      const oldSum = parseInt(sumRow.value, 10);
      const newCount = Math.max(0, oldCount + delta.addedChunks - delta.removedChunks);
      const newSum = Math.max(0, oldSum + delta.addedTokenSum - delta.removedTokenSum);
      const newAvg = newCount > 0 ? newSum / newCount : 0;

      upsert.run('corpus_chunk_count', String(newCount));
      upsert.run('corpus_total_token_count', String(newSum));
      upsert.run('corpus_avg_token_count', String(newAvg));
      return;
    }
    // Fall through to full scan if meta keys are missing
  }

  // Full scan fallback (first flush or missing meta keys)
  const stats = db.prepare(
    'SELECT COUNT(*) AS cnt, COALESCE(SUM(token_count), 0) AS total_tc FROM chunks',
  ).get() as { cnt: number; total_tc: number };

  upsert.run('corpus_chunk_count', String(stats.cnt));
  upsert.run('corpus_total_token_count', String(stats.total_tc));
  upsert.run('corpus_avg_token_count', String(stats.cnt > 0 ? stats.total_tc / stats.cnt : 0));
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
