/**
 * Unit tests for DirectoryExplorer.
 *
 * The explorer's own logic is path translation (absolute ↔ stored key) and
 * result aggregation around the store's `directorySearch` / `expandTree` /
 * `getFilesInDirectory` calls. The store-side behaviour is covered by
 * directory-search.test.ts and store.test.ts; here we use a recording stub
 * StoreFacade so the assertions stay focused on the explorer's branching
 * and on the abs-path / stored-key resolution it owns.
 *
 * Branches covered:
 *   - empty query + no startPath  → exploreRoots (expandTree per configured root)
 *   - empty query +    startPath  → directorySearch (no exploreRoots)
 *   - non-empty query             → directorySearch
 *   - startPath translation: absolute subdir → stored-dir-key,
 *                            silo root        → `${i}:`,
 *                            already a key    → pass-through
 *   - resolvePaths: stored keys in dirPath, children[].path, files[].filePath
 *     all become absolute paths under the right configured root
 */

import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import type { StoreFacade } from '../store-facade';
import type {
  DirectorySearchParams,
  SiloDirectorySearchResult,
} from '../directory-search';
import type { DirectoryTreeNode, SearchParams } from '../../shared/types';
import type {
  FlushUpsert, FlushDelete, FlushResult,
  SiloMeta, StoredSiloConfig, DirEntry,
} from '../store/types';
import type { ActivityRow } from '../store/operations';
import type { FileResult } from '../search';
import { DirectoryExplorer } from './directory-explorer';

const SILO = 'explorer-test';

// ── Recording stub StoreFacade ───────────────────────────────────────────────

interface DirectorySearchCall {
  siloId: string;
  params: DirectorySearchParams;
}

interface ExpandTreeCall {
  siloId: string;
  rootPath: string;
  rootDepth: number;
  maxDepth: number;
  fullContents?: boolean;
}

interface GetFilesCall {
  siloId: string;
  dirStoredKey: string;
}

interface RecordingStore {
  facade: StoreFacade;
  directorySearchCalls: DirectorySearchCall[];
  expandTreeCalls: ExpandTreeCall[];
  getFilesInDirectoryCalls: GetFilesCall[];
  /** Set this to override the value returned by `directorySearch`. */
  directorySearchResult: SiloDirectorySearchResult[];
  /** Map from stored-key prefix → tree returned by `expandTree`. */
  expandTreeByPrefix: Map<string, DirectoryTreeNode[]>;
  /** Map from stored-key prefix → files returned by `getFilesInDirectory`. */
  filesByPrefix: Map<string, Array<{ filePath: string; fileName: string }>>;
}

function unimplemented(name: string): () => never {
  return () => { throw new Error(`stub StoreFacade: ${name} not implemented`); };
}

