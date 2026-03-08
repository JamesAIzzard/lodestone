/**
 * IPC handler registration — bridges renderer ↔ main process.
 *
 * All ipcMain.handle() calls are registered here. Handlers are grouped
 * into domain-specific registration functions for readability and all
 * share the `cloudRequest` helper for cloud API calls.
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
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
import type { SiloManager } from '../backend/silo-manager';
import { getBundledModelIds, getModelDefinition, getModelPathSafeId, resolveModelAlias } from '../backend/model-registry';
import { dispatchExplore, mergeDirectoryResults, dispatchSearch, mergeSearchResults } from '../backend/search-merge';
import type { SiloStatus, SearchResult, DirectoryResult, ActivityEvent, ServerStatus, DefaultSettings, ExploreParams, SearchParams } from '../shared/types';
import type { AppContext } from './context';
import { stopSilo, wakeSilo, registerManager, notifySilosChanged } from './lifecycle';

function getCloudHeaders(ctx: AppContext): Record<string, string> {
  const token = ctx.config?.memory.cloud_auth_token;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function cloudRequest<T = Record<string, unknown>>(
  ctx: AppContext,
  path: string,
  method: string = 'GET',
  body?: unknown,
): Promise<T & { success: boolean; error?: string }> {
  const cloudUrl = ctx.config?.memory.cloud_url;
  if (!cloudUrl) return { success: false, error: 'No cloud URL configured' } as any;
  try {
    const res = await fetch(`${cloudUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: getCloudHeaders(ctx),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { success: false, error: `${res.status}: ${await res.text()}` } as any;
    return await res.json();
  } catch (err) {
    return { success: false, error: String(err) } as any;
  }
}

// ── Domain-grouped handler registrations ────────────────────────────────

function registerDialogHandlers(ctx: AppContext): void {
  ipcMain.handle('dialog:selectDirectories', async (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(win as BrowserWindow, {
      properties: ['openDirectory', 'multiSelections'],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('dialog:selectDbFile', async (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(win as BrowserWindow, {
      properties: ['openFile'],
      filters: [{ name: 'SQLite Database', extensions: ['db'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:saveDbFile', async (_event, defaultName: string) => {
    const win = BrowserWindow.fromWebContents(_event.sender) ?? undefined;
    const result = await dialog.showSaveDialog(win as BrowserWindow, {
      defaultPath: defaultName,
      filters: [{ name: 'SQLite Database', extensions: ['db'] }],
    });
    return result.canceled ? null : result.filePath;
  });

  ipcMain.handle('shell:openPath', async (_event, filePath: string) => {
    await shell.openPath(filePath);
  });

  ipcMain.handle('shell:showItemInFolder', (_event, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  // ── Database peek (for "Connect existing" wizard) ─────────────────────

  ipcMain.handle('db:readConfig', async (_event, dbPath: string) => {
    const { readConfigFromDbFile } = await import('../backend/store/peek');
    return readConfigFromDbFile(dbPath);
  });
}

function registerSiloHandlers(ctx: AppContext): void {
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

  ipcMain.handle('silos:search', async (_event, params: SearchParams, siloName?: string): Promise<SearchResult[]> => {
    // Collect searchable managers — skip stopped and model-mismatched silos
    const ready: [string, SiloManager][] = [];
    if (siloName) {
      const m = ctx.siloManagers.get(siloName);
      if (m && !m.isStopped && !m.hasModelMismatch()) ready.push([siloName, m]);
    } else {
      for (const [name, m] of ctx.siloManagers) {
        if (!m.isStopped && !m.hasModelMismatch()) ready.push([name, m]);
      }
    }

    if (ready.length === 0) return [];

    const limit = params.limit ?? 10;
    const mode = params.mode ?? 'hybrid';

    // Filepath and regex modes can search any ready silo; other modes need an embedding service
    const searchable = mode === 'regex' || mode === 'filepath'
      ? ready
      : ready.filter(([, m]) => m.getEmbeddingService() !== null);

    if (searchable.length === 0) return [];

    const raw = await dispatchSearch(
      params,
      searchable,
      (model) => ctx.embeddingServices.get(resolveModelAlias(model)) ?? null,
    );

    const merged = mergeSearchResults(raw, limit);

    return merged.map((r) => ({
      filePath: r.filePath,
      siloName: r.siloName,
      score: r.score,
      scoreLabel: r.scoreLabel,
      signals: r.signals,
      hint: r.hint,
      chunks: r.chunks,
    }));
  });

  ipcMain.handle('silos:explore', async (_event, params: ExploreParams): Promise<DirectoryResult[]> => {
    // Collect searchable managers — skip stopped and model-mismatched silos
    const ready: [string, SiloManager][] = [];
    if (params.silo) {
      const m = ctx.siloManagers.get(params.silo);
      if (m && !m.isStopped && !m.hasModelMismatch()) ready.push([params.silo, m]);
    } else {
      for (const [name, m] of ctx.siloManagers) {
        if (!m.isStopped && !m.hasModelMismatch()) ready.push([name, m]);
      }
    }

    if (ready.length === 0) return [];

    const raw = await dispatchExplore(params, ready);
    const merged = mergeDirectoryResults(raw, params.maxResults ?? 10);

    return merged.map((r) => ({
      dirPath: r.dirPath,
      dirName: r.dirName,
      siloName: r.siloName,
      score: r.score,
      scoreSource: r.scoreSource,
      axes: r.axes,
      fileCount: r.fileCount,
      subdirCount: r.subdirCount,
      depth: r.depth,
      children: r.children,
      files: r.files,
    }));
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

      const resolvedDbPath = (await manager.getStatus()).resolvedDbPath;
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

      notifySilosChanged(ctx);

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

      notifySilosChanged(ctx);

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
    'silos:rescan',
    (_event, name: string): { success: boolean; error?: string } => {
      const manager = ctx.siloManagers.get(name);
      if (!manager) return { success: false, error: `Silo "${name}" not found` };

      // Fire and forget — rescan() re-walks directories and indexes changes
      // without deleting the DB. State updates via silos:changed events.
      manager.rescan().catch((err) => {
        console.error(`[main] Failed to rescan silo "${name}":`, err);
      });

      return { success: true };
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

      const manager = ctx.siloManagers.get(name);

      if (updates.description !== undefined) {
        siloToml.description = updates.description.trim() || undefined;
        await manager?.updateDescription(updates.description.trim());
      }

      if (updates.color !== undefined) {
        const validated = validateSiloColor(updates.color);
        siloToml.color = validated;
        await manager?.updateColor(validated);
      }

      if (updates.icon !== undefined) {
        const validated = validateSiloIcon(updates.icon);
        siloToml.icon = validated;
        await manager?.updateIcon(validated);
      }

      if (updates.model !== undefined) {
        const resolvedDefault = resolveModelAlias(ctx.config.embeddings.model);
        const resolvedNew = resolveModelAlias(updates.model);
        siloToml.model = resolvedNew !== resolvedDefault ? resolvedNew : undefined;
        await manager?.updateModel(resolvedNew);
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

      // Hot-swap the watcher if ignore patterns or extensions changed
      if (manager) {
        if (updates.ignore !== undefined || updates.ignoreFiles !== undefined) {
          const resolved = resolveSiloConfig(name, siloToml, ctx.config);
          await manager.updateIgnorePatterns(resolved.ignore, resolved.ignoreFiles);
        }
        if (updates.extensions !== undefined) {
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
      await manager.updateName(newSlug);

      saveConfig(ctx.configPath(), ctx.config);
      console.log(`[main] Silo "${oldName}" renamed to "${trimmed}" (slug: "${newSlug}")`);

      notifySilosChanged(ctx);
      return { success: true };
    },
  );

  ipcMain.handle(
    'silos:create',
    async (
      _event,
      opts: { name: string; directories: string[]; extensions: string[]; dbPath: string; model: string; description?: string; color?: string; icon?: string; mode?: 'new' | 'existing' },
    ): Promise<{ success: boolean; error?: string }> => {
      if (!ctx.config) return { success: false, error: 'Config not loaded' };

      const slug = opts.name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
      if (slug.length === 0) return { success: false, error: 'Invalid silo name' };
      if (ctx.siloManagers.has(slug)) return { success: false, error: `Silo "${slug}" already exists` };
      if (opts.directories.length === 0) return { success: false, error: 'At least one directory is required' };

      const resolvedDbPath = path.isAbsolute(opts.dbPath)
        ? opts.dbPath
        : path.join(ctx.getUserDataDir(), opts.dbPath);
      if (opts.mode !== 'existing' && fs.existsSync(resolvedDbPath)) {
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

      notifySilosChanged(ctx);

      return { success: true };
    },
  );
}

function registerCloudTaskHandlers(ctx: AppContext): void {
  ipcMain.handle('tasks:list', async (_event, opts: { includeCompleted?: boolean; includeCancelled?: boolean; projectId?: number } = {}): Promise<{ success: boolean; tasks: unknown[]; error?: string }> => {
    const params = new URLSearchParams();
    if (opts.includeCompleted) params.set('includeCompleted', 'true');
    if (opts.includeCancelled) params.set('includeCancelled', 'true');
    if (opts.projectId !== undefined) params.set('projectId', String(opts.projectId));
    const result = await cloudRequest<{ tasks: unknown[] }>(ctx, `/tasks?${params}`);
    if (!result.success) return { success: false, tasks: [], error: result.error };
    return { success: true, tasks: result.tasks };
  });

  ipcMain.handle('tasks:search', async (_event, query: string): Promise<{ success: boolean; tasks: unknown[]; error?: string }> => {
    const params = new URLSearchParams({ q: query });
    const result = await cloudRequest<{ tasks: unknown[] }>(ctx, `/tasks?${params}`);
    if (!result.success) return { success: false, tasks: [], error: result.error };
    return { success: true, tasks: result.tasks };
  });

  ipcMain.handle('tasks:revise', async (_event, id: number, fields: Record<string, unknown>): Promise<{ success: boolean; completionRecordId?: number; nextActionDate?: string; error?: string }> => {
    const result = await cloudRequest<{ completionRecordId?: number; nextActionDate?: string }>(ctx, `/tasks/${id}`, 'PATCH', fields);
    if (!result.success) {
      console.error(`[ipc] tasks:revise PATCH failed for task ${id}: ${result.error}`);
    }
    return result;
  });

  ipcMain.handle('tasks:skip', async (_event, id: number, reason?: string): Promise<{ success: boolean; nextActionDate?: string; error?: string }> => {
    return cloudRequest(ctx, `/tasks/${id}/skip`, 'POST', { reason });
  });

  ipcMain.handle('tasks:create', async (_event, topic: string, projectId?: number): Promise<{ success: boolean; id?: number; error?: string }> => {
    return cloudRequest(ctx, '/tasks', 'POST', { topic, ...(projectId !== undefined && { projectId }) });
  });

  ipcMain.handle('tasks:delete', async (_event, id: number): Promise<{ success: boolean; error?: string }> => {
    const result = await cloudRequest(ctx, `/tasks/${id}`, 'DELETE');
    if (!result.success) return result;
    return { success: true };
  });

  ipcMain.handle('tasks:update-day-order', async (_event, taskId: number, actionDate: string, position: number): Promise<{ success: boolean; error?: string }> => {
    const result = await cloudRequest(ctx, `/tasks/${taskId}/day-order`, 'PUT', { actionDate, position });
    if (!result.success) return result;
    return { success: true };
  });

  ipcMain.handle('tasks:delete-day-order', async (_event, taskId: number): Promise<{ success: boolean; error?: string }> => {
    const result = await cloudRequest(ctx, `/tasks/${taskId}/day-order`, 'DELETE');
    if (!result.success) return result;
    return { success: true };
  });
}

function registerCloudProjectHandlers(ctx: AppContext): void {
  ipcMain.handle('projects:list', async (_event, opts?: { includeArchived?: boolean }): Promise<{ success: boolean; projects: unknown[]; error?: string }> => {
    const qs = opts?.includeArchived ? '?includeArchived=true' : '';
    const result = await cloudRequest<{ projects: unknown[] }>(ctx, `/projects${qs}`);
    if (!result.success) return { success: false, projects: [], error: result.error };
    return { success: true, projects: result.projects };
  });

  ipcMain.handle('projects:create', async (_event, name: string, color?: string): Promise<{ success: boolean; id?: number; error?: string }> => {
    return cloudRequest(ctx, '/projects', 'POST', { name, color });
  });

  ipcMain.handle('projects:update', async (_event, id: number, updates: { name?: string; color?: string }): Promise<{ success: boolean; error?: string }> => {
    const result = await cloudRequest(ctx, `/projects/${id}`, 'PATCH', updates);
    if (!result.success) return result;
    return { success: true };
  });

  ipcMain.handle('projects:delete', async (_event, id: number): Promise<{ success: boolean; error?: string }> => {
    const result = await cloudRequest(ctx, `/projects/${id}`, 'DELETE');
    if (!result.success) return result;
    return { success: true };
  });

  ipcMain.handle('projects:merge', async (_event, sourceId: number, targetId: number): Promise<{ success: boolean; reassigned?: number; error?: string }> => {
    return cloudRequest(ctx, `/projects/${sourceId}/merge`, 'POST', { targetId });
  });

  ipcMain.handle('projects:archive', async (_event, id: number): Promise<{ success: boolean; error?: string }> => {
    const result = await cloudRequest(ctx, `/projects/${id}/archive`, 'POST');
    if (!result.success) return result;
    return { success: true };
  });

  ipcMain.handle('projects:unarchive', async (_event, id: number): Promise<{ success: boolean; error?: string }> => {
    const result = await cloudRequest(ctx, `/projects/${id}/unarchive`, 'POST');
    if (!result.success) return result;
    return { success: true };
  });
}

function registerSettingsHandlers(ctx: AppContext): void {
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

    // Cloud memories health check
    const cloudUrl = ctx.config?.memory.cloud_url ?? null;
    let cloudConnected = false;
    if (cloudUrl) {
      try {
        const res = await fetch(`${cloudUrl.replace(/\/$/, '')}/health`, {
          signal: AbortSignal.timeout(5000),
        });
        cloudConnected = res.ok;
      } catch {
        cloudConnected = false;
      }
    }

    return {
      uptimeSeconds,
      ollamaState: ollamaResult ? 'connected' : 'disconnected',
      ollamaUrl,
      availableModels: models,
      defaultModel: resolveModelAlias(ctx.config?.embeddings.model ?? 'snowflake-arctic-embed-xs'),
      totalIndexedFiles: totalFiles,
      modelPathSafeIds,
      cloudUrl,
      cloudConnected,
      cloudAuthToken: ctx.config?.memory.cloud_auth_token ?? null,
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

  ipcMain.handle('data:dir', async (): Promise<string> => {
    return ctx.getUserDataDir();
  });

  ipcMain.handle('app:version', (): string => {
    return app.getVersion();
  });

  ipcMain.handle('cloud:setUrl', async (_event, url: string): Promise<{ success: boolean }> => {
    if (!ctx.config) return { success: false };
    const trimmed = url.trim();
    ctx.config.memory.cloud_url = trimmed || undefined;
    saveConfig(ctx.configPath(), ctx.config);
    return { success: true };
  });

  ipcMain.handle('cloud:setAuthToken', async (_event, token: string): Promise<{ success: boolean }> => {
    if (!ctx.config) return { success: false };
    ctx.config.memory.cloud_auth_token = token.trim() || undefined;
    saveConfig(ctx.configPath(), ctx.config);
    return { success: true };
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
        contextLines: def.defaults.context_lines,
        activityLogLimit: def.defaults.activity_log_limit,
      };
    }
    return {
      extensions: ctx.config.defaults.extensions,
      ignore: ctx.config.defaults.ignore,
      ignoreFiles: ctx.config.defaults.ignore_files,
      debounce: ctx.config.defaults.debounce,
      contextLines: ctx.config.defaults.context_lines,
      activityLogLimit: ctx.config.defaults.activity_log_limit,
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
      if (updates.contextLines !== undefined) ctx.config.defaults.context_lines = updates.contextLines;
      if (updates.activityLogLimit !== undefined) ctx.config.defaults.activity_log_limit = updates.activityLogLimit;

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

    notifySilosChanged(ctx);
    return { success: true };
  });
}

function registerMcpHandlers(ctx: AppContext): void {
  function getClaudeDesktopConfigPath(): string {
    return path.join(app.getPath('appData'), 'Claude', 'claude_desktop_config.json');
  }

  function getMcpWrapperPath(): string {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'mcp-wrapper.js')
      : path.join(app.getAppPath(), 'mcp-wrapper.js');
  }

  ipcMain.handle('mcp:getClaudeDesktopStatus', async (): Promise<{
    configPath: string;
    hasClaudeDesktop: boolean;
    isConfigured: boolean;
  }> => {
    const configPath = getClaudeDesktopConfigPath();
    const hasClaudeDesktop = fs.existsSync(path.dirname(configPath));
    let isConfigured = false;
    try {
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        isConfigured = !!parsed?.mcpServers?.['lodestone-files'];
      }
    } catch {
      // Malformed JSON — treat as not configured
    }
    return { configPath, hasClaudeDesktop, isConfigured };
  });

  ipcMain.handle('mcp:configureClaudeDesktop', async (): Promise<{
    success: boolean;
    configPath: string;
    error?: string;
  }> => {
    const configPath = getClaudeDesktopConfigPath();
    const wrapperPath = getMcpWrapperPath();
    try {
      let config: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        try {
          config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        } catch {
          // Malformed JSON — start fresh
        }
      }
      const mcpServers = (config.mcpServers as Record<string, unknown>) ?? {};
      config.mcpServers = {
        ...mcpServers,
        'lodestone-files': { command: 'node', args: [wrapperPath] },
      };
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      return { success: true, configPath };
    } catch (err) {
      return { success: false, configPath, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

// ── Public entry point ──────────────────────────────────────────────────

export function registerIpcHandlers(ctx: AppContext): void {
  registerDialogHandlers(ctx);
  registerSiloHandlers(ctx);
  registerCloudTaskHandlers(ctx);
  registerCloudProjectHandlers(ctx);
  registerSettingsHandlers(ctx);
  registerMcpHandlers(ctx);
}
