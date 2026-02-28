/**
 * In-memory term→id cache for the V2 inverted index.
 *
 * The V1 write bottleneck was per-term INSERT OR CONFLICT into the terms
 * table B-tree (~600 SQL statements per chunk). The TermCache eliminates
 * this by resolving term→id in O(1) via a Map, only hitting SQLite for
 * genuinely new terms.
 *
 * Memory footprint: ~5-10 MB for 100K unique terms (typical for a 50K file silo).
 * One TermCache instance per silo, lives in the store worker thread.
 */

import type { SiloDatabase } from './types';

export class TermCache {
  private termToId = new Map<string, number>();

  /**
   * Warm the cache from the database. Call once when the silo DB is opened.
   * Loads all existing terms into memory for O(1) lookups.
   */
  warmFromDb(db: SiloDatabase): void {
    this.termToId.clear();
    const rows = db.prepare('SELECT id, term FROM terms').all() as Array<{ id: number; term: string }>;
    for (const row of rows) {
      this.termToId.set(row.term, row.id);
    }
  }

  /**
   * Get the integer ID for a term, inserting into the DB if it doesn't exist.
   * Cache hit: O(1). Cache miss: one INSERT + cache update.
   */
  getOrInsert(db: SiloDatabase, term: string): number {
    const cached = this.termToId.get(term);
    if (cached !== undefined) return cached;

    // Try to insert — if it already exists (race or cache miss), SELECT it
    const result = db.prepare(
      'INSERT OR IGNORE INTO terms (term, doc_freq) VALUES (?, 0)',
    ).run(term);

    let id: number;
    if (result.changes > 0) {
      id = Number(result.lastInsertRowid);
    } else {
      const row = db.prepare('SELECT id FROM terms WHERE term = ?').get(term) as { id: number };
      id = row.id;
    }

    this.termToId.set(term, id);
    return id;
  }

  /**
   * Bulk-resolve term IDs for a set of terms. More efficient than calling
   * getOrInsert() one at a time when many terms are new.
   */
  resolveAll(db: SiloDatabase, terms: Iterable<string>): Map<string, number> {
    const result = new Map<string, number>();
    const toInsert: string[] = [];

    for (const term of terms) {
      const cached = this.termToId.get(term);
      if (cached !== undefined) {
        result.set(term, cached);
      } else {
        toInsert.push(term);
      }
    }

    if (toInsert.length > 0) {
      const insertStmt = db.prepare(
        'INSERT OR IGNORE INTO terms (term, doc_freq) VALUES (?, 0)',
      );
      for (const term of toInsert) {
        insertStmt.run(term);
      }

      // Now SELECT all the newly inserted terms in one go
      const selectStmt = db.prepare('SELECT id FROM terms WHERE term = ?');
      for (const term of toInsert) {
        const row = selectStmt.get(term) as { id: number };
        this.termToId.set(term, row.id);
        result.set(term, row.id);
      }
    }

    return result;
  }

  /**
   * Remove terms with doc_freq <= 0 from both the database and the cache.
   * Call after a batch flush that involved deletions.
   */
  removeZeroFreq(db: SiloDatabase): void {
    const removed = db.prepare(
      'DELETE FROM terms WHERE doc_freq <= 0 RETURNING term',
    ).all() as Array<{ term: string }>;

    for (const row of removed) {
      this.termToId.delete(row.term);
    }
  }

  /** Number of cached terms. */
  get size(): number {
    return this.termToId.size;
  }

  /** Clear the cache (e.g. on silo close). */
  clear(): void {
    this.termToId.clear();
  }
}
