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
import type { InternalApi } from './internal-api';

export interface AppContext {
  config: LodestoneConfig | null;
  siloManagers: Map<string, SiloManager>;
  embeddingServices: Map<string, EmbeddingService>;
  mainWindow: BrowserWindow | null;
  tray: Tray | null;
  isQuitting: boolean;
  shuttingDown: boolean;
  nextEventId: number;
  startTime: number;
  indexingQueue: IndexingQueue;
  internalApi: InternalApi | null;

  getOrCreateEmbeddingService(model: string): EmbeddingService;
  getUserDataDir(): string;
  getModelCacheDir(): string;
  configPath(): string;
}

export function createAppContext(): AppContext {
  const ctx: AppContext = {
    config: null,
    siloManagers: new Map(),
    embeddingServices: new Map(),
    mainWindow: null,
    tray: null,
    isQuitting: false,
    shuttingDown: false,
    nextEventId: 1,
    startTime: Date.now(),
    indexingQueue: new IndexingQueue(),
    internalApi: null,

    getOrCreateEmbeddingService(model: string): EmbeddingService {
      const modelId = resolveModelAlias(model);
      let service = ctx.embeddingServices.get(modelId);
      if (!service) {
        service = createEmbeddingService({
          model: modelId,
          modelCacheDir: ctx.getModelCacheDir(),
        });
        ctx.embeddingServices.set(modelId, service);
      }
      return service;
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
