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

// ── Search Weights ────────────────────────────────────────────────────────────

export interface SearchWeights {
  semantic: number;
  bm25: number;
  trigram: number;
  filepath: number;
  tags: number;
}

export const DEFAULT_SEARCH_WEIGHTS: SearchWeights = {
  semantic: 0.35,
  bm25: 0.25,
  trigram: 0.15,
  filepath: 0.15,
  tags: 0.10,
};

export type SearchPreset = 'balanced' | 'semantic' | 'keyword' | 'code';

export const SEARCH_PRESETS: Record<SearchPreset, SearchWeights> = {
  balanced: DEFAULT_SEARCH_WEIGHTS,
  semantic: { semantic: 0.90, bm25: 0.04, trigram: 0.03, filepath: 0.02, tags: 0.01 },
  keyword:  { semantic: 0.05, bm25: 0.44, trigram: 0.28, filepath: 0.10, tags: 0.13 },
  code:     { semantic: 0.05, bm25: 0.10, trigram: 0.42, filepath: 0.38, tags: 0.05 },
};

export interface SignalContribution {
  /** 1-based rank in this signal's list (0 = not found) */
  rank: number;
  /** Signal-specific raw score (cosine sim for semantic, FTS5 rank for others) */
  rawScore: number;
  /** w_i * boost / (k + rank_i) normalised — the actual RRF contribution */
  rrfContribution: number;
}

export interface ScoreBreakdown {
  semantic?: SignalContribution;
  bm25?: SignalContribution;
  trigram?: SignalContribution;
  filepath?: SignalContribution;
  tags?: SignalContribution;
}

/** A breakdown where every signal contributed nothing — used for structural/fallback results. */
export const ZERO_SCORE_BREAKDOWN: ScoreBreakdown = {
  semantic:  { rank: 0, rawScore: 0, rrfContribution: 0 },
  bm25:      { rank: 0, rawScore: 0, rrfContribution: 0 },
  trigram:   { rank: 0, rawScore: 0, rrfContribution: 0 },
  filepath:  { rank: 0, rawScore: 0, rrfContribution: 0 },
  tags:      { rank: 0, rawScore: 0, rrfContribution: 0 },
};

// ── Search ────────────────────────────────────────────────────────────────────

export interface SearchResultChunk {
  sectionPath: string[];
  text: string;
  startLine: number;
  endLine: number;
  score: number;
  /** Whether this chunk was matched by semantic search, keyword search, or both */
  matchType: MatchType;
  /** Cosine similarity of this chunk to the query (0 for keyword-only chunks) */
  cosineSimilarity: number;
  /** Per-signal score breakdown for this chunk */
  breakdown?: ScoreBreakdown;
}

export type MatchType = 'semantic' | 'keyword' | 'both';

/** What drove this file's ranking score: a filename/path match or content signals */
export type ScoreSource = 'filename' | 'content';

export interface SearchResult {
  filePath: string;
  /** Final score (RRF, or RRF × bestCosineSimilarity when merging across silos) */
  score: number;
  /**
   * Display-friendly "goodness of fit" score (0–1).
   * Anchored on cosine similarity, boosted by keyword signal agreement.
   * Use this for display and ordering; `score` (RRF) is the raw ranking signal.
   */
  qualityScore: number;
  matchType: MatchType;
  /** Whether the file's score was driven by a filename/path match or content signals */
  scoreSource: ScoreSource;
  chunks: SearchResultChunk[];
  siloName: string;
  /** Raw RRF score before cross-silo cosine calibration */
  rrfScore: number;
  /** Best cosine similarity among the file's vector-matched chunks (0 for keyword-only) */
  bestCosineSimilarity: number;
  /** Per-signal score breakdown for this file's best-scoring chunk */
  breakdown?: ScoreBreakdown;
  /** The search weights that produced this result */
  weights?: SearchWeights;
}

// ── Directory Exploration ────────────────────────────────────────────────

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
}

export interface DirectoryResult {
  /** Absolute filesystem path of the matched directory */
  dirPath: string;
  /** Leaf directory name */
  dirName: string;
  /** Silo this directory belongs to */
  siloName: string;
  /** Overall relevance score (0-1) */
  score: number;
  /** Display-friendly quality score (0-1), analogous to SearchResult.qualityScore */
  qualityScore: number;
  /** Per-signal score breakdown */
  breakdown: ScoreBreakdown;
  /** Number of files directly in this directory */
  fileCount: number;
  /** Number of immediate subdirectories */
  subdirCount: number;
  /** Depth from silo root */
  depth: number;
  /** Tree of children, populated to maxDepth levels */
  children: DirectoryTreeNode[];
}

export interface ExploreParams {
  query?: string;
  silo?: string;
  startPath?: string;
  maxDepth?: number;
  maxResults?: number;
  weights?: SearchWeights;
}

export const DEFAULT_EXPLORE_WEIGHTS: SearchWeights = {
  semantic: 0.40,
  bm25: 0.0,
  trigram: 0.30,
  filepath: 0.30,
  tags: 0.0,
};

export const EXPLORE_PRESETS: Record<SearchPreset, SearchWeights> = {
  balanced: DEFAULT_EXPLORE_WEIGHTS,
  semantic: { semantic: 0.90, bm25: 0.0, trigram: 0.05, filepath: 0.05, tags: 0.0 },
  keyword:  { semantic: 0.05, bm25: 0.0, trigram: 0.55, filepath: 0.40, tags: 0.0 },
  code:     { semantic: 0.05, bm25: 0.0, trigram: 0.40, filepath: 0.55, tags: 0.0 },
};

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
