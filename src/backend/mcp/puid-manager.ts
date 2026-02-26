/**
 * Session-scoped puid (persistent unique ID) tracking.
 *
 * Puids are short references (r1, r2, d1, d2, m5) assigned during a session
 * to make it easy for LLMs to refer to files, directories, and memories.
 *
 * Two monotonic counters — never reset during a session:
 *   r1, r2, r3... for files (from search results and explore file listings)
 *   d1, d2, d3... for directories (from explore results)
 *
 * Memory m-prefixed IDs (m1, m5) use the database primary key directly —
 * no session-scoped counters or maps needed.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Structured record stored for each puid.
 *
 * The contentHash is computed lazily — not at puid assignment time during
 * search or explore, but on the first lodestone_read or lodestone_edit call
 * that targets the puid. This avoids reading and hashing every file during
 * explore calls that may list hundreds of files.
 */
export interface PuidRecord {
  /** Absolute filesystem path. */
  filepath: string;
  /** SHA-256 hex digest of the file's raw bytes, computed lazily on first read/edit. Undefined for directories. */
  contentHash?: string;
  /** True if this puid has been invalidated by a move or delete. */
  invalidated?: boolean;
  /** Original path before invalidation, for error messages. */
  invalidatedPath?: string;
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

/** Strip trailing path separators for consistent map keys. */
function normaliseDirPath(p: string): string {
  return p.replace(/[\\/]+$/, '');
}

export class PuidManager {
  private rCounter = 0;
  private dCounter = 0;
  private readonly puidMap = new Map<string, PuidRecord>();     // puid → record
  private readonly filePathToPuid = new Map<string, string>();   // absolute file path → r-puid
  private readonly dirPathToPuid_ = new Map<string, string>();   // normalised dir path → d-puid

  assignFilePuid(filePath: string): string {
    const existing = this.filePathToPuid.get(filePath);
    if (existing) return existing;
    this.rCounter++;
    const puid = `r${this.rCounter}`;
    this.puidMap.set(puid, { filepath: filePath });
    this.filePathToPuid.set(filePath, puid);
    return puid;
  }

  assignDirPuid(dirPath: string): string {
    const key = normaliseDirPath(dirPath);
    const existing = this.dirPathToPuid_.get(key);
    if (existing) return existing;
    this.dCounter++;
    const puid = `d${this.dCounter}`;
    this.puidMap.set(puid, { filepath: dirPath });
    this.dirPathToPuid_.set(key, puid);
    return puid;
  }

  /**
   * Resolve a puid to its record, checking for invalidation.
   * Returns the PuidRecord, an error object, or undefined for unknown puids.
   */
  resolvePuidRecord(id: string): PuidRecord | { error: string } | undefined {
    const record = this.puidMap.get(id);
    if (!record) return undefined;
    if (record.invalidated) {
      return {
        error: `Puid ${id} has been invalidated. The file at ${record.invalidatedPath} was moved or deleted. Search again to obtain a fresh reference.`,
      };
    }
    return record;
  }

  /**
   * Resolve a puid to its filepath, falling back to treating the id as a literal path.
   * Does NOT check invalidation — use resolvePuidRecord for puid-addressed operations.
   */
  resolvePuid(id: string): string {
    const record = this.puidMap.get(id);
    return record ? record.filepath : id;
  }

  /** Get the raw PuidRecord for a puid (no invalidation check). */
  getRecord(id: string): PuidRecord | undefined {
    return this.puidMap.get(id);
  }

  /** Look up the d-puid for a normalised directory path (for parent breadcrumbs). */
  lookupDirPuid(dirPath: string): string | undefined {
    return this.dirPathToPuid_.get(dirPath);
  }

  /** Mark a single puid as invalidated (direct invalidation after move/delete). */
  invalidatePuid(puid: string): void {
    const record = this.puidMap.get(puid);
    if (record) {
      record.invalidated = true;
      record.invalidatedPath = record.filepath;
    }
  }

  /** Scan all puids for records matching a filepath and invalidate them (path-scan). */
  invalidateByPath(sourcePath: string): void {
    const resolved = path.resolve(sourcePath);
    for (const [, record] of this.puidMap) {
      if (!record.invalidated && path.resolve(record.filepath) === resolved) {
        record.invalidated = true;
        record.invalidatedPath = record.filepath;
      }
    }
    // Remove from reverse lookup
    this.filePathToPuid.delete(sourcePath);
  }

  /** Invalidate all puids whose paths fall under a directory (prefix-scan for directory move/delete). */
  invalidateByPathPrefix(dirPath: string): void {
    const resolved = path.resolve(dirPath);
    const prefix = resolved + path.sep;
    for (const [, record] of this.puidMap) {
      if (!record.invalidated) {
        const rp = path.resolve(record.filepath);
        if (rp === resolved || rp.startsWith(prefix)) {
          record.invalidated = true;
          record.invalidatedPath = record.filepath;
        }
      }
    }
    // Clean reverse lookups
    for (const [fp] of this.filePathToPuid) {
      const rp = path.resolve(fp);
      if (rp === resolved || rp.startsWith(prefix)) this.filePathToPuid.delete(fp);
    }
    for (const [dp] of this.dirPathToPuid_) {
      const rp = path.resolve(dp);
      if (rp === resolved || rp.startsWith(prefix)) this.dirPathToPuid_.delete(dp);
    }
  }

  // ── Static helpers (pure logic, no state) ──

  static isDirPuid(id: string): boolean {
    return /^d\d+$/.test(id);
  }

  static isMemoryPuid(id: string): boolean {
    return /^m\d+$/.test(id);
  }

  /** Extract the memory DB primary key from an m-prefixed puid (e.g. "m5" → 5). */
  static parseMemoryId(id: string): number {
    return parseInt(id.slice(1), 10);
  }

  /** Resolve a memory id parameter that may be a number or m-prefixed string. */
  static resolveMemoryIdParam(id: number | string): number {
    if (typeof id === 'number') return id;
    if (PuidManager.isMemoryPuid(id)) return PuidManager.parseMemoryId(id);
    throw new Error(`Invalid memory id "${id}". Expected a number or m-prefixed id (e.g. "m5").`);
  }

  /** Compute SHA-256 hex digest of a file's raw bytes. */
  static computeFileHash(filepath: string): string {
    const buffer = fs.readFileSync(filepath);
    return createHash('sha256').update(buffer).digest('hex');
  }

  /** Return the MIME type if the file is an image, or null for text files. */
  static imageMimeType(filePath: string): string | null {
    return IMAGE_MIME[path.extname(filePath).toLowerCase()] ?? null;
  }
}
