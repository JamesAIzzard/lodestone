// ── Silo ──────────────────────────────────────────────────────────────────────

export interface SiloConfig {
  name: string;
  directories: string[];
  extensions: string[];
  ignorePatterns: string[];
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
  /** Absolute path to the silo's SQLite database file */
  resolvedDbPath: string;
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface SearchResultChunk {
  sectionPath: string[];
  text: string;
  startLine: number;
  endLine: number;
  score: number;
}

export type MatchType = 'semantic' | 'keyword' | 'both';

export interface SearchResult {
  filePath: string;
  score: number;
  matchType: MatchType;
  chunks: SearchResultChunk[];
  siloName: string;
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
