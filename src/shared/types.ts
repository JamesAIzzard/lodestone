import type { SiloColor, SiloIconName } from './silo-appearance';

// ── Silo ──────────────────────────────────────────────────────────────────────

export interface SiloConfig {
  name: string;
  directories: string[];
  extensions: string[];
  ignorePatterns: string[];
  ignoreFilePatterns: string[];
  /** True when this silo has explicit folder ignore overrides */
  hasIgnoreOverride: boolean;
  /** True when this silo has explicit file ignore overrides */
  hasFileIgnoreOverride: boolean;
  /** True when this silo has explicit extension overrides */
  hasExtensionOverride: boolean;
  modelOverride: string | null;
  dbPath: string;
  /** Human-readable description of what this silo contains */
  description: string;
  /** Named palette colour key */
  color: SiloColor;
  /** Lucide icon name */
  icon: SiloIconName;
}

export type WatcherState = 'ready' | 'indexing' | 'error' | 'stopped' | 'waiting';

export interface SiloStatus {
  config: SiloConfig;
  indexedFileCount: number;
  chunkCount: number;
  lastUpdated: string | null;
  databaseSizeBytes: number;
  watcherState: WatcherState;
  errorMessage?: string;
  /** Reconciliation / indexing progress (only present while indexing) */
  reconcileProgress?: {
    current: number;
    total: number;
  };
  /** True when the configured model differs from the model that built the index */
  modelMismatch?: boolean;
  /** Absolute path to the silo's SQLite database file */
  resolvedDbPath: string;
  /** The effective embedding model for this silo (global default or per-silo override) */
  resolvedModel: string;
}

// ── Search (Two-Axis Model) ──────────────────────────────────────────────────

/** Per-chunk score breakdown: semantic and BM25 sub-scores, plus the winning scorer. */
export interface ChunkScore {
  /** Cosine similarity to query vector [0,1]. */
  semantic: number;
  /** Normalised BM25 score [0,1]. */
  bm25: number;
  /** max(semantic, bm25) — the chunk's content score. */
  best: number;
  /** Which scorer produced the best score. */
  bestScorer: 'semantic' | 'bm25';
}

export interface SearchResultChunk {
  sectionPath: string[];
  text: string;
  startLine: number;
  endLine: number;
  /** Per-scorer breakdown for this chunk. */
  scores: ChunkScore;
}

/** What drove this file's ranking score: a filename/path match or content signals. */
export type ScoreSource = 'content' | 'filename';

export interface SearchResult {
  filePath: string;
  siloName: string;
  /** Overall file score: max(contentScore, filenameScore) [0,1]. */
  score: number;
  /** Which axis drove the file's ranking. */
  scoreSource: ScoreSource;
  /** Best chunk content score across all chunks. */
  contentScore: number;
  /** Levenshtein filename similarity [0,1] (0 if no filename match). */
  filenameScore: number;
  /** Top chunks sorted by content score descending. */
  chunks: SearchResultChunk[];
}

// ── Directory Exploration ────────────────────────────────────────────────

/** A file entry returned as part of a fullContents explore. */
export interface DirectoryFileEntry {
  /** Absolute filesystem path of the file */
  filePath: string;
  /** File basename */
  fileName: string;
}

export interface DirectoryTreeNode {
  /** Leaf directory name */
  name: string;
  /** Absolute filesystem path of this directory */
  path: string;
  /** Files directly in this directory */
  fileCount: number;
  /** Immediate subdirectory count */
  subdirCount: number;
  /** Nested children (empty if at maxDepth) */
  children: DirectoryTreeNode[];
  /** Files directly inside this directory (only present when fullContents=true) */
  files?: DirectoryFileEntry[];
}

/** What drove a directory's ranking: a segment name match or keyword coverage. */
export type DirectoryScoreSource = 'segment' | 'keyword';

export interface DirectoryResult {
  /** Absolute filesystem path of the matched directory */
  dirPath: string;
  /** Leaf directory name */
  dirName: string;
  /** Silo this directory belongs to */
  siloName: string;
  /** Overall directory score: max(segmentScore, keywordScore) [0,1]. */
  score: number;
  /** Which axis drove the directory's ranking. */
  scoreSource: DirectoryScoreSource;
  /** Best path-segment Levenshtein similarity [0,1]. */
  segmentScore: number;
  /** Path token coverage score [0,1]. */
  keywordScore: number;
  /** Number of files directly in this directory */
  fileCount: number;
  /** Number of immediate subdirectories */
  subdirCount: number;
  /** Depth from silo root */
  depth: number;
  /** Tree of children, populated to maxDepth levels */
  children: DirectoryTreeNode[];
  /** Files directly inside this directory (only present when fullContents=true) */
  files?: DirectoryFileEntry[];
}

export interface ExploreParams {
  query?: string;
  silo?: string;
  startPath?: string;
  maxDepth?: number;
  maxResults?: number;
  /** When true, include file listings in results. Defaults to true when startPath is provided. */
  fullContents?: boolean;
}

// ── Search Params ─────────────────────────────────────────────────────────────

/** Controls which scoring signals are used for a search. */
export type SearchMode = 'hybrid' | 'bm25' | 'semantic' | 'regex';

export interface SearchParams {
  query: string;
  /** Search mode. Default: 'hybrid' (vector + BM25, Levenshtein filename). */
  mode?: SearchMode;
  /** Glob pattern to filter results to matching file paths (e.g. "*.ts" or "src/**"). */
  filePattern?: string;
  /** JavaScript regex flags for regex mode (default: 'i'). */
  regexFlags?: string;
  /** Filter results to files under this directory path (already resolved to stored key by silo-manager). */
  startPath?: string;
  /** Maximum results to return. Default: 10. */
  limit?: number;
}

// ── Activity ──────────────────────────────────────────────────────────────────

export type ActivityEventType = 'indexed' | 'reindexed' | 'deleted' | 'error' | 'dir-added' | 'dir-removed';

export interface ActivityEvent {
  id: string;
  timestamp: string;
  siloName: string;
  filePath: string;
  eventType: ActivityEventType;
  errorMessage?: string;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

export interface DefaultSettings {
  extensions: string[];
  ignore: string[];
  ignoreFiles: string[];
  debounce: number;
  /** Number of surrounding lines in post-edit confirmation snippets */
  contextLines: number;
}

// ── Memory ────────────────────────────────────────────────────────────────────

export interface MemoryRecord {
  id: number;
  topic: string;
  body: string;
  confidence: number;
  contextHint: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySearchResult extends MemoryRecord {
  score: number;
}

export interface MemoryStatus {
  connected: boolean;
  dbPath: string | null;
  memoryCount: number;
  databaseSizeBytes: number;
}

// ── Server ────────────────────────────────────────────────────────────────────

export type OllamaConnectionState = 'connected' | 'disconnected' | 'not-installed';

export interface ServerStatus {
  uptimeSeconds: number;
  ollamaState: OllamaConnectionState;
  ollamaUrl: string;
  availableModels: string[];
  defaultModel: string;
  totalIndexedFiles: number;
  /** Maps model registry key → path-safe ID for use in auto-generated filenames */
  modelPathSafeIds: Record<string, string>;
}
