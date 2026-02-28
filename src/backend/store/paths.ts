/**
 * Portable path utilities for stored keys.
 *
 * These are pure functions with no DB or worker dependency — they run on
 * both the main thread (reconcile, watcher, silo-manager path resolution)
 * and the store worker thread (operations that need path logic).
 *
 * Stored key format: "{dirIndex}:{relPath}" with forward slashes.
 *   e.g. "0:src/backend/store.ts"
 *   dirIndex = 0-based index into the silo's configured directories array
 *   relPath = relative path from that directory
 */

import path from 'node:path';
import type { DirEntry } from './types';

/**
 * Convert an absolute file path to a portable stored key.
 * Throws if the path is not under any configured directory.
 */
export function makeStoredKey(absPath: string, directories: string[]): string {
  for (let i = 0; i < directories.length; i++) {
    const rel = path.relative(directories[i], absPath);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return `${i}:${rel.replace(/\\/g, '/')}`;
    }
  }
  throw new Error(`Path not under any silo directory: ${absPath}`);
}

/**
 * Convert an absolute directory path to a stored dir-key (with trailing '/').
 * Returns null if the path is not under any configured directory or is a silo root.
 */
export function makeStoredDirKey(absDirPath: string, directories: string[]): string | null {
  for (let i = 0; i < directories.length; i++) {
    if (absDirPath === directories[i]) return null; // silo root — not tracked
    const rel = path.relative(directories[i], absDirPath);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return `${i}:${rel.replace(/\\/g, '/')}/`;
    }
  }
  return null;
}

/**
 * Resolve a stored key back to an absolute path using the silo's configured directories.
 */
export function resolveStoredKey(storedKey: string, directories: string[]): string {
  const colonIdx = storedKey.indexOf(':');
  if (colonIdx === -1) {
    console.warn(`[store] Legacy absolute path in stored key: ${storedKey}`);
    return storedKey;
  }
  const dirIndex = parseInt(storedKey.slice(0, colonIdx), 10);
  if (isNaN(dirIndex) || dirIndex < 0 || dirIndex >= directories.length) {
    console.warn(`[store] Invalid dirIndex ${dirIndex} in stored key "${storedKey}" (${directories.length} directories)`);
    return storedKey;
  }
  return path.join(directories[dirIndex], storedKey.slice(colonIdx + 1));
}

/** Extract the relative-path portion from a stored key ("{dirIndex}:{relPath}"). */
export function extractRelPath(storedKey: string): string {
  const colon = storedKey.indexOf(':');
  return colon === -1 ? storedKey : storedKey.slice(colon + 1);
}

/**
 * Extract all ancestor directory paths from a stored key.
 * e.g. "0:src/backend/chunkers/foo.ts" → [
 *   { dirPath: "0:src/", dirName: "src", depth: 1 },
 *   { dirPath: "0:src/backend/", dirName: "backend", depth: 2 },
 *   { dirPath: "0:src/backend/chunkers/", dirName: "chunkers", depth: 3 },
 * ]
 */
export function extractDirectoryPaths(storedKey: string): DirEntry[] {
  const colonIdx = storedKey.indexOf(':');
  if (colonIdx === -1) return [];

  const prefix = storedKey.slice(0, colonIdx + 1);
  const parts = storedKey.slice(colonIdx + 1).split('/');
  parts.pop(); // remove filename
  if (parts.length === 0) return [];

  const dirs: DirEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    dirs.push({
      dirPath: prefix + parts.slice(0, i + 1).join('/') + '/',
      dirName: parts[i],
      depth: i + 1,
    });
  }
  return dirs;
}

/**
 * Extract the filename from a stored key or plain path.
 * Uses forward-slash splitting since stored keys use forward slashes.
 */
export function fileBasename(storedKey: string): string {
  return storedKey.split('/').pop() ?? storedKey;
}

/**
 * Convert a glob pattern to a RegExp.
 *
 * Rules:
 *   **  → matches any sequence including path separators
 *   *   → matches any non-separator sequence
 *   ?   → matches any single non-separator character
 */
export function globToRegex(pattern: string, flags = 'i'): RegExp {
  const parts = pattern.split('**');
  const escapedParts = parts.map((part) =>
    part
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/\\\\]*')
      .replace(/\?/g, '[^/\\\\]'),
  );
  return new RegExp(escapedParts.join('.*'), flags);
}
