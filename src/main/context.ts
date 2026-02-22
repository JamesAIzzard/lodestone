/**
 * AppContext — shared mutable state for the Electron main process.
 *
 * All extracted modules (window, tray, lifecycle, IPC handlers, MCP mode)
 * receive this context object instead of accessing module-level variables.
 * The context is created once in main.ts and passed to each module's
 * registration/setup function.
 */

import { app, type BrowserWindow, type Tray } from 'electron';
import path from 'node:path';
import type { LodestoneConfig } from '../backend/config';
import { getDefaultConfigPath } from '../backend/config';
import { createEmbeddingService, type EmbeddingService } from '../backend/embedding';
import { resolveModelAlias } from '../backend/model-registry';
import type { SiloManager } from '../backend/silo-manager';
import { IndexingQueue } from '../backend/indexing-queue';

export interface AppContext {
  config: LodestoneConfig | null;
  siloManagers: Map<string, SiloManager>;
  embeddingServices: Map<string, EmbeddingService>;
  mainWindow: BrowserWindow | null;
  tray: Tray | null;
  isQuitting: boolean;
  isMcpMode: boolean;
  nextEventId: number;
  startTime: number;
  indexingQueue: IndexingQueue;

  getOrCreateEmbeddingService(model: string): EmbeddingService;
  enqueueSiloStart(name: string, manager: SiloManager): void;
  getUserDataDir(): string;
  getModelCacheDir(): string;
  configPath(): string;
}

export function createAppContext(isMcpMode: boolean): AppContext {
  const ctx: AppContext = {
    config: null,
    siloManagers: new Map(),
    embeddingServices: new Map(),
    mainWindow: null,
    tray: null,
    isQuitting: false,
    isMcpMode,
    nextEventId: 1,
    startTime: Date.now(),
    indexingQueue: new IndexingQueue(),

    getOrCreateEmbeddingService(model: string): EmbeddingService {
      const modelId = resolveModelAlias(model);
      let service = ctx.embeddingServices.get(modelId);
      if (!service) {
        service = createEmbeddingService({
          model: modelId,
          ollamaUrl: ctx.config?.embeddings.ollama_url ?? 'http://localhost:11434',
          modelCacheDir: ctx.getModelCacheDir(),
        });
        ctx.embeddingServices.set(modelId, service);
      }
      return service;
    },

    enqueueSiloStart(name: string, manager: SiloManager): void {
      manager.loadWaitingStatus();
      manager.start().catch((err) => {
        console.error(`[main] Failed to start silo "${name}":`, err);
      });
    },

    getUserDataDir(): string {
      return app.getPath('userData');
    },

    getModelCacheDir(): string {
      return path.join(ctx.getUserDataDir(), 'model-cache');
    },

    configPath(): string {
      return getDefaultConfigPath(ctx.getUserDataDir());
    },
  };

  return ctx;
}
