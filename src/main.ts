import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import fs from 'node:fs';
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
import { checkOllamaConnection, createEmbeddingService, type EmbeddingService } from './backend/embedding';
import { SiloManager } from './backend/silo-manager';
import { getBundledModelIds, getModelDefinition, resolveModelAlias } from './backend/model-registry';
import { startMcpServer } from './backend/mcp-server';
import type { SiloStatus, SearchResult, ActivityEvent, ServerStatus } from './shared/types';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// ── MCP Mode Detection ──────────────────────────────────────────────────────
// When launched with `--mcp`, Lodestone runs headless: no window, no tray,
// just the MCP server on stdio. This is how Claude Desktop and other MCP
// clients interact with Lodestone.
const isMcpMode = process.argv.includes('--mcp');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

// ── Backend State ────────────────────────────────────────────────────────────

let config: LodestoneConfig | null = null;
const siloManagers = new Map<string, SiloManager>();
const startTime = Date.now();
let nextEventId = 1;

// Shared embedding services keyed by resolved model ID.
// All silos using the same model share one worker thread,
// preventing concurrent ONNX native calls from crashing.
const embeddingServices = new Map<string, EmbeddingService>();

function getOrCreateEmbeddingService(model: string): EmbeddingService {
  const modelId = resolveModelAlias(model);
  let service = embeddingServices.get(modelId);
  if (!service) {
    service = createEmbeddingService({
      model: modelId,
      ollamaUrl: config?.embeddings.ollama_url ?? 'http://localhost:11434',
      modelCacheDir: getModelCacheDir(),
    });
    embeddingServices.set(modelId, service);
  }
  return service;
}

// Serializes silo starts so only one embedding model is loaded at a time.
// Used by both initializeBackend() and silos:create to prevent concurrent starts.
let siloStartQueue: Promise<void> = Promise.resolve();

function enqueueSiloStart(name: string, manager: SiloManager): void {
  manager.loadWaitingStatus();
  siloStartQueue = siloStartQueue.then(async () => {
    try {
      await manager.start();
      console.log(`[main] Silo "${name}" started`);
    } catch (err) {
      console.error(`[main] Failed to start silo "${name}":`, err);
    }
  });
}

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
    state === 'sleeping' ? '⏸ Sleeping'
      : state === 'waiting' ? '⏳ Waiting'
        : state === 'indexing' ? '⟳ Indexing'
          : state === 'error' ? '✕ Error'
            : '● Idle';

  const siloItems = Array.from(siloManagers.entries()).map(([name]) => ({
    label: `${name}  ${statusLabel('idle')}`,
    enabled: false,
  }));

  const allSleeping = siloManagers.size > 0 &&
    Array.from(siloManagers.values()).every((m) => m.isSleeping);
  const anySleeping = Array.from(siloManagers.values()).some((m) => m.isSleeping);

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
      label: 'Sleep All',
      enabled: !allSleeping,
      click: async () => {
        for (const [name, manager] of siloManagers) {
          if (!manager.isSleeping) {
            await sleepSilo(name);
          }
        }
      },
    },
    {
      label: 'Wake All',
      enabled: anySleeping,
      click: async () => {
        for (const [name, manager] of siloManagers) {
          if (manager.isSleeping) {
            await wakeSilo(name);
          }
        }
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

  // Initialize a SiloManager for each configured silo.
  // Register all managers immediately so the renderer can see them.
  // Sleeping silos load cached stats; non-sleeping silos are enqueued
  // for sequential startup via the shared start queue.
  for (const [name, siloToml] of Object.entries(config.silos)) {
    const resolved = resolveSiloConfig(name, siloToml, config);
    const embeddingService = getOrCreateEmbeddingService(resolved.model);
    const manager = new SiloManager(
      resolved,
      embeddingService,
      getUserDataDir(),
    );

    siloManagers.set(name, manager);
    attachActivityForwarding(manager);
    manager.onStateChange(() => {
      mainWindow?.webContents.send('silos:changed');
    });

    if (resolved.sleeping) {
      manager.loadSleepingStatus();
      console.log(`[main] Silo "${name}" is sleeping`);
    } else {
      enqueueSiloStart(name, manager);
    }
  }

  // Update tray menu now that silos are loaded
  if (tray) tray.setContextMenu(buildTrayMenu());
}

async function sleepSilo(name: string): Promise<{ success: boolean; error?: string }> {
  const manager = siloManagers.get(name);
  if (!manager) return { success: false, error: `Silo "${name}" not found` };
  if (manager.isSleeping) return { success: true };

  await manager.sleep();

  // Persist sleeping state to config
  if (config) {
    const siloToml = config.silos[name];
    if (siloToml) {
      siloToml.sleeping = true;
      saveConfig(getDefaultConfigPath(getUserDataDir()), config);
    }
  }

  if (tray) tray.setContextMenu(buildTrayMenu());
  return { success: true };
}

async function wakeSilo(name: string): Promise<{ success: boolean; error?: string }> {
  const manager = siloManagers.get(name);
  if (!manager) return { success: false, error: `Silo "${name}" not found` };
  if (!manager.isSleeping) return { success: true };

  // Clear sleeping state in config first
  if (config) {
    const siloToml = config.silos[name];
    if (siloToml) {
      delete siloToml.sleeping;
      saveConfig(getDefaultConfigPath(getUserDataDir()), config);
    }
  }

  await manager.wake();

  if (tray) tray.setContextMenu(buildTrayMenu());
  return { success: true };
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

  // Dispose shared embedding services (terminates worker threads)
  for (const [modelId, service] of embeddingServices) {
    try {
      await service.dispose();
      console.log(`[main] Embedding service "${modelId}" disposed`);
    } catch (err) {
      console.error(`[main] Error disposing embedding service "${modelId}":`, err);
    }
  }
  embeddingServices.clear();
}

// ── Activity Event Forwarding ────────────────────────────────────────────────

function pushActivityToRenderer(event: ActivityEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('activity:push', event);
  }
}

