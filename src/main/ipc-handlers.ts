/**
 * IPC handler registration — bridges renderer ↔ main process.
 *
 * All ipcMain.handle() calls are registered here in a single function.
 * Handlers access shared state via the AppContext object.
 */

import { dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  saveConfig,
  createDefaultConfig,
  resolveSiloConfig,
  type SiloTomlConfig,
} from '../backend/config';
import { autoAssignColor, validateSiloColor, validateSiloIcon } from '../shared/silo-appearance';
import { checkOllamaConnection } from '../backend/embedding';
import { SiloManager } from '../backend/silo-manager';
import { getBundledModelIds, getModelDefinition, getModelPathSafeId, resolveModelAlias } from '../backend/model-registry';
import { calibrateAndMerge, type RawSiloResult } from '../backend/search-merge';
import type { SiloStatus, SearchResult, ActivityEvent, ServerStatus, DefaultSettings } from '../shared/types';
import type { AppContext } from './context';
import { stopSilo, wakeSilo, registerManager } from './lifecycle';
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

  // ── Database peek (for "Connect existing" wizard) ─────────────────────

  ipcMain.handle('db:readConfig', async (_event, dbPath: string) => {
    const { readConfigFromDbFile } = await import('../backend/store');
    return readConfigFromDbFile(dbPath);
  });

  // ── Silos ───────────────────────────────────────────────────────────────

  ipcMain.handle('silos:list', async (): Promise<SiloStatus[]> => {
    const statuses: SiloStatus[] = [];
    for (const manager of ctx.siloManagers.values()) {
      const status = await manager.getStatus();
      const cfg = manager.getConfig();
      const siloToml = ctx.config?.silos[cfg.name];
      statuses.push({
        config: {
          name: cfg.name,
          directories: cfg.directories,
          extensions: cfg.extensions,
          ignorePatterns: cfg.ignore,
          ignoreFilePatterns: cfg.ignoreFiles,
          hasIgnoreOverride: siloToml?.ignore !== undefined,
          hasFileIgnoreOverride: siloToml?.ignore_files !== undefined,
          hasExtensionOverride: siloToml?.extensions !== undefined,
          modelOverride: cfg.model === resolveModelAlias(ctx.config?.embeddings.model ?? '') ? null : cfg.model,
          dbPath: cfg.dbPath,
          description: cfg.description,
          color: cfg.color,
          icon: cfg.icon,
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
      if (!manager || manager.isStopped || manager.hasModelMismatch()) continue;
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

    const modelPathSafeIds = Object.fromEntries(
      getBundledModelIds().map((id) => [id, getModelPathSafeId(id)]),
    );

    return {
      uptimeSeconds,
      ollamaState: ollamaResult ? 'connected' : 'disconnected',
      ollamaUrl,
      availableModels: models,
      defaultModel: resolveModelAlias(ctx.config?.embeddings.model ?? 'snowflake-arctic-embed-xs'),
      totalIndexedFiles: totalFiles,
      modelPathSafeIds,
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

  // ── Defaults ──────────────────────────────────────────────────────────

  ipcMain.handle('defaults:get', async (): Promise<DefaultSettings> => {
    if (!ctx.config) {
      const def = createDefaultConfig();
      return {
        extensions: def.defaults.extensions,
        ignore: def.defaults.ignore,
        ignoreFiles: def.defaults.ignore_files,
        debounce: def.defaults.debounce,
      };
    }
    return {
      extensions: ctx.config.defaults.extensions,
      ignore: ctx.config.defaults.ignore,
      ignoreFiles: ctx.config.defaults.ignore_files,
      debounce: ctx.config.defaults.debounce,
    };
  });

  ipcMain.handle(
    'defaults:update',
    async (_event, updates: Partial<DefaultSettings>): Promise<{ success: boolean }> => {
      if (!ctx.config) return { success: false };

      if (updates.extensions !== undefined) ctx.config.defaults.extensions = updates.extensions;
      if (updates.ignore !== undefined) ctx.config.defaults.ignore = updates.ignore;
      if (updates.ignoreFiles !== undefined) ctx.config.defaults.ignore_files = updates.ignoreFiles;
      if (updates.debounce !== undefined) ctx.config.defaults.debounce = updates.debounce;

      saveConfig(ctx.configPath(), ctx.config);
      return { success: true };
    },
  );

  ipcMain.handle('defaults:reset-all', async (): Promise<{ success: boolean }> => {
    if (!ctx.config) return { success: false };

    // Stop all silo managers
    for (const [name, manager] of ctx.siloManagers) {
      try { await manager.stop(); } catch (err) {
        console.error(`[main] Error stopping silo "${name}" during reset:`, err);
      }
      ctx.siloManagers.delete(name);
    }

    // Replace config with clean defaults and persist
    ctx.config = createDefaultConfig();
    saveConfig(ctx.configPath(), ctx.config);
    console.log('[main] All settings reset to defaults');

    if (ctx.tray) ctx.tray.setContextMenu(buildTrayMenu(ctx));
    ctx.mainWindow?.webContents.send('silos:changed');
    return { success: true };
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
    'silos:stop',
    async (_event, name: string): Promise<{ success: boolean; error?: string }> => {
      return stopSilo(ctx, name);
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
    (_event, name: string): { success: boolean; error?: string } => {
      const manager = ctx.siloManagers.get(name);
      if (!manager) return { success: false, error: `Silo "${name}" not found` };

      const embeddingService = ctx.getOrCreateEmbeddingService(manager.getConfig().model);
      manager.updateEmbeddingService(embeddingService);

      // Fire and forget — rebuild() stops current work, then queues via the
      // IndexingQueue. The silo's watcherState updates via silos:changed events.
      manager.rebuild().catch((err) => {
        console.error(`[main] Failed to rebuild silo "${name}":`, err);
      });

      return { success: true };
    },
  );

  ipcMain.handle(
    'silos:update',
    async (
      _event,
      name: string,
      updates: { description?: string; model?: string; ignore?: string[]; ignoreFiles?: string[]; extensions?: string[]; color?: string; icon?: string },
    ): Promise<{ success: boolean; error?: string }> => {
      if (!ctx.config) return { success: false, error: 'Config not loaded' };
      const siloToml = ctx.config.silos[name];
      if (!siloToml) return { success: false, error: `Silo "${name}" not found` };

      if (updates.description !== undefined) {
        siloToml.description = updates.description.trim() || undefined;
        const manager = ctx.siloManagers.get(name);
        if (manager) {
          manager.updateDescription(updates.description.trim());
        }
      }

      if (updates.color !== undefined) {
        const validated = validateSiloColor(updates.color);
        siloToml.color = validated;
        const manager = ctx.siloManagers.get(name);
        if (manager) manager.updateColor(validated);
      }

      if (updates.icon !== undefined) {
        const validated = validateSiloIcon(updates.icon);
        siloToml.icon = validated;
        const manager = ctx.siloManagers.get(name);
        if (manager) manager.updateIcon(validated);
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

      // Ignore pattern updates — empty array means "revert to defaults"
      if (updates.ignore !== undefined) {
        siloToml.ignore = updates.ignore.length > 0 ? updates.ignore : undefined;
      }
      if (updates.ignoreFiles !== undefined) {
        siloToml.ignore_files = updates.ignoreFiles.length > 0 ? updates.ignoreFiles : undefined;
      }

      // Extension updates — empty array means "revert to defaults"
      if (updates.extensions !== undefined) {
        siloToml.extensions = updates.extensions.length > 0 ? updates.extensions : undefined;
      }

      // Hot-swap the watcher if ignore patterns changed
      if (updates.ignore !== undefined || updates.ignoreFiles !== undefined) {
        const manager = ctx.siloManagers.get(name);
        if (manager) {
          const resolved = resolveSiloConfig(name, siloToml, ctx.config);
          await manager.updateIgnorePatterns(resolved.ignore, resolved.ignoreFiles);
        }
      }

      // Hot-swap the watcher if extensions changed
      if (updates.extensions !== undefined) {
        const manager = ctx.siloManagers.get(name);
        if (manager) {
          const resolved = resolveSiloConfig(name, siloToml, ctx.config);
          await manager.updateExtensions(resolved.extensions);
        }
      }

      saveConfig(ctx.configPath(), ctx.config);
      console.log(`[main] Silo "${name}" updated`);
      return { success: true };
    },
  );

  ipcMain.handle(
    'silos:rename',
    async (_event, oldName: string, newName: string): Promise<{ success: boolean; error?: string }> => {
      if (!ctx.config) return { success: false, error: 'Config not loaded' };

      const trimmed = newName.trim();
      if (!trimmed) return { success: false, error: 'Name cannot be empty' };

      const newSlug = trimmed.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
      if (!newSlug) return { success: false, error: 'Invalid name' };

      const manager = ctx.siloManagers.get(oldName);
      const siloToml = ctx.config.silos[oldName];
      if (!manager || !siloToml) return { success: false, error: `Silo "${oldName}" not found` };

      // No-op if the slug is unchanged
      if (newSlug !== oldName) {
        if (ctx.siloManagers.has(newSlug)) {
          return { success: false, error: `A silo named "${newSlug}" already exists` };
        }
        // Move config entry
        ctx.config.silos[newSlug] = siloToml;
        delete ctx.config.silos[oldName];
        // Move manager entry
        ctx.siloManagers.set(newSlug, manager);
        ctx.siloManagers.delete(oldName);
      }

      // Update the manager's internal config name to match the new slug
      manager.updateName(newSlug);

      saveConfig(ctx.configPath(), ctx.config);
      console.log(`[main] Silo "${oldName}" renamed to "${trimmed}" (slug: "${newSlug}")`);

      if (ctx.tray) ctx.tray.setContextMenu(buildTrayMenu(ctx));
      ctx.mainWindow?.webContents.send('silos:changed');
      return { success: true };
    },
  );

  ipcMain.handle(
    'silos:create',
    async (
      _event,
      opts: { name: string; directories: string[]; extensions: string[]; dbPath: string; model: string; description?: string; color?: string; icon?: string },
    ): Promise<{ success: boolean; error?: string }> => {
      if (!ctx.config) return { success: false, error: 'Config not loaded' };

      const slug = opts.name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
      if (slug.length === 0) return { success: false, error: 'Invalid silo name' };
      if (ctx.siloManagers.has(slug)) return { success: false, error: `Silo "${slug}" already exists` };
      if (opts.directories.length === 0) return { success: false, error: 'At least one directory is required' };

      const resolvedDbPath = path.isAbsolute(opts.dbPath)
        ? opts.dbPath
        : path.join(ctx.getUserDataDir(), opts.dbPath);
      if (fs.existsSync(resolvedDbPath)) {
        return {
          success: false,
          error: `A database file already exists at that path. Use "Connect existing silo" to attach it, or choose a different path.`,
        };
      }

      const model = resolveModelAlias(opts.model.split(' — ')[0].trim());

      // Auto-assign colour if not provided, cycling through the palette
      const color = opts.color
        ? validateSiloColor(opts.color)
        : autoAssignColor(ctx.siloManagers.size);
      const icon = opts.icon ? validateSiloIcon(opts.icon) : undefined;

      const siloToml: SiloTomlConfig = {
        directories: opts.directories,
        db_path: opts.dbPath,
        extensions: opts.extensions.length > 0 ? opts.extensions : undefined,
        model: model !== resolveModelAlias(ctx.config.embeddings.model) ? model : undefined,
        description: opts.description?.trim() || undefined,
        color,
        icon: icon ?? undefined,
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
