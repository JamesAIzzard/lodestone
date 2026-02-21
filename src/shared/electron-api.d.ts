import type { SiloStatus, SearchResult, ActivityEvent, ServerStatus, DefaultSettings } from './types';

export interface ElectronAPI {
  // ── Dialogs & Shell ────────────────────────────────────────────────────────
  selectDirectories: () => Promise<string[]>;
  selectDbFile: () => Promise<string | null>;
  saveDbFile: (defaultName: string) => Promise<string | null>;
  openPath: (path: string) => Promise<void>;

  // ── Silos ──────────────────────────────────────────────────────────────────
  getSilos: () => Promise<SiloStatus[]>;
  createSilo: (opts: {
    name: string;
    directories: string[];
    extensions: string[];
    dbPath: string;
    model: string;
    description?: string;
  }) => Promise<{ success: boolean; error?: string }>;
  deleteSilo: (name: string) => Promise<{ success: boolean; error?: string }>;
  disconnectSilo: (name: string) => Promise<{ success: boolean; error?: string }>;
  sleepSilo: (name: string) => Promise<{ success: boolean; error?: string }>;
  wakeSilo: (name: string) => Promise<{ success: boolean; error?: string }>;
  rebuildSilo: (name: string) => Promise<{ success: boolean; error?: string }>;
  updateSilo: (name: string, updates: { description?: string; model?: string; ignore?: string[]; ignoreFiles?: string[]; extensions?: string[] }) => Promise<{ success: boolean; error?: string }>;
  pauseSilo: (name: string) => Promise<{ success: boolean; error?: string }>;
  resumeSilo: (name: string) => Promise<{ success: boolean; error?: string }>;
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
