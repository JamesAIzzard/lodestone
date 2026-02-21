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
}

export type WatcherState = 'idle' | 'indexing' | 'error' | 'sleeping' | 'waiting';

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
  /** True when indexing is paused */
  paused?: boolean;
  /** Absolute path to the silo's SQLite database file */
  resolvedDbPath: string;
  /** The effective embedding model for this silo (global default or per-silo override) */
  resolvedModel: string;
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
}
