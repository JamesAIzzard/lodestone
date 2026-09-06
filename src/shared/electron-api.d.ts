import type {
  SiloStatus,
  SearchResult,
  DirectoryResult,
  ActivityEvent,
  ServerStatus,
  DefaultSettings,
  LlmInstructionsSettings,
  ExploreParams,
  SearchParams,
} from './types';
import type { MailAccountTomlConfig } from '../backend/config';
import type { MailAccountStatus } from '../backend/mail/account';
import type { Folder } from '../backend/mail/types';
import type { SiloColor, SiloIconName } from './silo-appearance';

export type MailCredentialInput =
  | { kind: 'password'; password: string }
  | { kind: 'oauth'; callbackUrl?: string };

export interface LodestoneMailAPI {
  list: () => Promise<MailAccountStatus[]>;
  beginOAuth: (input: { clientId: string; loginHint: string }) => Promise<{ url: string }>;
  testConnection: (input: {
    host: string;
    port: number;
    username: string;
    auth: MailCredentialInput & { clientId?: string };
  }) => Promise<{ ok: boolean; folders?: Folder[]; error?: string }>;
  cancelSetup: (input: { host: string; port: number; username: string }) => Promise<void>;
  create: (input: {
    config: MailAccountTomlConfig;
    credential: MailCredentialInput;
    appearance?: { accentColor: SiloColor; iconName: SiloIconName };
  }) => Promise<{ success: boolean; hash?: string; error?: string }>;
  updateSettings: (input: {
    hash: string;
    patch: Partial<
      Pick<
        MailAccountTomlConfig,
        | 'sync_interval_seconds'
        | 'silo_name'
        | 'received_after'
        | 'selection_mode'
        | 'selected_folders'
      >
    >;
  }) => Promise<{ success: boolean; error?: string }>;
  reconnect: (input: {
    hash: string;
    credential: MailCredentialInput;
  }) => Promise<{ success: boolean; error?: string }>;
  syncNow: (hash: string) => Promise<{ success: boolean; error?: string }>;
  remove: (hash: string) => Promise<{ success: boolean; error?: string }>;
  retryRemove: (hash: string) => Promise<{ success: boolean; error?: string }>;
}

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

export type McpClientId = 'claude-desktop' | 'claude-code' | 'codex-desktop';

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
  openExternal: (url: string) => Promise<void>;
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
  search: (params: SearchParams, siloName?: string | string[]) => Promise<SearchResult[]>;
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

  // ── LLM instructions ────────────────────────────────────────────────────
  getLlmInstructionsSettings: () => Promise<LlmInstructionsSettings>;
  updateLlmInstructionsSettings: (notePath?: string) => Promise<{ success: boolean }>;

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
    lodestone?: { mail: LodestoneMailAPI };
  }
}
