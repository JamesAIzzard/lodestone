export interface ElectronAPI {
  selectDirectories: () => Promise<string[]>;
  openPath: (path: string) => Promise<void>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
