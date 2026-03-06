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
    batchChunks?: number;
    batchChunkLimit?: number;
    filePath?: string;
    fileSize?: number;
    fileStage?: string;
    elapsedMs?: number;
    /** Chunks embedded so far for the current file (only during 'embedding' stage). */
    embedDone?: number;
    /** Total chunks to embed for the current file. */
    embedTotal?: number;
  };
  /** True when the configured model differs from the model that built the index */
  modelMismatch?: boolean;
  /** Absolute path to the silo's SQLite database file */
  resolvedDbPath: string;
  /** The effective embedding model for this silo (global default or per-silo override) */
  resolvedModel: string;
}

// ── Directory Scoring Primitives ─────────────────────────────────────────────

/** Signal name → [0,1] score. */
export type SignalScores = Record<string, number>;

/** Fused result of running multiple signals through a recipe. */
export interface FusedScore {
  /** max() of all signal scores (or whatever the recipe's fuse function produces). */
  best: number;
  /** Name of the signal that produced the best score. */
  bestSignal: string;
  /** Full breakdown: { semantic: 0.82, bm25: 0.45, ... } */
  signals: SignalScores;
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

export interface DirectoryResult {
  /** Absolute filesystem path of the matched directory */
  dirPath: string;
  /** Leaf directory name */
  dirName: string;
  /** Silo this directory belongs to */
  siloName: string;
  /** Overall directory score: max across all axes [0,1]. */
  score: number;
  /** Which axis drove the directory's ranking (e.g. 'segment'). */
  scoreSource: string;
  /** Per-axis fused scores: { segment: {...} }. */
  axes: Record<string, FusedScore>;
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

// ── Search (Decaying Sum) ────────────────────────────────────────────────────

/** Discriminated union describing where a chunk lives within its source file. */
export type LocationHint =
  | { type: 'lines'; start: number; end: number }
  | { type: 'page';  page: number }
  | null;

/** Lightweight hint for where/why a file matched (no chunk text). */
export interface SearchHint {
  /** Location of the best-matching chunk within the source file. */
  locationHint?: LocationHint;
  /** Section path of best-matching chunk. */
  sectionPath?: string[];
}

/** A single matching chunk location within a file, with relative relevance. */
export interface ChunkHint {
  /** Where this chunk lives in the source file (page or line range). */
  locationHint: LocationHint;
  /** Section path of this chunk (e.g. ["## Chapter 3", "### Methods"]). */
  sectionPath?: string[];
  /** Absolute relevance (0–100), scaled by the file's overall score. Best chunk = file score. */
  relevance: number;
}

/** Search result from the decaying-sum pipeline. */
export interface SearchResult {
  /** Absolute file path. */
  filePath: string;
  /** Silo this result belongs to. */
  siloName: string;
  /** Final decaying-sum score [0, 1]. */
  score: number;
  /** Human-readable score label: signal name (e.g. "semantic") or "convergence". */
  scoreLabel: string;
  /** Per-signal raw scores: { semantic: 0.6, bm25: 0.55, filepath: 0.5 }. */
  signals: Record<string, number>;
  /** Best-chunk hint from the winning content signal. */
  hint?: SearchHint;
  /** All significant matching chunks across signals (when ≥ 2 unique locations). */
  chunks?: ChunkHint[];
}

// ── Search Params ─────────────────────────────────────────────────────────────

/** Controls which scoring signals are used for a search. */
export type SearchMode = 'hybrid' | 'bm25' | 'semantic' | 'filepath' | 'regex';

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
  /** Maximum number of activity log entries to keep per silo */
  activityLogLimit: number;
}

// ── Memory ────────────────────────────────────────────────────────────────────

/** Lifecycle status values for memory/task entries. */
export type MemoryStatusValue = 'open' | 'completed' | 'cancelled';

/** Priority levels: 1=low, 2=medium, 3=high, 4=critical. */
export type PriorityLevel = 1 | 2 | 3 | 4;

export interface MemoryRecord {
  id: number;
  topic: string;
  body: string;
  confidence: number;
  contextHint: string | null;
  actionDate: string | null;
  recurrence: string | null;
  priority: PriorityLevel | null;
  status: MemoryStatusValue | null;
  completedOn: string | null;   // ISO 8601 date — implies completed when set
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;      // ISO 8601 datetime — set on soft delete, null for active
  deletionReason: string | null;  // optional explanation stored on soft delete
}

export interface MemorySearchResult extends MemoryRecord {
  score: number;
  scoreLabel: string;
  signals: Record<string, number>;
}

export interface RelatedMemoryResult {
  id: number;
  topic: string;
  /** Cosine similarity in [0, 1]. */
  similarity: number;
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
