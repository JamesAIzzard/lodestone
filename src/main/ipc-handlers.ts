/**
 * IPC handler registration — bridges renderer ↔ main process.
 *
 * All ipcMain.handle() calls are registered here in a single function.
 * Handlers access shared state via the AppContext object.
 */

import { dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import {
  saveConfig,
  type SiloTomlConfig,
} from '../backend/config';
import { checkOllamaConnection } from '../backend/embedding';
import { SiloManager } from '../backend/silo-manager';
import { getBundledModelIds, getModelDefinition, resolveModelAlias } from '../backend/model-registry';
import { calibrateAndMerge, type RawSiloResult } from '../backend/search-merge';
import type { SiloStatus, SearchResult, ActivityEvent, ServerStatus } from '../shared/types';
import type { AppContext } from './context';
import { sleepSilo, wakeSilo, registerManager } from './lifecycle';
import { buildTrayMenu } from './tray';

export function registerIpcHandlers(ctx: AppContext): void {
  // ── Dialog & Shell ──────────────────────────────────────────────────────

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

  // ── Silos ───────────────────────────────────────────────────────────────

  ipcMain.handle('silos:list', async (): Promise<SiloStatus[]> => {
    const statuses: SiloStatus[] = [];
    for (const manager of ctx.siloManagers.values()) {
      const status = await manager.getStatus();
      const cfg = manager.getConfig();
      statuses.push({
        config: {
          name: cfg.name,
          directories: cfg.directories,
          extensions: cfg.extensions,
          ignorePatterns: cfg.ignore,
          modelOverride: cfg.model === resolveModelAlias(ctx.config?.embeddings.model ?? '') ? null : cfg.model,
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
      ? [[siloName, ctx.siloManagers.get(siloName)] as const].filter(([, m]) => m)
      : Array.from(ctx.siloManagers.entries());

    if (managers.length === 0) return [];

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

    const raw: RawSiloResult[] = [];

    for (const [model, group] of byModel) {
      const service = ctx.embeddingServices.get(resolveModelAlias(model));
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

    const merged = calibrateAndMerge(raw);
    merged.sort((a, b) => b.score - a.score);

    const results: SearchResult[] = merged.slice(0, 20).map((r) => ({
      filePath: r.filePath,
      score: r.score,
      matchType: r.matchType,
      chunks: r.chunks,
      siloName: r.siloName,
      rrfScore: r.rrfScore,
      bestCosineSimilarity: r.bestCosineSimilarity,
    }));

    return results;
  });

  // ── Activity ────────────────────────────────────────────────────────────

  ipcMain.handle('activity:recent', async (_event, limit: number = 50): Promise<ActivityEvent[]> => {
    const allEvents: ActivityEvent[] = [];
    for (const manager of ctx.siloManagers.values()) {
      const feed = manager.getActivityFeed(limit);
      for (const e of feed) {
        allEvents.push({
          id: String(ctx.nextEventId++),
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

  // ── Server / Settings ───────────────────────────────────────────────────

  ipcMain.handle('server:status', async (): Promise<ServerStatus> => {
    const uptimeSeconds = Math.floor((Date.now() - ctx.startTime) / 1000);

    const ollamaUrl = ctx.config?.embeddings.ollama_url ?? 'http://localhost:11434';
    const ollamaResult = await checkOllamaConnection(ollamaUrl);

    let totalFiles = 0;
    for (const manager of ctx.siloManagers.values()) {
      const status = await manager.getStatus();
      totalFiles += status.indexedFileCount;
    }

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
      defaultModel: resolveModelAlias(ctx.config?.embeddings.model ?? 'snowflake-arctic-embed-xs'),
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
    return ctx.configPath();
  });

  // ── Silo CRUD ───────────────────────────────────────────────────────────

  ipcMain.handle(
    'silos:delete',
    async (_event, name: string): Promise<{ success: boolean; error?: string }> => {
      if (!ctx.config) return { success: false, error: 'Config not loaded' };

      const manager = ctx.siloManagers.get(name);
      if (!manager) return { success: false, error: `Silo "${name}" not found` };

      try {
        await manager.stop();
      } catch (err) {
        console.error(`[main] Error stopping silo "${name}":`, err);
      }
      ctx.siloManagers.delete(name);

      const resolvedDbPath = manager.getStatus().resolvedDbPath;
      let dbDeleteError: string | undefined;
      try {
        if (fs.existsSync(resolvedDbPath)) {
          fs.unlinkSync(resolvedDbPath);
          console.log(`[main] Deleted database file: ${resolvedDbPath}`);
        }
        for (const suffix of ['-wal', '-shm']) {
          const companion = resolvedDbPath + suffix;
          if (fs.existsSync(companion)) fs.unlinkSync(companion);
        }
      } catch (err) {
        dbDeleteError = err instanceof Error ? err.message : String(err);
        console.error(`[main] Failed to delete database file:`, err);
      }

      delete ctx.config.silos[name];
      saveConfig(ctx.configPath(), ctx.config);
      console.log(`[main] Silo "${name}" deleted from config`);

      if (ctx.tray) ctx.tray.setContextMenu(buildTrayMenu(ctx));
      ctx.mainWindow?.webContents.send('silos:changed');

      if (dbDeleteError) {
        return { success: false, error: `Silo removed but database file could not be deleted: ${dbDeleteError}` };
      }
      return { success: true };
    },
  );

  ipcMain.handle(
    'silos:disconnect',
    async (_event, name: string): Promise<{ success: boolean; error?: string }> => {
      if (!ctx.config) return { success: false, error: 'Config not loaded' };

      const manager = ctx.siloManagers.get(name);
      if (!manager) return { success: false, error: `Silo "${name}" not found` };

      try {
        await manager.stop();
      } catch (err) {
        console.error(`[main] Error stopping silo "${name}":`, err);
      }
      ctx.siloManagers.delete(name);

      delete ctx.config.silos[name];
      saveConfig(ctx.configPath(), ctx.config);
      console.log(`[main] Silo "${name}" disconnected (database preserved on disk)`);

      if (ctx.tray) ctx.tray.setContextMenu(buildTrayMenu(ctx));
      ctx.mainWindow?.webContents.send('silos:changed');

      return { success: true };
    },
  );

  ipcMain.handle(
    'silos:sleep',
    async (_event, name: string): Promise<{ success: boolean; error?: string }> => {
      return sleepSilo(ctx, name);
    },
  );

  ipcMain.handle(
    'silos:wake',
    async (_event, name: string): Promise<{ success: boolean; error?: string }> => {
      return wakeSilo(ctx, name);
    },
  );

  ipcMain.handle(
    'silos:rebuild',
    async (_event, name: string): Promise<{ success: boolean; error?: string }> => {
      const manager = ctx.siloManagers.get(name);
      if (!manager) return { success: false, error: `Silo "${name}" not found` };
      try {
        const embeddingService = ctx.getOrCreateEmbeddingService(manager.getConfig().model);
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

  ipcMain.handle(
    'silos:update',
    async (
      _event,
      name: string,
      updates: { description?: string; model?: string },
    ): Promise<{ success: boolean; error?: string }> => {
      if (!ctx.config) return { success: false, error: 'Config not loaded' };
      const siloToml = ctx.config.silos[name];
      if (!siloToml) return { success: false, error: `Silo "${name}" not found` };

      if (updates.description !== undefined) {
        siloToml.description = updates.description.trim() || undefined;
      }

      if (updates.model !== undefined) {
        const resolvedDefault = resolveModelAlias(ctx.config.embeddings.model);
        const resolvedNew = resolveModelAlias(updates.model);

        siloToml.model = resolvedNew !== resolvedDefault ? resolvedNew : undefined;

        const manager = ctx.siloManagers.get(name);
        if (manager) {
          manager.updateModel(resolvedNew);
        }
      }

      saveConfig(ctx.configPath(), ctx.config);
      console.log(`[main] Silo "${name}" updated`);
      return { success: true };
    },
  );

  ipcMain.handle(
    'silos:create',
    async (
      _event,
      opts: { name: string; directories: string[]; extensions: string[]; dbPath: string; model: string; description?: string },
    ): Promise<{ success: boolean; error?: string }> => {
      if (!ctx.config) return { success: false, error: 'Config not loaded' };

      const slug = opts.name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
      if (slug.length === 0) return { success: false, error: 'Invalid silo name' };
      if (ctx.siloManagers.has(slug)) return { success: false, error: `Silo "${slug}" already exists` };
      if (opts.directories.length === 0) return { success: false, error: 'At least one directory is required' };

      const model = resolveModelAlias(opts.model.split(' — ')[0].trim());

      const siloToml: SiloTomlConfig = {
        directories: opts.directories,
        db_path: opts.dbPath,
        extensions: opts.extensions.length > 0 ? opts.extensions : undefined,
        model: model !== resolveModelAlias(ctx.config.embeddings.model) ? model : undefined,
        description: opts.description?.trim() || undefined,
      };

      ctx.config.silos[slug] = siloToml;
      saveConfig(ctx.configPath(), ctx.config);
      console.log(`[main] Saved new silo "${slug}" to config`);

      registerManager(ctx, slug, siloToml);

      if (ctx.tray) ctx.tray.setContextMenu(buildTrayMenu(ctx));

      return { success: true };
    },
  );
}
