import type { SiloStatus, SearchResult, ActivityEvent, ServerStatus, DefaultSettings } from './types';

/** Config snapshot stored inside a portable silo database. */
export interface StoredSiloConfigResponse {
  config: {
    name: string;
    description?: string;
    directories: string[];
    extensions: string[];
    ignore: string[];
    ignoreFiles: string[];
    model: string;
    color?: string;
    icon?: string;
  } | null;
  meta: {
    model: string;
    dimensions: number;
  } | null;
}

export interface ElectronAPI {
  // ── Dialogs & Shell ────────────────────────────────────────────────────────
  selectDirectories: () => Promise<string[]>;
  selectDbFile: () => Promise<string | null>;
  saveDbFile: (defaultName: string) => Promise<string | null>;
  openPath: (path: string) => Promise<void>;
  readDbConfig: (dbPath: string) => Promise<StoredSiloConfigResponse | null>;

  // ── Silos ──────────────────────────────────────────────────────────────────
  getSilos: () => Promise<SiloStatus[]>;
  createSilo: (opts: {
    name: string;
    directories: string[];
    extensions: string[];
    dbPath: string;
    model: string;
    description?: string;
    color?: string;
    icon?: string;
  }) => Promise<{ success: boolean; error?: string }>;
  deleteSilo: (name: string) => Promise<{ success: boolean; error?: string }>;
  disconnectSilo: (name: string) => Promise<{ success: boolean; error?: string }>;
  stopSilo: (name: string) => Promise<{ success: boolean; error?: string }>;
  wakeSilo: (name: string) => Promise<{ success: boolean; error?: string }>;
  rebuildSilo: (name: string) => Promise<{ success: boolean; error?: string }>;
  updateSilo: (name: string, updates: { description?: string; model?: string; ignore?: string[]; ignoreFiles?: string[]; extensions?: string[]; color?: string; icon?: string }) => Promise<{ success: boolean; error?: string }>;
  search: (query: string, siloName?: string) => Promise<SearchResult[]>;

  // ── Activity ───────────────────────────────────────────────────────────────
  getActivity: (limit?: number) => Promise<ActivityEvent[]>;
  onActivity: (callback: (event: ActivityEvent) => void) => () => void;

  // ── Silo state push (e.g. tray sleep/wake) ────────────────────────────────
  onSilosChanged: (callback: () => void) => () => void;

  // ── Defaults ──────────────────────────────────────────────────────────────
  getDefaults: () => Promise<DefaultSettings>;
  updateDefaults: (updates: Partial<DefaultSettings>) => Promise<{ success: boolean }>;

  // ── Server / Settings ──────────────────────────────────────────────────────
  getServerStatus: () => Promise<ServerStatus>;
  testOllamaConnection: (url: string) => Promise<{ connected: boolean; models: string[] }>;
  getConfigPath: () => Promise<string>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
