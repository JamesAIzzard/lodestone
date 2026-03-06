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
  showItemInFolder: (path: string): Promise<void> =>
    ipcRenderer.invoke('shell:showItemInFolder', path),
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

  // MCP channel activity (triggers shimmer on silo cards)
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

  // Claude Desktop Integration
  getClaudeDesktopStatus: (): Promise<unknown> =>
    ipcRenderer.invoke('mcp:getClaudeDesktopStatus'),
  configureClaudeDesktop: (): Promise<unknown> =>
    ipcRenderer.invoke('mcp:configureClaudeDesktop'),

  // App info
  getAppVersion: (): Promise<string> =>
    ipcRenderer.invoke('app:version'),

  // Cloud memories
  setCloudUrl: (url: string): Promise<unknown> =>
    ipcRenderer.invoke('cloud:setUrl', url),
  setCloudAuthToken: (token: string): Promise<unknown> =>
    ipcRenderer.invoke('cloud:setAuthToken', token),

  // Tasks
  listTasks: (opts?: { includeCompleted?: boolean; includeCancelled?: boolean; projectId?: number }): Promise<unknown> =>
    ipcRenderer.invoke('tasks:list', opts ?? {}),
  searchTasks: (query: string): Promise<unknown> =>
    ipcRenderer.invoke('tasks:search', query),
  reviseTask: (id: number, fields: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('tasks:revise', id, fields),
  skipTask: (id: number, reason?: string): Promise<unknown> =>
    ipcRenderer.invoke('tasks:skip', id, reason),
  createTask: (topic: string, projectId?: number): Promise<unknown> =>
    ipcRenderer.invoke('tasks:create', topic, projectId),
  deleteTask: (id: number): Promise<unknown> =>
    ipcRenderer.invoke('tasks:delete', id),

  // Projects
  listProjects: (): Promise<unknown> =>
    ipcRenderer.invoke('projects:list'),
  createProject: (name: string, color?: string): Promise<unknown> =>
    ipcRenderer.invoke('projects:create', name, color),
  updateProject: (id: number, updates: { name?: string; color?: string }): Promise<unknown> =>
    ipcRenderer.invoke('projects:update', id, updates),
  deleteProject: (id: number): Promise<unknown> =>
    ipcRenderer.invoke('projects:delete', id),
  mergeProjects: (sourceId: number, targetId: number): Promise<unknown> =>
    ipcRenderer.invoke('projects:merge', sourceId, targetId),
});
