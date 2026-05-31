/**
 * Lightweight readonly DB access for stopped silos and wizard reconnection.
 *
 * These functions run on the main thread (not the store worker) and open
 * temporary readonly connections. They don't need the sqlite-vec extension
 * since they only read metadata tables.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import type { SiloMeta, StoredSiloConfig } from './types';
import { SCHEMA_VERSION } from './types';
import { EMBEDDING_MODEL } from '../embedding-model';

export type IndexState = 'fresh' | 'usable' | 'unusable';

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
 * Strictly classify an on-disk index before it is opened for writes.
 *
 * `fresh` means there is no usable index structure yet, so normal DB
 * creation can proceed. `usable` means the raw identity rows exactly match
 * the current bundled model and schema. Anything else is `unusable` and
 * should be deleted before opening.
 */
export function peekIndexState(dbPath: string): IndexState {
  if (!fs.existsSync(dbPath)) return 'fresh';

  try {
    const stat = fs.statSync(dbPath);
    if (stat.size === 0) return 'fresh';
  } catch {
    return 'unusable';
  }

  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const filesTable = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='files'",
      ).get();
      if (!filesTable) return 'fresh';

      const metaTable = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'",
      ).get();
      if (!metaTable) return 'unusable';

      const rows = db.prepare(
        "SELECT key, value FROM meta WHERE key IN ('version', 'model', 'dimensions')",
      ).all() as Array<{ key: string; value: string }>;
      const map = new Map(rows.map((row) => [row.key, row.value]));

      const version = map.get('version');
      const model = map.get('model');
      const dimensions = map.get('dimensions');
      if (!version || !model || !dimensions) return 'unusable';

      if (Number(version) !== SCHEMA_VERSION) return 'unusable';
      if (model !== EMBEDDING_MODEL.key) return 'unusable';
      if (Number(dimensions) !== EMBEDDING_MODEL.dimensions) return 'unusable';

      return 'usable';
    } finally {
      db.close();
    }
  } catch {
    return 'unusable';
  }
}

/**
 * Open a database file read-only, read the config blob and meta, then close it.
 * Used by the wizard to peek at stored config when reconnecting an existing DB.
 * Does not load sqlite-vec since we only read the meta table.
 *
 * Legacy blobs (written before the field-rename in commit 202ba88) used
 * snake-cased domain words instead of the present `indexed*` / `ignored*`
 * naming. {@link normalizeStoredConfig} accepts either shape so the wizard
 * can pre-fill correctly when reconnecting an older `.db` file. The blob
 * is rewritten in the current shape the next time the silo starts and
 * `configStore.persist()` runs, so this is a read-only migration.
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
            const raw = JSON.parse(configJson) as unknown;
            config = normalizeStoredConfig(raw);
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

/**
 * Coerce a parsed config blob into the current {@link StoredSiloConfig} shape.
 * Falls back to legacy keys written before commit 202ba88 ("Clarify app and
 * silo config naming") so reconnecting an older `.db` still pre-fills the
 * wizard. Returns `null` when the blob is malformed beyond rescue (e.g. an
 * array, a primitive, or missing both `name` and any directories field).
 */
function normalizeStoredConfig(raw: unknown): StoredSiloConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const blob = raw as Record<string, unknown>;

  const pickString = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = blob[k];
      if (typeof v === 'string') return v;
    }
    return undefined;
  };
  const pickStringArray = (...keys: string[]): string[] | undefined => {
    for (const k of keys) {
      const v = blob[k];
      if (Array.isArray(v) && v.every((s) => typeof s === 'string')) return v as string[];
    }
    return undefined;
  };

  const name = pickString('name');
  const indexedDirectories = pickStringArray('indexedDirectories', 'directories');
  const indexedFileExtensions = pickStringArray('indexedFileExtensions', 'extensions');
  if (!name || !indexedDirectories || !indexedFileExtensions) return null;

  return {
    name,
    contentDescription: pickString('contentDescription', 'description'),
    indexedDirectories,
    indexedFileExtensions,
    ignoredFolderPatterns: pickStringArray('ignoredFolderPatterns', 'ignore') ?? [],
    ignoredFilePatterns: pickStringArray('ignoredFilePatterns', 'ignoreFiles') ?? [],
    accentColor: pickString('accentColor', 'color'),
    iconName: pickString('iconName', 'icon'),
  };
}
