/**
 * Worker thread entry point for all SQLite operations.
 *
 * Runs in a dedicated thread via worker_threads to keep the main Electron
 * process event loop free during indexing and search. Every DB operation
 * is dispatched here — the main thread never touches SQLite.
 *
 * Unlike the embedding worker (which needs async ONNX + a serialized queue),
 * all better-sqlite3 operations are synchronous. Messages are processed one
 * at a time by the Node.js event loop, providing natural serialization.
 */

import { parentPort } from 'node:worker_threads';
import type { StoreRequest, StoreResponse, FlushUpsert, FlushDelete, SiloDatabase, StoredSiloConfig, DirEntry } from './store/types';
import { createSiloDatabase } from './store/schema';
import { TermCache } from './store/term-cache';
import {
  flushPreparedFiles,
  loadMtimes, setMtime, deleteMtime, countMtimes,
  loadMeta, saveMeta, saveConfigBlob, loadConfigBlob,
  getChunkCount, getFileCount,
  insertDirEntry, deleteDirEntry, getFilesInDirectory,
  syncDirectoriesWithDisk, recomputeDirectoryCounts,
  insertActivityEvent, loadActivityLog,
} from './store/operations';
import { search, type FileResult } from './search';
import { directorySearchSilo, expandTree, type DirectorySearchParams, type SiloDirectorySearchResult } from './directory-search';
import type { SearchParams } from '../shared/types';

// ── Per-silo state ───────────────────────────────────────────────────────────

interface SiloState {
  db: SiloDatabase;
  termCache: TermCache;
}

const silos = new Map<string, SiloState>();

// ── Message dispatch ─────────────────────────────────────────────────────────

parentPort!.on('message', (msg: StoreRequest) => {
  const response: StoreResponse = { id: msg.id };

  try {
    response.result = dispatch(msg);
  } catch (err) {
    response.error = err instanceof Error ? err.message : String(err);
  }

  parentPort!.postMessage(response);
});

function dispatch(msg: StoreRequest): unknown {
  const { method, siloId, args } = msg;

  // ── Lifecycle methods (no existing silo state required) ──────────────

  if (method === 'open') {
    const [dbPath, dimensions] = args as [string, number];
    if (silos.has(siloId)) {
      // Already open — just return (idempotent for crash recovery)
      return undefined;
    }
    const db = createSiloDatabase(dbPath, dimensions);
    const termCache = new TermCache();
    termCache.warmFromDb(db);
    silos.set(siloId, { db, termCache });
    console.log(`[store-worker] Opened silo "${siloId}" (${termCache.size} terms cached)`);
    return undefined;
  }

  if (method === 'close') {
    const state = silos.get(siloId);
    if (!state) return undefined;
    try {
      state.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // Checkpoint failure is non-fatal
    }
    state.db.close();
    state.termCache.clear();
    silos.delete(siloId);
    console.log(`[store-worker] Closed silo "${siloId}"`);
    return undefined;
  }

  // ── All other methods require an open silo ───────────────────────────

  const state = silos.get(siloId);
  if (!state) {
    throw new Error(`Silo "${siloId}" is not open in the store worker`);
  }

  const { db, termCache } = state;

  switch (method) {
    // ── Batch write path ──────────────────────────────────────────────
    case 'flush':
      return flushPreparedFiles(
        db, termCache,
        args[0] as FlushUpsert[],
        args[1] as FlushDelete[],
      );

    // ── Mtime operations ──────────────────────────────────────────────
    case 'loadMtimes':
      return loadMtimes(db);
    case 'setMtime':
      setMtime(db, args[0] as string, args[1] as number);
      return undefined;
    case 'deleteMtime':
      deleteMtime(db, args[0] as string);
      return undefined;
    case 'countMtimes':
      return countMtimes(db);

    // ── Meta operations ───────────────────────────────────────────────
    case 'loadMeta':
      return loadMeta(db);
    case 'saveMeta':
      saveMeta(db, args[0] as string, args[1] as number);
      return undefined;
    case 'saveConfigBlob':
      saveConfigBlob(db, args[0] as StoredSiloConfig);
      return undefined;
    case 'loadConfigBlob':
      return loadConfigBlob(db);

    // ── Stats ─────────────────────────────────────────────────────────
    case 'getChunkCount':
      return getChunkCount(db);
    case 'getFileCount':
      return getFileCount(db);

    // ── Directory operations ──────────────────────────────────────────
    case 'insertDirEntry':
      return insertDirEntry(db, args[0] as string);
    case 'deleteDirEntry':
      return deleteDirEntry(db, args[0] as string);
    case 'getFilesInDirectory':
      return getFilesInDirectory(db, args[0] as string);
    case 'syncDirectoriesWithDisk':
      return syncDirectoriesWithDisk(db, args[0] as DirEntry[]);
    case 'recomputeDirectoryCounts':
      recomputeDirectoryCounts(db);
      return undefined;

    // ── Search ────────────────────────────────────────────────────────
    case 'search':
      return search(db, args[0] as number[], args[1] as SearchParams);
    case 'directorySearch':
      return directorySearchSilo(db, args[0] as DirectorySearchParams);
    case 'expandTree':
      return expandTree(
        db,
        args[0] as string,  // rootPath
        args[1] as number,  // rootDepth
        args[2] as number,  // maxDepth
        args[3] as boolean | undefined,  // fullContents
      );

    // ── Activity log ─────────────────────────────────────────────────
    case 'logActivity':
      insertActivityEvent(
        db,
        args[0] as string,        // timestamp
        args[1] as string,        // eventType
        args[2] as string,        // filePath
        args[3] as string | null, // errorMessage
        args[4] as number,        // maxRows
      );
      return undefined;
    case 'loadActivity':
      return loadActivityLog(db, args[0] as number);

    // ── Maintenance ───────────────────────────────────────────────────
    case 'checkpoint': {
      const mode = (args[0] as string | undefined) ?? 'PASSIVE';
      db.pragma(`wal_checkpoint(${mode})`);
      return undefined;
    }

    case 'vacuum': {
      db.exec('VACUUM');
      return undefined;
    }

    default:
      throw new Error(`Unknown store worker method: ${method}`);
  }
}
