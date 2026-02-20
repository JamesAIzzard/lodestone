// ── Silo ──────────────────────────────────────────────────────────────────────

export interface SiloConfig {
  name: string;
  directories: string[];
  extensions: string[];
  ignorePatterns: string[];
  modelOverride: string | null;
  dbPath: string;
}

export type WatcherState = 'idle' | 'indexing' | 'error';

export interface SiloStatus {
  config: SiloConfig;
  indexedFileCount: number;
  chunkCount: number;
  lastUpdated: Date;
  databaseSizeBytes: number;
  watcherState: WatcherState;
  errorMessage?: string;
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface SearchResult {
  filePath: string;
  score: number;
  matchingSection: string | null;
  siloName: string;
}

// ── Activity ──────────────────────────────────────────────────────────────────

export type ActivityEventType = 'indexed' | 'reindexed' | 'deleted' | 'error';

export interface ActivityEvent {
  id: string;
  timestamp: Date;
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
