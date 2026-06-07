/**
 * Filesystem utilities — generic helpers for path resolution and traversal.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Walk upward from `startDir` looking for a file at the given relative path.
 * Returns the absolute path, or null if not found within `maxDepth` levels.
 *
 * Useful for resolving files in node_modules from code whose own location
 * relative to the project root varies (vitest vs bundler output vs source).
 * Callers typically pass `__dirname` as `startDir`.
 */
export function walkUpForFile(
  startDir: string,
  relPath: string,
  maxDepth = 10,
): string | null {
  let dir = startDir;
  for (let i = 0; i < maxDepth; i++) {
    const candidate = path.join(dir, relPath);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