/**
 * Set up real-time activity event forwarding from a SiloManager to the renderer.
 * Converts internal WatcherEvent objects to serializable ActivityEvent DTOs.
 */
function attachActivityForwarding(manager: SiloManager): void {
  manager.onEvent((event) => {
    pushActivityToRenderer({
      id: String(nextEventId++),
      timestamp: event.timestamp.toISOString(),
      siloName: event.siloName,
      filePath: event.filePath,
      eventType: event.eventType,
      errorMessage: event.errorMessage,
    });
  });
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

  ipcMain.handle('dialog:selectDbFile', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'SQLite Database', extensions: ['db'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:saveDbFile', async (_event, defaultName: string) => {
    const result = await dialog.showSaveDialog({
      defaultPath: defaultName,
      filters: [{ name: 'SQLite Database', extensions: ['db'] }],
    });
    return result.canceled ? null : result.filePath;
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
          modelOverride: cfg.model === resolveModelAlias(config?.embeddings.model ?? '') ? null : cfg.model,
          dbPath: cfg.dbPath,
          description: cfg.description,
        },
        indexedFileCount: status.indexedFileCount,
        chunkCount: status.chunkCount,
        lastUpdated: status.lastUpdated?.toISOString() ?? null,
        databaseSizeBytes: status.databaseSizeBytes,
        watcherState: status.watcherState,
        errorMessage: status.errorMessage,
        reconcileProgress: status.reconcileProgress,
        modelMismatch: status.modelMismatch,
        resolvedDbPath: status.resolvedDbPath,
        resolvedModel: cfg.model,
      });
    }
    return statuses;
  });

  ipcMain.handle('silos:search', async (_event, query: string, siloName?: string): Promise<SearchResult[]> => {
    const managers = siloName
      ? [[siloName, siloManagers.get(siloName)] as const].filter(([, m]) => m)
      : Array.from(siloManagers.entries());

    if (managers.length === 0) return [];

    // Group silos by their embedding model so we only embed the query
    // once per model (all built-in silos share one worker thread).
    const byModel = new Map<string, Array<[string, SiloManager]>>();
    for (const [name, manager] of managers) {
      if (!manager || manager.isSleeping || manager.hasModelMismatch()) continue;
      const model = manager.getConfig().model;
      let group = byModel.get(model);
      if (!group) {
        group = [];
        byModel.set(model, group);
      }
      group.push([name as string, manager]);
    }

    // Collect raw results with bestCosineSimilarity for cross-silo calibration
    const raw: Array<{
      filePath: string;
      rrfScore: number;
      bestCosineSimilarity: number;
      matchType: import('./shared/types').MatchType;
      chunks: SearchResult['chunks'];
      siloName: string;
    }> = [];

    // For each model group: embed once, then search all silos with the shared vector
    for (const [model, group] of byModel) {
      const service = embeddingServices.get(resolveModelAlias(model));
      if (!service) continue;

      const queryVector = await service.embed(query);

      for (const [name, manager] of group) {
        const siloResults = manager.searchWithVector(queryVector, query, 10);
        for (const r of siloResults) {
          raw.push({
            filePath: r.filePath,
            rrfScore: r.score,
            bestCosineSimilarity: r.bestCosineSimilarity,
            matchType: r.matchType,
            chunks: r.chunks,
            siloName: name,
          });
        }
      }
    }

    // Determine the set of silos that produced results
    const silosWithResults = new Set(raw.map((r) => r.siloName));
    const crossSilo = silosWithResults.size > 1;

    // Build final results, applying calibration only when merging across silos.
    // Calibrated score = RRF score × best cosine similarity.
    // This discounts high-ranking results from silos that are only weakly
    // relevant to the query (low cosine similarity) relative to silos with
    // genuinely strong matches.
    const results: SearchResult[] = raw.map((r) => ({
      filePath: r.filePath,
      score: crossSilo ? r.rrfScore * r.bestCosineSimilarity : r.rrfScore,
      matchType: r.matchType,
      chunks: r.chunks,
      siloName: r.siloName,
      rrfScore: r.rrfScore,
      bestCosineSimilarity: r.bestCosineSimilarity,
    }));

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

    // Build available models list — bundled models from registry + Ollama models
    const models: string[] = getBundledModelIds().map((id) => {
      const def = getModelDefinition(id);
      return def ? `${id} — ${def.displayName}` : id;
    });
    if (ollamaResult) {
      models.push(...ollamaResult.models);
    }

    return {
      uptimeSeconds,
      ollamaState: ollamaResult ? 'connected' : 'disconnected',
      ollamaUrl,
      availableModels: models,
      defaultModel: resolveModelAlias(config?.embeddings.model ?? 'snowflake-arctic-embed-xs'),
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

  // Delete a silo
  ipcMain.handle(
    'silos:delete',
    async (_event, name: string): Promise<{ success: boolean; error?: string }> => {
      if (!config) return { success: false, error: 'Config not loaded' };

      const manager = siloManagers.get(name);
      if (!manager) return { success: false, error: `Silo "${name}" not found` };

      // 1. Stop the silo manager (watcher, embedding service, close DB)
      try {
        await manager.stop();
      } catch (err) {
        console.error(`[main] Error stopping silo "${name}":`, err);
      }
      siloManagers.delete(name);

      // 2. Delete the database file from disk
      const siloToml = config.silos[name];
      if (siloToml) {
        const dbPath = path.isAbsolute(siloToml.db_path)
          ? siloToml.db_path
          : path.join(getUserDataDir(), siloToml.db_path);
        try {
          if (fs.existsSync(dbPath)) {
            fs.unlinkSync(dbPath);
            console.log(`[main] Deleted database file: ${dbPath}`);
          }
        } catch (err) {
          console.error(`[main] Failed to delete database file:`, err);
        }
      }

      // 3. Remove from config and persist
      delete config.silos[name];
      const configPath = getDefaultConfigPath(getUserDataDir());
      saveConfig(configPath, config);
      console.log(`[main] Silo "${name}" deleted from config`);

      // 4. Update tray menu
      if (tray) tray.setContextMenu(buildTrayMenu());

      return { success: true };
    },
  );

  // Disconnect a silo (remove from config but keep DB file on disk)
  ipcMain.handle(
    'silos:disconnect',
    async (_event, name: string): Promise<{ success: boolean; error?: string }> => {
      if (!config) return { success: false, error: 'Config not loaded' };

      const manager = siloManagers.get(name);
      if (!manager) return { success: false, error: `Silo "${name}" not found` };

      // 1. Stop the silo manager (watcher, close DB)
      try {
        await manager.stop();
      } catch (err) {
        console.error(`[main] Error stopping silo "${name}":`, err);
      }
      siloManagers.delete(name);

      // 2. Remove from config and persist (DB file is NOT deleted)
      delete config.silos[name];
      const configPath = getDefaultConfigPath(getUserDataDir());
      saveConfig(configPath, config);
      console.log(`[main] Silo "${name}" disconnected (database preserved on disk)`);

      // 3. Update tray menu and notify renderer
      if (tray) tray.setContextMenu(buildTrayMenu());
      mainWindow?.webContents.send('silos:changed');

      return { success: true };
    },
  );

  // Sleep / wake a silo
  ipcMain.handle(
    'silos:sleep',
    async (_event, name: string): Promise<{ success: boolean; error?: string }> => {
      return sleepSilo(name);
    },
  );

  ipcMain.handle(
    'silos:wake',
    async (_event, name: string): Promise<{ success: boolean; error?: string }> => {
      return wakeSilo(name);
    },
  );

  // Rebuild a silo from scratch
  ipcMain.handle(
    'silos:rebuild',
    async (_event, name: string): Promise<{ success: boolean; error?: string }> => {
      const manager = siloManagers.get(name);
      if (!manager) return { success: false, error: `Silo "${name}" not found` };
      try {
        // Ensure the embedding service matches the configured model.
        // After a model switch via silos:update, the manager still holds the
        // old service — swap it before rebuilding so the new index uses the
        // correct model and dimensions.
        const embeddingService = getOrCreateEmbeddingService(manager.getConfig().model);
        manager.updateEmbeddingService(embeddingService);

        await manager.rebuild();
        return { success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[main] Failed to rebuild silo "${name}":`, err);
        return { success: false, error: message };
      }
    },
  );

  // Update a silo's mutable fields (auto-persists to config.toml)
  ipcMain.handle(
    'silos:update',
    async (
      _event,
      name: string,
      updates: { description?: string; model?: string },
    ): Promise<{ success: boolean; error?: string }> => {
      if (!config) return { success: false, error: 'Config not loaded' };
      const siloToml = config.silos[name];
      if (!siloToml) return { success: false, error: `Silo "${name}" not found` };

      // Apply description update
      if (updates.description !== undefined) {
        siloToml.description = updates.description.trim() || undefined;
      }

      // Apply model update
      if (updates.model !== undefined) {
        const resolvedDefault = resolveModelAlias(config.embeddings.model);
        const resolvedNew = resolveModelAlias(updates.model);

        // Store as override only if it differs from the global default
        siloToml.model = resolvedNew !== resolvedDefault ? resolvedNew : undefined;

        // Hot-update the running silo manager so mismatch detection works
        const manager = siloManagers.get(name);
        if (manager) {
          manager.updateModel(resolvedNew);
        }
      }

      // Auto-persist to config.toml
      const configPath = getDefaultConfigPath(getUserDataDir());
      saveConfig(configPath, config);
      console.log(`[main] Silo "${name}" updated`);
      return { success: true };
    },
  );

  // Create a new silo
  ipcMain.handle(
    'silos:create',
    async (
      _event,
      opts: { name: string; directories: string[]; extensions: string[]; dbPath: string; model: string; description?: string },
    ): Promise<{ success: boolean; error?: string }> => {
      if (!config) return { success: false, error: 'Config not loaded' };

      const slug = opts.name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
      if (slug.length === 0) return { success: false, error: 'Invalid silo name' };
      if (siloManagers.has(slug)) return { success: false, error: `Silo "${slug}" already exists` };
      if (opts.directories.length === 0) return { success: false, error: 'At least one directory is required' };

      // Normalize model name — strip display suffixes like " — Arctic Embed XS (22MB, 384-dim)"
      const model = resolveModelAlias(opts.model.split(' — ')[0].trim());

      // Add to config and persist
      const siloToml: import('./backend/config').SiloTomlConfig = {
        directories: opts.directories,
        db_path: opts.dbPath,
        extensions: opts.extensions.length > 0 ? opts.extensions : undefined,
        model: model !== resolveModelAlias(config.embeddings.model) ? model : undefined,
        description: opts.description?.trim() || undefined,
      };

      config.silos[slug] = siloToml;
      const configPath = getDefaultConfigPath(getUserDataDir());
      saveConfig(configPath, config);
      console.log(`[main] Saved new silo "${slug}" to config`);

      // Create the silo manager and register it immediately so the UI can see it
      const resolved = resolveSiloConfig(slug, siloToml, config);
      const embeddingService = getOrCreateEmbeddingService(resolved.model);
      const manager = new SiloManager(
        resolved,
        embeddingService,
        getUserDataDir(),
      );

      siloManagers.set(slug, manager);
      attachActivityForwarding(manager);
      manager.onStateChange(() => {
        mainWindow?.webContents.send('silos:changed');
      });
      if (tray) tray.setContextMenu(buildTrayMenu());

      // Enqueue startup — if another silo is currently indexing, this one
      // will show as 'Waiting' until the queue reaches it.
      enqueueSiloStart(slug, manager);

      return { success: true };
    },
  );
}

// ── MCP Headless Mode ────────────────────────────────────────────────────────

/**
 * Start Lodestone in headless MCP mode.
 *
 * In this mode:
 * - No Electron window or tray is created
 * - stdout is reserved for MCP protocol messages (logging goes to stderr)
 * - All silos are started and awaited before accepting MCP connections
 * - The process exits when the MCP transport disconnects (stdin closes)
 */
async function startMcpMode(): Promise<void> {
  // Redirect console.log to stderr so it doesn't corrupt the stdio protocol
  const originalLog = console.log;
  console.log = (...args: unknown[]) => console.error(...args);

  console.log('[main] Starting in MCP mode (headless)');

  // Load config
  const configPath = getDefaultConfigPath(getUserDataDir());
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

  // Start all non-sleeping silos sequentially so only one embedding model
  // is loaded into memory at a time (same sequencing as GUI mode).
  const pendingManagers: Array<[string, SiloManager]> = [];
  for (const [name, siloToml] of Object.entries(config.silos)) {
    const resolved = resolveSiloConfig(name, siloToml, config);
    const embeddingService = getOrCreateEmbeddingService(resolved.model);
    const manager = new SiloManager(
      resolved,
      embeddingService,
      getUserDataDir(),
    );

    siloManagers.set(name, manager);

    if (resolved.sleeping) {
      manager.loadSleepingStatus();
      console.log(`[main] Silo "${name}" is sleeping`);
    } else {
      pendingManagers.push([name, manager]);
    }
  }

  for (const [name, manager] of pendingManagers) {
    try {
      await manager.start();
      console.log(`[main] Silo "${name}" ready`);
    } catch (err) {
      console.error(`[main] Failed to start silo "${name}":`, err);
    }
  }
  console.log(`[main] All silos ready — starting MCP server`);

  // Start the MCP server on stdio
  const stopMcp = await startMcpServer({ config, siloManagers });

  // Handle shutdown signals
  const shutdown = async () => {
    console.log('[main] Shutting down MCP mode...');
    await stopMcp();
    await shutdownBackend();
    app.quit();
  };

  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());

  // When stdin closes (MCP client disconnects), shut down
  process.stdin.on('end', () => shutdown());
}

// ── App Lifecycle ────────────────────────────────────────────────────────────

app.on('ready', () => {
  if (isMcpMode) {
    // Headless MCP mode — no window, no tray, no IPC handlers
    startMcpMode().catch((err) => {
      console.error('[main] MCP mode failed:', err);
      app.quit();
    });
    return;
  }

  // Normal GUI mode
  registerIpcHandlers();
  createWindow();
  createTray();

  // Defer backend init until the renderer has loaded so that heavy
  // reconciliation / ONNX embedding work doesn't starve the event loop
  // and leave the window blank.
  mainWindow!.webContents.once('did-finish-load', () => {
    initializeBackend().catch((err) => {
      console.error('[main] Backend initialization error:', err);
    });
  });
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
  if (isMcpMode) {
    // In MCP mode, don't quit when no windows — there are no windows
    return;
  }
  if (process.platform === 'darwin') {
    // macOS: app stays in dock
  }
  // Otherwise: app stays in tray
});

app.on('activate', () => {
  if (isMcpMode) return;
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
});
