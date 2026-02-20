import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  selectDirectories: (): Promise<string[]> =>
    ipcRenderer.invoke('dialog:selectDirectories'),
  openPath: (path: string): Promise<void> =>
    ipcRenderer.invoke('shell:openPath', path),
});
