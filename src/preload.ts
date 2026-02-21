import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Dialogs & Shell
  selectDirectories: (): Promise<string[]> =>
    ipcRenderer.invoke('dialog:selectDirectories'),
  selectDbFile: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:selectDbFile'),
  saveDbFile: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveDbFile', defaultName),
  openPath: (path: string): Promise<void> =>
    ipcRenderer.invoke('shell:openPath', path),
  readDbConfig: (dbPath: string): Promise<unknown> =>
    ipcRenderer.invoke('db:readConfig', dbPath),

  // Silos
  getSilos: (): Promise<unknown[]> =>
    ipcRenderer.invoke('silos:list'),
  createSilo: (opts: { name: string; directories: string[]; extensions: string[]; dbPath: string; model: string; description?: string }): Promise<unknown> =>
    ipcRenderer.invoke('silos:create', opts),
  deleteSilo: (name: string): Promise<unknown> =>
    ipcRenderer.invoke('silos:delete', name),
  disconnectSilo: (name: string): Promise<unknown> =>
    ipcRenderer.invoke('silos:disconnect', name),
  sleepSilo: (name: string): Promise<unknown> =>
    ipcRenderer.invoke('silos:sleep', name),
  wakeSilo: (name: string): Promise<unknown> =>
    ipcRenderer.invoke('silos:wake', name),
  rebuildSilo: (name: string): Promise<unknown> =>
    ipcRenderer.invoke('silos:rebuild', name),
  updateSilo: (name: string, updates: { description?: string; model?: string; ignore?: string[]; ignoreFiles?: string[]; extensions?: string[] }): Promise<unknown> =>
    ipcRenderer.invoke('silos:update', name, updates),
  pauseSilo: (name: string): Promise<unknown> =>
    ipcRenderer.invoke('silos:pause', name),
  resumeSilo: (name: string): Promise<unknown> =>
    ipcRenderer.invoke('silos:resume', name),
  search: (query: string, siloName?: string): Promise<unknown[]> =>
    ipcRenderer.invoke('silos:search', query, siloName),

  // Activity
  getActivity: (limit?: number): Promise<unknown[]> =>
    ipcRenderer.invoke('activity:recent', limit),
  onActivity: (callback: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on('activity:push', handler);
    return () => ipcRenderer.removeListener('activity:push', handler);
  },

  // Silo state changes (e.g. sleep/wake from tray)
  onSilosChanged: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('silos:changed', handler);
    return () => ipcRenderer.removeListener('silos:changed', handler);
  },

  // Defaults
  getDefaults: (): Promise<unknown> =>
    ipcRenderer.invoke('defaults:get'),
  updateDefaults: (updates: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('defaults:update', updates),

  // Server / Settings
  getServerStatus: (): Promise<unknown> =>
    ipcRenderer.invoke('server:status'),
  testOllamaConnection: (url: string): Promise<unknown> =>
    ipcRenderer.invoke('ollama:test', url),
  getConfigPath: (): Promise<string> =>
    ipcRenderer.invoke('config:path'),
});
