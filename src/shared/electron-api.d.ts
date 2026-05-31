import type {
  SiloStatus,
  SearchResult,
  DirectoryResult,
  ActivityEvent,
  ServerStatus,
  DefaultSettings,
  ExploreParams,
  SearchParams,
} from './types';

/** Config snapshot stored inside a portable silo database. */
export interface StoredSiloConfigResponse {
  config: {
    name: string;
    contentDescription?: string;
    indexedDirectories: string[];
    indexedFileExtensions: string[];
    ignoredFolderPatterns: string[];
    ignoredFilePatterns: string[];
    accentColor?: string;
    iconName?: string;
  } | null;
  meta: {
    model: string;
    dimensions: number;
  } | null;
}

export type McpClientId = 'claude-desktop' | 'codex-desktop';

export interface McpClientStatus {
  configPath: string;
  hasClient: boolean;
  isConfigured: boolean;
}

export interface McpClientConfigureResult {
  success: boolean;
  configPath: string;
  error?: string;
}

export interface ElectronAPI {
  // ── Dialogs & Shell ────────────────────────────────────────────────────────
  selectDirectories: () => Promise<string[]>;
  selectDbFile: () => Promise<string | null>;
  saveDbFile: (defaultName: string) => Promise<string | null>;
  openPath: (path: string) => Promise<void>;
  showItemInFolder: (path: string) => Promise<void>;
  readDbConfig: (dbPath: string) => Promise<StoredSiloConfigResponse | null>;

  // ── Silos ──────────────────────────────────────────────────────────────────
  getSilos: () => Promise<SiloStatus[]>;
  createSilo: (opts: {
    name: string;
    indexedDirectories: string[];
    indexedFileExtensions: string[];
    indexDbPath: string;
    contentDescription?: string;
    accentColor?: string;
    iconName?: string;
    mode?: 'new' | 'existing';
  }) => Promise<{ success: boolean; error?: string }>;
  deleteSilo: (name: string) => Promise<{ success: boolean; error?: string }>;
  disconnectSilo: (name: string) => Promise<{ success: boolean; error?: string }>;
  stopSilo: (name: string) => Promise<{ success: boolean; error?: string }>;
  wakeSilo: (name: string) => Promise<{ success: boolean; error?: string }>;
  rescanSilo: (name: string) => Promise<{ success: boolean; error?: string }>;
  updateSilo: (
    name: string,
    updates: {
      contentDescription?: string;
      ignoredFolderPatterns?: string[];
      ignoredFilePatterns?: string[];
      indexedFileExtensions?: string[];
      accentColor?: string;
      iconName?: string;
    },
  ) => Promise<{ success: boolean; error?: string }>;
  search: (params: SearchParams, siloName?: string) => Promise<SearchResult[]>;
  explore: (params: ExploreParams) => Promise<DirectoryResult[]>;

  // ── Activity ───────────────────────────────────────────────────────────────
  getActivity: (limit?: number) => Promise<ActivityEvent[]>;
  onActivity: (callback: (event: ActivityEvent) => void) => () => void;

  // ── Silo state push (e.g. tray sleep/wake) ────────────────────────────────
  onSilosChanged: (callback: () => void) => () => void;

  // ── MCP activity push (triggers shimmer on silo cards) ─────────────────────
  onMcpActivity: (callback: (event: { channel: 'silo'; siloName?: string }) => void) => () => void;

  // ── Defaults ──────────────────────────────────────────────────────────────
  getDefaults: () => Promise<DefaultSettings>;
  updateDefaults: (updates: Partial<DefaultSettings>) => Promise<{ success: boolean }>;
  resetAllSettings: () => Promise<{ success: boolean }>;

  // ── Silo rename ────────────────────────────────────────────────────────────
  renameSilo: (oldName: string, newName: string) => Promise<{ success: boolean; error?: string }>;

  // ── Server / Settings ──────────────────────────────────────────────────────
  getServerStatus: () => Promise<ServerStatus>;
  getConfigPath: () => Promise<string>;
  getDataDir: () => Promise<string>;

  // ── MCP Client Integration ────────────────────────────────────────────────
  getMcpClientStatus: (clientId: McpClientId) => Promise<McpClientStatus>;
  configureMcpClient: (clientId: McpClientId) => Promise<McpClientConfigureResult>;
  getClaudeDesktopStatus: () => Promise<{
    configPath: string;
    hasClaudeDesktop: boolean;
    isConfigured: boolean;
  }>;
  configureClaudeDesktop: () => Promise<{
    success: boolean;
    configPath: string;
    error?: string;
  }>;

  // App info
  getAppVersion: () => Promise<string>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
