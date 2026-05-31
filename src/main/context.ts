/**
 * AppContext — shared mutable state for the Electron main process.
 *
 * All extracted modules (window, tray, lifecycle, IPC handlers, MCP bridge)
 * receive this context object instead of accessing module-level variables.
 * The context is created once in main.ts and passed to each module's
 * registration/setup function.
 */

import { app, type BrowserWindow, type Tray } from 'electron';
import type { LodestoneConfig } from '../backend/config';
import { getDefaultLodestoneConfigPath } from '../backend/config';
import { createEmbeddingService, type EmbeddingService } from '../backend/embedding';
import type { SiloManager } from '../backend/silo-manager';
import { IndexingQueue } from '../backend/indexing-queue';
import type { InternalApi } from './internal-api';
import { resolveBundledModelDir } from './embedding-model-path';

export interface AppContext {
  config: LodestoneConfig | null;
  siloManagers: Map<string, SiloManager>;
  embeddingService: EmbeddingService | null;
  mainWindow: BrowserWindow | null;
  tray: Tray | null;
  isQuitting: boolean;
  shuttingDown: boolean;
  nextEventId: number;
  startTime: number;
  indexingQueue: IndexingQueue;
  internalApi: InternalApi | null;

  getOrCreateEmbeddingService(): EmbeddingService;
  getUserDataDir(): string;
  getBundledModelDir(): string;
  configPath(): string;
}

export function createAppContext(): AppContext {
  const ctx: AppContext = {
    config: null,
    siloManagers: new Map(),
    embeddingService: null,
    mainWindow: null,
    tray: null,
    isQuitting: false,
    shuttingDown: false,
    nextEventId: 1,
    startTime: Date.now(),
    indexingQueue: new IndexingQueue(),
    internalApi: null,

    getOrCreateEmbeddingService(): EmbeddingService {
      if (!ctx.embeddingService) {
        ctx.embeddingService = createEmbeddingService({ modelDir: ctx.getBundledModelDir() });
      }
      return ctx.embeddingService;
    },

    getUserDataDir(): string {
      return app.getPath('userData');
    },

    getBundledModelDir(): string {
      const proc = process as NodeJS.Process & { resourcesPath: string };
      return resolveBundledModelDir({
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        resourcesPath: proc.resourcesPath,
      });
    },

    configPath(): string {
      return getDefaultLodestoneConfigPath(ctx.getUserDataDir());
    },
  };

  return ctx;
}
