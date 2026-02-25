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
  createSilo: (opts: { name: string; directories: string[]; extensions: string[]; dbPath: string; model: string; description?: string; color?: string; icon?: string; mode?: 'new' | 'existing' }): Promise<unknown> =>
    ipcRenderer.invoke('silos:create', opts),
  deleteSilo: (name: string): Promise<unknown> =>
    ipcRenderer.invoke('silos:delete', name),
  disconnectSilo: (name: string): Promise<unknown> =>
    ipcRenderer.invoke('silos:disconnect', name),
  stopSilo: (name: string): Promise<unknown> =>
    ipcRenderer.invoke('silos:stop', name),
  wakeSilo: (name: string): Promise<unknown> =>
    ipcRenderer.invoke('silos:wake', name),
  rescanSilo: (name: string): Promise<unknown> =>
    ipcRenderer.invoke('silos:rescan', name),
  rebuildSilo: (name: string): Promise<unknown> =>
    ipcRenderer.invoke('silos:rebuild', name),
  updateSilo: (name: string, updates: { description?: string; model?: string; ignore?: string[]; ignoreFiles?: string[]; extensions?: string[]; color?: string; icon?: string }): Promise<unknown> =>
    ipcRenderer.invoke('silos:update', name, updates),
  renameSilo: (oldName: string, newName: string): Promise<unknown> =>
    ipcRenderer.invoke('silos:rename', oldName, newName),
  search: (params: unknown, siloName?: string): Promise<unknown[]> =>
    ipcRenderer.invoke('silos:search', params, siloName),
  explore: (params: unknown): Promise<unknown[]> =>
    ipcRenderer.invoke('silos:explore', params),

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

  // Memory state changes (e.g. remember/revise/forget from MCP)
  onMemoriesChanged: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('memories:changed', handler);
    return () => ipcRenderer.removeListener('memories:changed', handler);
  },

  // MCP channel activity (triggers shimmer on silo/memory cards)
  onMcpActivity: (callback: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on('mcp:activity', handler);
    return () => ipcRenderer.removeListener('mcp:activity', handler);
  },

  // Defaults
  getDefaults: (): Promise<unknown> =>
    ipcRenderer.invoke('defaults:get'),
  updateDefaults: (updates: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('defaults:update', updates),
  resetAllSettings: (): Promise<unknown> =>
    ipcRenderer.invoke('defaults:reset-all'),

  // Server / Settings
  getServerStatus: (): Promise<unknown> =>
    ipcRenderer.invoke('server:status'),
  testOllamaConnection: (url: string): Promise<unknown> =>
    ipcRenderer.invoke('ollama:test', url),
  getConfigPath: (): Promise<string> =>
    ipcRenderer.invoke('config:path'),
  getDataDir: (): Promise<string> =>
    ipcRenderer.invoke('data:dir'),

  // Memory
  getMemoryStatus: (): Promise<unknown> =>
    ipcRenderer.invoke('memory:status'),
  setupMemory: (dbPath: string): Promise<unknown> =>
    ipcRenderer.invoke('memory:setup', dbPath),
  connectMemory: (dbPath: string): Promise<unknown> =>
    ipcRenderer.invoke('memory:connect', dbPath),
  disconnectMemory: (): Promise<unknown> =>
    ipcRenderer.invoke('memory:disconnect'),

  // Claude Desktop Integration
  getClaudeDesktopStatus: (): Promise<unknown> =>
    ipcRenderer.invoke('mcp:getClaudeDesktopStatus'),
  configureClaudeDesktop: (): Promise<unknown> =>
    ipcRenderer.invoke('mcp:configureClaudeDesktop'),
});
