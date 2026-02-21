import type { SiloStatus, SearchResult, ActivityEvent, ServerStatus } from './types';

export interface ElectronAPI {
  // ── Dialogs & Shell ────────────────────────────────────────────────────────
  selectDirectories: () => Promise<string[]>;
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
  sleepSilo: (name: string) => Promise<{ success: boolean; error?: string }>;
  wakeSilo: (name: string) => Promise<{ success: boolean; error?: string }>;
  rebuildSilo: (name: string) => Promise<{ success: boolean; error?: string }>;
  updateSilo: (name: string, updates: { description?: string; model?: string }) => Promise<{ success: boolean; error?: string }>;
  search: (query: string, siloName?: string) => Promise<SearchResult[]>;

  // ── Activity ───────────────────────────────────────────────────────────────
  getActivity: (limit?: number) => Promise<ActivityEvent[]>;
  onActivity: (callback: (event: ActivityEvent) => void) => () => void;

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
