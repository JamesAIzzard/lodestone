/**
 * Lightweight readonly DB access for stopped silos and wizard reconnection.
 *
 * These functions run on the main thread (not the store worker) and open
 * temporary readonly connections. They don't need the sqlite-vec extension
 * since they only read metadata tables.
 */

import Database from 'better-sqlite3';
import type { SiloMeta, StoredSiloConfig } from './types';
import { SCHEMA_VERSION } from './types';

/**
 * Peek at the file count in a silo database without fully opening it.
 * Opens a lightweight readonly connection — no sqlite-vec extension needed.
 * Returns 0 if the database doesn't exist or the table is missing.
 */
export function peekFileCount(dbPath: string): number {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare(
        'SELECT COUNT(*) as cnt FROM files WHERE mtime_ms IS NOT NULL',
      ).get() as { cnt: number };
      return row.cnt;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

/**
 * Open a database file read-only, read the config blob and meta, then close it.
 * Used by the wizard to peek at stored config when reconnecting an existing DB.
 * Does not load sqlite-vec since we only read the meta table.
 */
export function readConfigFromDbFile(dbPath: string): {
  config: StoredSiloConfig | null;
  meta: SiloMeta | null;
} | null {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare('SELECT key, value FROM meta').all() as Array<{
        key: string;
        value: string;
      }>;

      let meta: SiloMeta | null = null;
      let config: StoredSiloConfig | null = null;

      if (rows.length > 0) {
        const map = new Map(rows.map((r) => [r.key, r.value]));
        const model = map.get('model');
        const dimensions = map.get('dimensions');

        if (model && dimensions) {
          meta = {
            model,
            dimensions: parseInt(dimensions, 10),
            createdAt: map.get('createdAt') ?? new Date().toISOString(),
            version: parseInt(map.get('version') ?? String(SCHEMA_VERSION), 10),
          };
        }

        const configJson = map.get('config');
        if (configJson) {
          try {
            config = JSON.parse(configJson) as StoredSiloConfig;
          } catch {
            // Malformed config — ignore
          }
        }
      }

      return { config, meta };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
