import type { SiloStatus, SearchResult, ActivityEvent, ServerStatus } from './types';

export interface ElectronAPI {
  // ── Dialogs & Shell ────────────────────────────────────────────────────────
  selectDirectories: () => Promise<string[]>;
  openPath: (path: string) => Promise<void>;

  // ── Silos ──────────────────────────────────────────────────────────────────
  getSilos: () => Promise<SiloStatus[]>;
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