function createRecordingStore(): RecordingStore {
  const directorySearchCalls: DirectorySearchCall[] = [];
  const expandTreeCalls: ExpandTreeCall[] = [];
  const getFilesInDirectoryCalls: GetFilesCall[] = [];
  const expandTreeByPrefix = new Map<string, DirectoryTreeNode[]>();
  const filesByPrefix = new Map<string, Array<{ filePath: string; fileName: string }>>();
  const recording: Omit<RecordingStore, 'facade'> = {
    directorySearchCalls,
    expandTreeCalls,
    getFilesInDirectoryCalls,
    directorySearchResult: [],
    expandTreeByPrefix,
    filesByPrefix,
  };
  const facade: StoreFacade = {
    open: unimplemented('open') as StoreFacade['open'],
    close: unimplemented('close') as StoreFacade['close'],
    flush: unimplemented('flush') as StoreFacade['flush'],
    loadMtimes: unimplemented('loadMtimes') as StoreFacade['loadMtimes'],
    setMtime: unimplemented('setMtime') as StoreFacade['setMtime'],
    deleteMtime: unimplemented('deleteMtime') as StoreFacade['deleteMtime'],
    loadMeta: unimplemented('loadMeta') as StoreFacade['loadMeta'],
    saveMeta: unimplemented('saveMeta') as StoreFacade['saveMeta'],
    saveConfigBlob: unimplemented('saveConfigBlob') as StoreFacade['saveConfigBlob'],
    loadActivity: unimplemented('loadActivity') as StoreFacade['loadActivity'],
    logActivity: unimplemented('logActivity') as StoreFacade['logActivity'],
    getChunkCount: unimplemented('getChunkCount') as StoreFacade['getChunkCount'],
    checkpoint: unimplemented('checkpoint') as StoreFacade['checkpoint'],
    vacuum: unimplemented('vacuum') as StoreFacade['vacuum'],
    search: unimplemented('search') as StoreFacade['search'],
    insertDirEntry: unimplemented('insertDirEntry') as StoreFacade['insertDirEntry'],
    deleteDirEntry: unimplemented('deleteDirEntry') as StoreFacade['deleteDirEntry'],
    syncDirectoriesWithDisk: unimplemented('syncDirectoriesWithDisk') as StoreFacade['syncDirectoriesWithDisk'],
    recomputeDirectoryCounts: unimplemented('recomputeDirectoryCounts') as StoreFacade['recomputeDirectoryCounts'],
    async directorySearch(siloId, params) {
      directorySearchCalls.push({ siloId, params });
      return recording.directorySearchResult;
    },
    async expandTree(siloId, rootPath, rootDepth, maxDepth, fullContents) {
      expandTreeCalls.push({ siloId, rootPath, rootDepth, maxDepth, fullContents });
      return expandTreeByPrefix.get(rootPath) ?? [];
    },
    async getFilesInDirectory(siloId, dirStoredKey) {
      getFilesInDirectoryCalls.push({ siloId, dirStoredKey });
      return filesByPrefix.get(dirStoredKey) ?? [];
    },
  };
  return Object.assign(recording, { facade }) as RecordingStore;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const ROOT_A = path.resolve('/tmp/silo-A');
const ROOT_B = path.resolve('/tmp/silo-B');

function treeNode(p: string, name: string, children: DirectoryTreeNode[] = []): DirectoryTreeNode {
  return { name, path: p, fileCount: 0, subdirCount: children.length, children };
}

function searchResult(
  dirPath: string,
  children: DirectoryTreeNode[] = [],
  files?: Array<{ filePath: string; fileName: string }>,
): SiloDirectorySearchResult {
  return {
    dirPath,
    dirName: dirPath.split('/').pop() ?? dirPath,
    score: 0.9,
    scoreSource: 'segment',
    axes: { segment: { best: 0.9, bestSignal: 'levenshtein', signals: { levenshtein: 0.9 } } },
    fileCount: files?.length ?? 0,
    subdirCount: children.length,
    depth: 1,
    children,
    files,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

let store: RecordingStore;
let directories: string[];
let explorer: DirectoryExplorer;

beforeEach(() => {
  store = createRecordingStore();
  directories = [ROOT_A, ROOT_B];
  explorer = new DirectoryExplorer(SILO, store.facade, () => directories);
});

describe('DirectoryExplorer — empty query + no startPath (exploreRoots)', () => {
  it('synthesises one result per configured root, calling expandTree for each', async () => {
    store.expandTreeByPrefix.set('0:', [treeNode('0:src/', 'src')]);
    store.expandTreeByPrefix.set('1:', []);

    const out = await explorer.explore({ maxDepth: 3 });

    expect(store.directorySearchCalls).toEqual([]);
    expect(store.expandTreeCalls.map((c) => c.rootPath)).toEqual(['0:', '1:']);
    expect(store.expandTreeCalls[0]).toMatchObject({
      siloId: SILO,
      rootDepth: 0,
      maxDepth: 3,
    });
    expect(out).toHaveLength(2);
    expect(out[0].dirPath).toBe(ROOT_A);
    expect(out[0].dirName).toBe(path.basename(ROOT_A));
    expect(out[0].depth).toBe(0);
    expect(out[0].subdirCount).toBe(1);
    expect(out[1].dirPath).toBe(ROOT_B);
  });

  it('defaults maxDepth to 2 when not given', async () => {
    await explorer.explore({});
    expect(store.expandTreeCalls[0].maxDepth).toBe(2);
  });

  it('skips getFilesInDirectory when fullContents is not set', async () => {
    await explorer.explore({});
    expect(store.getFilesInDirectoryCalls).toEqual([]);
    expect(store.expandTreeCalls.every((c) => c.fullContents === undefined || c.fullContents === false)).toBe(true);
  });

  it('calls getFilesInDirectory per root when fullContents is true and resolves file paths', async () => {
    store.filesByPrefix.set('0:', [{ filePath: '0:README.md', fileName: 'README.md' }]);
    store.filesByPrefix.set('1:', []);

    const out = await explorer.explore({ fullContents: true });

    expect(store.getFilesInDirectoryCalls.map((c) => c.dirStoredKey)).toEqual(['0:', '1:']);
    expect(out[0].fileCount).toBe(1);
    expect(out[0].files).toEqual([{ filePath: path.join(ROOT_A, 'README.md'), fileName: 'README.md' }]);
    expect(out[1].fileCount).toBe(0);
    expect(out[1].files).toEqual([]);
  });

  it('resolves stored-key paths in nested children to absolute paths', async () => {
    store.expandTreeByPrefix.set('0:', [
      treeNode('0:src/', 'src', [treeNode('0:src/backend/', 'backend')]),
    ]);
    store.expandTreeByPrefix.set('1:', []);

    const out = await explorer.explore({ maxDepth: 5 });

    expect(out[0].children[0].path).toBe(path.join(ROOT_A, 'src/'));
    expect(out[0].children[0].children[0].path).toBe(path.join(ROOT_A, 'src/backend/'));
  });

  it('returns an empty array when there are no configured directories', async () => {
    directories = [];
    const out = await explorer.explore({});
    expect(out).toEqual([]);
    expect(store.expandTreeCalls).toEqual([]);
  });
});

describe('DirectoryExplorer — startPath translation', () => {
  it('translates an absolute subdirectory path to a stored dir-key', async () => {
    const startAbs = path.join(ROOT_A, 'src/backend');
    await explorer.explore({ query: 'foo', startPath: startAbs });

    expect(store.directorySearchCalls).toHaveLength(1);
    expect(store.directorySearchCalls[0].params.startPath).toBe('0:src/backend/');
    // exploreRoots must NOT be called for non-empty query.
    expect(store.expandTreeCalls).toEqual([]);
  });

  it('translates a silo root absolute path to "{i}:"', async () => {
    await explorer.explore({ query: 'foo', startPath: ROOT_B });
    expect(store.directorySearchCalls[0].params.startPath).toBe('1:');
  });

  it('passes through a startPath that is already a stored key', async () => {
    await explorer.explore({ query: 'foo', startPath: '0:src/' });
    expect(store.directorySearchCalls[0].params.startPath).toBe('0:src/');
  });

  it('uses directorySearch (not exploreRoots) when query is empty but startPath is set', async () => {
    await explorer.explore({ startPath: ROOT_A });
    expect(store.directorySearchCalls).toHaveLength(1);
    expect(store.directorySearchCalls[0].params.startPath).toBe('0:');
    expect(store.expandTreeCalls).toEqual([]);
  });

  it('passes other params through unchanged', async () => {
    await explorer.explore({
      query: 'foo',
      startPath: path.join(ROOT_A, 'src'),
      maxDepth: 5,
      maxResults: 7,
      fullContents: true,
    });
    expect(store.directorySearchCalls[0].params).toMatchObject({
      query: 'foo',
      startPath: '0:src/',
      maxDepth: 5,
      maxResults: 7,
      fullContents: true,
    });
  });
});

describe('DirectoryExplorer — resolvePaths on directorySearch results', () => {
  it('resolves stored-key dirPath, children paths, and file paths to absolute paths', async () => {
    store.directorySearchResult = [
      searchResult(
        '0:src/backend/',
        [treeNode('0:src/backend/foo/', 'foo')],
        [{ filePath: '0:src/backend/index.ts', fileName: 'index.ts' }],
      ),
      searchResult(
        '1:notes/',
        [],
        [{ filePath: '1:notes/2025-01.md', fileName: '2025-01.md' }],
      ),
    ];

    const out = await explorer.explore({ query: 'foo' });

    expect(out[0].dirPath).toBe(path.join(ROOT_A, 'src/backend/'));
    expect(out[0].children[0].path).toBe(path.join(ROOT_A, 'src/backend/foo/'));
    expect(out[0].files).toEqual([
      { filePath: path.join(ROOT_A, 'src/backend/index.ts'), fileName: 'index.ts' },
    ]);
    expect(out[1].dirPath).toBe(path.join(ROOT_B, 'notes/'));
    expect(out[1].files).toEqual([
      { filePath: path.join(ROOT_B, 'notes/2025-01.md'), fileName: '2025-01.md' },
    ]);
  });

  it('preserves score/scoreSource/axes/depth on resolved results', async () => {
    store.directorySearchResult = [searchResult('0:src/')];
    const out = await explorer.explore({ query: 'src' });
    expect(out[0]).toMatchObject({
      score: 0.9,
      scoreSource: 'segment',
      depth: 1,
    });
    expect(out[0].axes.segment.best).toBe(0.9);
  });
});
