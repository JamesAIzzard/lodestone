import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import {
  loadConfig,
  saveConfig,
  createDefaultConfig,
  getDefaultConfigPath,
  configExists,
  resolveSiloConfig,
  type LodestoneConfig,
} from './backend/config';
import { checkOllamaConnection } from './backend/embedding';
import { SiloManager } from './backend/silo-manager';
import type { SiloStatus, SearchResult, ActivityEvent, ServerStatus } from './shared/types';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let indexingPaused = false;

// ── Backend State ────────────────────────────────────────────────────────────

let config: LodestoneConfig | null = null;
const siloManagers = new Map<string, SiloManager>();
const startTime = Date.now();
let nextEventId = 1;

function getUserDataDir(): string {
  return app.getPath('userData');
}

function getModelCacheDir(): string {
  return path.join(getUserDataDir(), 'model-cache');
}

// ── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  // Close-to-tray: hide window instead of closing
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── System Tray ──────────────────────────────────────────────────────────────

function buildTrayMenu(): Menu {
  const statusLabel = (state: string) =>
    state === 'indexing' ? '⟳ Indexing' : state === 'error' ? '✕ Error' : '● Idle';

  const siloItems = Array.from(siloManagers.entries()).map(([name]) => ({
    label: `${name}  ${statusLabel('idle')}`,
    enabled: false,
  }));

  return Menu.buildFromTemplate([
    {
      label: 'Open Dashboard',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Silos',
      submenu: siloItems.length > 0
        ? siloItems
        : [{ label: 'No silos configured', enabled: false }],
    },
    {
      label: indexingPaused ? 'Resume Indexing' : 'Pause Indexing',
      click: () => {
        indexingPaused = !indexingPaused;
        if (tray) tray.setContextMenu(buildTrayMenu());
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAQElEQVR4nGNgGNTg////W0CYIs1kGYKkEQaINwSLZuINwaOZsCFEaMZvCMUGUOwFqgQiHkMoSguUp0ayNNMNAADkCUHcy6YwLAAAAABJRU5ErkJggg==',
  );
  tray = new Tray(icon);
  tray.setToolTip('Lodestone');
  tray.setContextMenu(buildTrayMenu());

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}

// ── Backend Initialization ───────────────────────────────────────────────────

async function initializeBackend(): Promise<void> {
  const configPath = getDefaultConfigPath(getUserDataDir());

  // Load or create config
  if (configExists(configPath)) {
    try {
      config = loadConfig(configPath);
      console.log(`[main] Loaded config from ${configPath}`);
    } catch (err) {
      console.error('[main] Failed to load config:', err);
      config = createDefaultConfig();
    }
  } else {
    config = createDefaultConfig();
    saveConfig(configPath, config);
    console.log(`[main] Created default config at ${configPath}`);
  }

  // Initialize a SiloManager for each configured silo
  for (const [name, siloToml] of Object.entries(config.silos)) {
    const resolved = resolveSiloConfig(name, siloToml, config);
    const manager = new SiloManager(
      resolved,
      config.embeddings.ollama_url,
      getModelCacheDir(),
      getUserDataDir(),
    );

    try {
      await manager.start();
      siloManagers.set(name, manager);

      // Forward activity events to the renderer
      manager.getConfig(); // verify config is accessible
      console.log(`[main] Silo "${name}" started`);
    } catch (err) {
      console.error(`[main] Failed to start silo "${name}":`, err);
    }
  }

  // Update tray menu now that silos are loaded
  if (tray) tray.setContextMenu(buildTrayMenu());
}

async function shutdownBackend(): Promise<void> {
  for (const [name, manager] of siloManagers) {
    try {
      await manager.stop();
      console.log(`[main] Silo "${name}" stopped`);
    } catch (err) {
      console.error(`[main] Error stopping silo "${name}":`, err);
    }
  }
  siloManagers.clear();
}

// ── Activity Event Forwarding ────────────────────────────────────────────────

function pushActivityToRenderer(event: ActivityEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('activity:push', event);
  }
}

// ── IPC Handlers ─────────────────────────────────────────────────────────────

function registerIpcHandlers(): void {
  // Dialog & Shell
  ipcMain.handle('dialog:selectDirectories', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'multiSelections'],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('shell:openPath', async (_event, filePath: string) => {
    await shell.openPath(filePath);
  });

  // Silos
  ipcMain.handle('silos:list', async (): Promise<SiloStatus[]> => {
    const statuses: SiloStatus[] = [];
    for (const manager of siloManagers.values()) {
      const status = await manager.getStatus();
      const cfg = manager.getConfig();
      statuses.push({
        config: {
          name: cfg.name,
          directories: cfg.directories,
          extensions: cfg.extensions,
          ignorePatterns: cfg.ignore,
          modelOverride: cfg.model === config?.embeddings.model ? null : cfg.model,
          dbPath: cfg.dbPath,
        },
        indexedFileCount: status.indexedFileCount,
        chunkCount: status.chunkCount,
        lastUpdated: status.lastUpdated?.toISOString() ?? null,
        databaseSizeBytes: status.databaseSizeBytes,
        watcherState: status.watcherState,
        errorMessage: status.errorMessage,
      });
    }
    return statuses;
  });

  ipcMain.handle('silos:search', async (_event, query: string, siloName?: string): Promise<SearchResult[]> => {
    const results: SearchResult[] = [];
    const managers = siloName
      ? [[siloName, siloManagers.get(siloName)] as const].filter(([, m]) => m)
      : Array.from(siloManagers.entries());

    for (const [name, manager] of managers) {
      if (!manager) continue;
      const siloResults = await manager.search(query, 10);
      for (const r of siloResults) {
        results.push({
          filePath: r.filePath,
          score: r.score,
          matchingSection: r.sectionName,
          siloName: name as string,
        });
      }
    }

    // Sort by score across all silos
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 20);
  });

  // Activity
  ipcMain.handle('activity:recent', async (_event, limit: number = 50): Promise<ActivityEvent[]> => {
    const allEvents: ActivityEvent[] = [];
    for (const manager of siloManagers.values()) {
      const feed = manager.getActivityFeed(limit);
      for (const e of feed) {
        allEvents.push({
          id: String(nextEventId++),
          timestamp: e.timestamp.toISOString(),
          siloName: e.siloName,
          filePath: e.filePath,
          eventType: e.eventType,
          errorMessage: e.errorMessage,
        });
      }
    }
    allEvents.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return allEvents.slice(0, limit);
  });

  // Server / Settings
  ipcMain.handle('server:status', async (): Promise<ServerStatus> => {
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

    // Check Ollama connection
    const ollamaUrl = config?.embeddings.ollama_url ?? 'http://localhost:11434';
    const ollamaResult = await checkOllamaConnection(ollamaUrl);

    // Count total indexed files
    let totalFiles = 0;
    for (const manager of siloManagers.values()) {
      const status = await manager.getStatus();
      totalFiles += status.indexedFileCount;
    }

    // Build available models list (built-in is always present)
    const models = ['built-in (all-MiniLM-L6-v2)'];
    if (ollamaResult) {
      models.push(...ollamaResult.models);
    }

    return {
      uptimeSeconds,
      ollamaState: ollamaResult ? 'connected' : 'disconnected',
      ollamaUrl,
      availableModels: models,
      defaultModel: config?.embeddings.model ?? 'built-in',
      totalIndexedFiles: totalFiles,
    };
  });

  ipcMain.handle('ollama:test', async (_event, url: string): Promise<{ connected: boolean; models: string[] }> => {
    const result = await checkOllamaConnection(url);
    if (result) {
      return { connected: true, models: result.models };
    }
    return { connected: false, models: [] };
  });

  ipcMain.handle('config:path', async (): Promise<string> => {
    return getDefaultConfigPath(getUserDataDir());
  });
}

// ── App Lifecycle ────────────────────────────────────────────────────────────

app.on('ready', async () => {
  registerIpcHandlers();
  createWindow();
  createTray();

  // Initialize backend asynchronously (don't block window creation)
  try {
    await initializeBackend();
  } catch (err) {
    console.error('[main] Backend initialization error:', err);
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', (event) => {
  if (siloManagers.size > 0) {
    event.preventDefault();
    shutdownBackend().finally(() => app.quit());
  }
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') {
    // macOS: app stays in dock
  }
  // Otherwise: app stays in tray
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
});
