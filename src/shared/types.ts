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
  semantic: { semantic: 0.70, bm25: 0.10, trigram: 0.08, filepath: 0.07, tags: 0.05 },
  keyword:  { semantic: 0.15, bm25: 0.40, trigram: 0.25, filepath: 0.12, tags: 0.08 },
  code:     { semantic: 0.30, bm25: 0.20, trigram: 0.20, filepath: 0.25, tags: 0.05 },
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

export interface SearchResult {
  filePath: string;
  /** Final score (RRF, or RRF × bestCosineSimilarity when merging across silos) */
  score: number;
  matchType: MatchType;
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

// ── Activity ──────────────────────────────────────────────────────────────────

export type ActivityEventType = 'indexed' | 'reindexed' | 'deleted' | 'error';

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
