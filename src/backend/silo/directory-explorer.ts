/**
 * Directory exploration for a single silo.
 *
 * Owns the path-translation glue around the store's directory queries:
 * empty-query short-circuit (return the silo's configured roots, synthesised
 * from `expandTree` results), `startPath` translation between absolute
 * filesystem paths and stored keys (`{dirIndex}:{relPath}/`), and resolution
 * of stored keys back to absolute paths in the result tree (dirPath,
 * children, files).
 *
 * Why this exists: extracted from `SiloManager` as a pure path-translation
 * collaborator. The store's `directorySearch`, `expandTree`, and
 * `getFilesInDirectory` already cover the per-silo query mechanics; this
 * class is just the silo's view of "absolute paths in, absolute paths out"
 * with the empty-query branch handled.
 *
 * `getDirectories()` is a getter, not a snapshot, because the silo's
 * configured directories can be hot-swapped via the config store
 * (`updateIgnorePatterns` etc.). The explorer must read the current array
 * at call time.
 */

import path from 'node:path';
import type { StoreFacade } from '../store-facade';
import type {
  DirectorySearchParams,
  SiloDirectorySearchResult,
} from '../directory-search';
import { makeStoredDirKey, resolveStoredKey } from '../store/paths';
import type { DirectoryTreeNode } from '../../shared/types';

export class DirectoryExplorer {
  constructor(
    private readonly siloId: string,
    private readonly store: StoreFacade,
    private readonly getDirectories: () => string[],
  ) {}

  /**
   * Explore the silo's directory tree.
   *
   *   - empty query + no startPath  → synthesise root results from expandTree
   *   - otherwise                   → directorySearch with stored-key startPath
   */
  async explore(params: DirectorySearchParams): Promise<SiloDirectorySearchResult[]> {
    const isEmptyQuery = !params.query || params.query.trim().length === 0;
    if (isEmptyQuery && !params.startPath) {
      return this.exploreRoots(params.maxDepth ?? 2, params.fullContents);
    }

    const directories = this.getDirectories();
    const resolvedParams = { ...params };
    if (params.startPath) {
      const key = makeStoredDirKey(params.startPath, directories);
      if (key) {
        resolvedParams.startPath = key;
      } else {
        // startPath may be a silo root or already a stored key
        const rootIdx = directories.indexOf(params.startPath);
        if (rootIdx >= 0) {
          resolvedParams.startPath = `${rootIdx}:`;
        }
        // Otherwise pass through as-is (may already be a stored key)
      }
    }
    const raw = await this.store.directorySearch(this.siloId, resolvedParams);
    return this.resolvePaths(raw);
  }

  /** Synthesise explore results for the silo's configured root directories. */
  private async exploreRoots(
    maxDepth: number,
    fullContents?: boolean,
  ): Promise<SiloDirectorySearchResult[]> {
    const directories = this.getDirectories();
    const results: SiloDirectorySearchResult[] = [];

    for (let i = 0; i < directories.length; i++) {
      const absPath = directories[i];
      const prefix = `${i}:`;

      const [rawChildren, rawFiles] = await Promise.all([
        this.store.expandTree(this.siloId, prefix, 0, maxDepth, fullContents),
        fullContents
          ? this.store.getFilesInDirectory(this.siloId, prefix)
          : Promise.resolve(undefined),
      ]);

      results.push({
        dirPath: absPath,
        dirName: path.basename(absPath),
        score: 1.0,
        scoreSource: 'segment' as const,
        axes: {
          segment: {
            best: 0,
            bestSignal: 'levenshtein',
            signals: { levenshtein: 0, tokenCoverage: 0 },
          },
        },
        fileCount: rawFiles?.length ?? 0,
        subdirCount: rawChildren.length,
        depth: 0,
        children: resolveTreeNodes(rawChildren, directories),
        files: rawFiles?.map((f: { filePath: string; fileName: string }) => ({
          filePath: resolveStoredKey(f.filePath, directories),
          fileName: f.fileName,
        })),
      });
    }

    return results;
  }

  /** Resolve stored-key paths in directorySearch results back to absolute paths. */
  private resolvePaths(results: SiloDirectorySearchResult[]): SiloDirectorySearchResult[] {
    const directories = this.getDirectories();
    return results.map((r) => ({
      ...r,
      dirPath: resolveStoredKey(r.dirPath, directories),
      children: resolveTreeNodes(r.children, directories),
      files: r.files?.map((f) => ({
        filePath: resolveStoredKey(f.filePath, directories),
        fileName: f.fileName,
      })),
    }));
  }
}

/** Recursively resolve stored-key paths in a directory tree to absolute paths. */
function resolveTreeNodes(
  nodes: DirectoryTreeNode[],
  directories: string[],
): DirectoryTreeNode[] {
  return nodes.map((n) => ({
    ...n,
    path: resolveStoredKey(n.path, directories as string[]),
    children: resolveTreeNodes(n.children, directories),
    files: n.files?.map((f) => ({
      filePath: resolveStoredKey(f.filePath, directories as string[]),
      fileName: f.fileName,
    })),
  }));
}
