/**
 * IPC handler registration — bridges renderer ↔ main process.
 *
 * All ipcMain.handle() calls are registered here. Handlers are grouped
 * into domain-specific registration functions for readability.
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  saveLodestoneConfig,
  createDefaultLodestoneConfig,
  resolveSiloRuntimeConfig,
  type SiloTomlConfig,
} from '../backend/config';
import { autoAssignColor, validateSiloColor, validateSiloIcon } from '../shared/silo-appearance';
import type { SiloManager } from '../backend/silo-manager';
import {
  dispatchExplore,
  mergeDirectoryResults,
  dispatchSearch,
  mergeSearchResults,
} from '../backend/search-merge';
import {
  configureClaudeDesktop,
  configureCodexDesktop,
  getClaudeDesktopConfigPath as resolveClaudeDesktopConfigPath,
  getClaudeDesktopStatus,
  getCodexDesktopConfigPath as resolveCodexDesktopConfigPath,
  getCodexDesktopStatus,
  getMcpWrapperPath as resolveMcpWrapperPath,
  type McpClientConfigureResult,
  type McpClientId,
  type McpClientStatus,
} from './mcp-client-config';
import type {
  SiloStatus,
  SearchResult,
  DirectoryResult,
  ActivityEvent,
  ServerStatus,
  DefaultSettings,
  ExploreParams,
  SearchParams,
} from '../shared/types';
import type { AppContext } from './context';
import { stopSilo, wakeSilo, registerManager, notifySilosChanged } from './lifecycle';

// ── Domain-grouped handler registrations ────────────────────────────────

function registerDialogHandlers(): void {
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
          indexedDirectories: cfg.indexedDirectories,
          indexedFileExtensions: cfg.indexedFileExtensions,
          ignoredFolderPatterns: cfg.ignoredFolderPatterns,
          ignoredFilePatterns: cfg.ignoredFilePatterns,
          hasIgnoredFolderPatternsOverride: siloToml?.ignored_folder_patterns !== undefined,
          hasIgnoredFilePatternsOverride: siloToml?.ignored_file_patterns !== undefined,
          hasIndexedFileExtensionsOverride: siloToml?.indexed_file_extensions !== undefined,
          indexDbPath: cfg.indexDbPath,
          contentDescription: cfg.contentDescription,
          accentColor: cfg.accentColor,
          iconName: cfg.iconName,
        },
        indexedFileCount: status.indexedFileCount,
        chunkCount: status.chunkCount,
        lastUpdated: status.lastUpdated?.toISOString() ?? null,
        databaseSizeBytes: status.databaseSizeBytes,
        watcherState: status.watcherState,
        errorMessage: status.errorMessage,
        reconcileProgress: status.reconcileProgress,
        resolvedDbPath: status.resolvedDbPath,
      });
    }
    return statuses;
  });

  ipcMain.handle(
    'silos:search',
    async (_event, params: SearchParams, siloName?: string): Promise<SearchResult[]> => {
      // Collect searchable managers; stopped silos are skipped.
      const ready: [string, SiloManager][] = [];
      if (siloName) {
        const m = ctx.siloManagers.get(siloName);
        if (m && !m.isStopped) ready.push([siloName, m]);
      } else {
        for (const [name, m] of ctx.siloManagers) {
          if (!m.isStopped) ready.push([name, m]);
        }
      }

      if (ready.length === 0) return [];

      const limit = params.limit ?? 10;
      const mode = params.mode ?? 'hybrid';

      // Filepath and regex modes can search any ready silo; other modes need an embedding service
      const searchable =
        mode === 'regex' || mode === 'filepath'
          ? ready
          : ready.filter(([, m]) => m.getEmbeddingService() !== null);

      if (searchable.length === 0) return [];

      const raw = await dispatchSearch(params, searchable, ctx.embeddingService);

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
    },
  );

  ipcMain.handle(
    'silos:explore',
    async (_event, params: ExploreParams): Promise<DirectoryResult[]> => {
      // Collect searchable managers; stopped silos are skipped.
      const ready: [string, SiloManager][] = [];
      if (params.silo) {
        const m = ctx.siloManagers.get(params.silo);
        if (m && !m.isStopped) ready.push([params.silo, m]);
      } else {
        for (const [name, m] of ctx.siloManagers) {
          if (!m.isStopped) ready.push([name, m]);
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
    },
  );

  // ── Activity ────────────────────────────────────────────────────────────

  ipcMain.handle('activity:recent', async (_event, limit = 50): Promise<ActivityEvent[]> => {
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
      saveLodestoneConfig(ctx.configPath(), ctx.config);
      console.log(`[main] Silo "${name}" deleted from config`);

      notifySilosChanged(ctx);

      if (dbDeleteError) {
        return {
          success: false,
          error: `Silo removed but database file could not be deleted: ${dbDeleteError}`,
        };
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
      saveLodestoneConfig(ctx.configPath(), ctx.config);
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

  ipcMain.handle('silos:rescan', (_event, name: string): { success: boolean; error?: string } => {
    const manager = ctx.siloManagers.get(name);
    if (!manager) return { success: false, error: `Silo "${name}" not found` };

    // Fire and forget — rescan() re-walks directories and indexes changes
    // without deleting the DB. State updates via silos:changed events.
    manager.rescan().catch((err) => {
      console.error(`[main] Failed to rescan silo "${name}":`, err);
    });

    return { success: true };
  });

  ipcMain.handle(
    'silos:update',
    async (
      _event,
      name: string,
      updates: {
        contentDescription?: string;
        ignoredFolderPatterns?: string[];
        ignoredFilePatterns?: string[];
        indexedFileExtensions?: string[];
        accentColor?: string;
        iconName?: string;
      },
    ): Promise<{ success: boolean; error?: string }> => {
      if (!ctx.config) return { success: false, error: 'Config not loaded' };
      const siloToml = ctx.config.silos[name];
      if (!siloToml) return { success: false, error: `Silo "${name}" not found` };

      const manager = ctx.siloManagers.get(name);

      if (updates.contentDescription !== undefined) {
        siloToml.content_description = updates.contentDescription.trim() || undefined;
        await manager?.updateContentDescription(updates.contentDescription.trim());
      }

      if (updates.accentColor !== undefined) {
        const validated = validateSiloColor(updates.accentColor);
        siloToml.accent_color = validated;
        await manager?.updateAccentColor(validated);
      }

      if (updates.iconName !== undefined) {
        const validated = validateSiloIcon(updates.iconName);
        siloToml.icon_name = validated;
        await manager?.updateIconName(validated);
      }

      // Ignore pattern updates — empty array means "revert to defaults"
      if (updates.ignoredFolderPatterns !== undefined) {
        siloToml.ignored_folder_patterns =
          updates.ignoredFolderPatterns.length > 0 ? updates.ignoredFolderPatterns : undefined;
      }
      if (updates.ignoredFilePatterns !== undefined) {
        siloToml.ignored_file_patterns =
          updates.ignoredFilePatterns.length > 0 ? updates.ignoredFilePatterns : undefined;
      }

      // Extension updates — empty array means "revert to defaults"
      if (updates.indexedFileExtensions !== undefined) {
        siloToml.indexed_file_extensions =
          updates.indexedFileExtensions.length > 0 ? updates.indexedFileExtensions : undefined;
      }

      // Hot-swap the watcher if ignore patterns or extensions changed
      if (manager) {
        if (
          updates.ignoredFolderPatterns !== undefined ||
          updates.ignoredFilePatterns !== undefined
        ) {
          const resolved = resolveSiloRuntimeConfig(name, siloToml, ctx.config);
          await manager.updateIgnoredPatterns(
            resolved.ignoredFolderPatterns,
            resolved.ignoredFilePatterns,
          );
        }
        if (updates.indexedFileExtensions !== undefined) {
          const resolved = resolveSiloRuntimeConfig(name, siloToml, ctx.config);
          await manager.updateIndexedFileExtensions(resolved.indexedFileExtensions);
        }
      }

      saveLodestoneConfig(ctx.configPath(), ctx.config);
      console.log(`[main] Silo "${name}" updated`);
      return { success: true };
    },
  );

  ipcMain.handle(
    'silos:rename',
    async (
      _event,
      oldName: string,
      newName: string,
    ): Promise<{ success: boolean; error?: string }> => {
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

      saveLodestoneConfig(ctx.configPath(), ctx.config);
      console.log(`[main] Silo "${oldName}" renamed to "${trimmed}" (slug: "${newSlug}")`);

      notifySilosChanged(ctx);
      return { success: true };
    },
  );

  ipcMain.handle(
    'silos:create',
    async (
      _event,
      opts: {
        name: string;
        indexedDirectories: string[];
        indexedFileExtensions: string[];
        indexDbPath: string;
        contentDescription?: string;
        accentColor?: string;
        iconName?: string;
        mode?: 'new' | 'existing';
      },
    ): Promise<{ success: boolean; error?: string }> => {
      if (!ctx.config) return { success: false, error: 'Config not loaded' };

      const slug = opts.name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-_]/g, '-');
      if (slug.length === 0) return { success: false, error: 'Invalid silo name' };
      if (ctx.siloManagers.has(slug))
        return { success: false, error: `Silo "${slug}" already exists` };
      if (opts.indexedDirectories.length === 0)
        return { success: false, error: 'At least one directory is required' };

      const resolvedDbPath = path.isAbsolute(opts.indexDbPath)
        ? opts.indexDbPath
        : path.join(ctx.getUserDataDir(), opts.indexDbPath);
      if (opts.mode !== 'existing' && fs.existsSync(resolvedDbPath)) {
        return {
          success: false,
          error: `A database file already exists at that path. Use "Connect existing silo" to attach it, or choose a different path.`,
        };
      }

      // Auto-assign colour if not provided, cycling through the palette
      const color = opts.accentColor
        ? validateSiloColor(opts.accentColor)
        : autoAssignColor(ctx.siloManagers.size);
      const icon = opts.iconName ? validateSiloIcon(opts.iconName) : undefined;

      const siloToml: SiloTomlConfig = {
        indexed_directories: opts.indexedDirectories,
        index_db_path: opts.indexDbPath,
        indexed_file_extensions:
          opts.indexedFileExtensions.length > 0 ? opts.indexedFileExtensions : undefined,
        content_description: opts.contentDescription?.trim() || undefined,
        accent_color: color,
        icon_name: icon ?? undefined,
      };

      ctx.config.silos[slug] = siloToml;
      saveLodestoneConfig(ctx.configPath(), ctx.config);
      console.log(`[main] Saved new silo "${slug}" to config`);

      registerManager(ctx, slug, siloToml);

      notifySilosChanged(ctx);

      return { success: true };
    },
  );
}

function registerSettingsHandlers(ctx: AppContext): void {
  ipcMain.handle('server:status', async (): Promise<ServerStatus> => {
    const uptimeSeconds = Math.floor((Date.now() - ctx.startTime) / 1000);

    let totalFiles = 0;
    for (const manager of ctx.siloManagers.values()) {
      const status = await manager.getStatus();
      totalFiles += status.indexedFileCount;
    }

    return {
      uptimeSeconds,
      totalIndexedFiles: totalFiles,
    };
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

  // ── Defaults ──────────────────────────────────────────────────────────

  ipcMain.handle('defaults:get', async (): Promise<DefaultSettings> => {
    if (!ctx.config) {
      const def = createDefaultLodestoneConfig();
      return {
        indexedFileExtensions: def.defaults.indexed_file_extensions,
        ignoredFolderPatterns: def.defaults.ignored_folder_patterns,
        ignoredFilePatterns: def.defaults.ignored_file_patterns,
        fileChangeDelaySeconds: def.defaults.file_change_delay_seconds,
        editContextLines: def.defaults.edit_context_lines,
        maxActivityLogEntries: def.defaults.max_activity_log_entries,
      };
    }
    return {
      indexedFileExtensions: ctx.config.defaults.indexed_file_extensions,
      ignoredFolderPatterns: ctx.config.defaults.ignored_folder_patterns,
      ignoredFilePatterns: ctx.config.defaults.ignored_file_patterns,
      fileChangeDelaySeconds: ctx.config.defaults.file_change_delay_seconds,
      editContextLines: ctx.config.defaults.edit_context_lines,
      maxActivityLogEntries: ctx.config.defaults.max_activity_log_entries,
    };
  });

  ipcMain.handle(
    'defaults:update',
    async (_event, updates: Partial<DefaultSettings>): Promise<{ success: boolean }> => {
      if (!ctx.config) return { success: false };

      if (updates.indexedFileExtensions !== undefined)
        ctx.config.defaults.indexed_file_extensions = updates.indexedFileExtensions;
      if (updates.ignoredFolderPatterns !== undefined)
        ctx.config.defaults.ignored_folder_patterns = updates.ignoredFolderPatterns;
      if (updates.ignoredFilePatterns !== undefined)
        ctx.config.defaults.ignored_file_patterns = updates.ignoredFilePatterns;
      if (updates.fileChangeDelaySeconds !== undefined) {
        ctx.config.defaults.file_change_delay_seconds = updates.fileChangeDelaySeconds;
      }
      if (updates.editContextLines !== undefined)
        ctx.config.defaults.edit_context_lines = updates.editContextLines;
      if (updates.maxActivityLogEntries !== undefined)
        ctx.config.defaults.max_activity_log_entries = updates.maxActivityLogEntries;

      saveLodestoneConfig(ctx.configPath(), ctx.config);
      return { success: true };
    },
  );

  ipcMain.handle('defaults:reset-all', async (): Promise<{ success: boolean }> => {
    if (!ctx.config) return { success: false };

    // Stop all silo managers
    for (const [name, manager] of ctx.siloManagers) {
      try {
        await manager.stop();
      } catch (err) {
        console.error(`[main] Error stopping silo "${name}" during reset:`, err);
      }
      ctx.siloManagers.delete(name);
    }

    // Replace config with clean defaults and persist
    ctx.config = createDefaultLodestoneConfig();
    saveLodestoneConfig(ctx.configPath(), ctx.config);
    console.log('[main] All settings reset to defaults');

    notifySilosChanged(ctx);
    return { success: true };
  });
}

function registerMcpHandlers(): void {
  function getClientConfigPath(clientId: McpClientId): string {
    return clientId === 'claude-desktop'
      ? resolveClaudeDesktopConfigPath(app.getPath('appData'))
      : resolveCodexDesktopConfigPath(app.getPath('home'));
  }

  function getClientStatus(clientId: McpClientId): McpClientStatus {
    const configPath = getClientConfigPath(clientId);
    return clientId === 'claude-desktop'
      ? getClaudeDesktopStatus(configPath)
      : getCodexDesktopStatus(configPath);
  }

  function configureClient(clientId: McpClientId): McpClientConfigureResult {
    const configPath = getClientConfigPath(clientId);
    const wrapperPath = resolveMcpWrapperPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    });

    return clientId === 'claude-desktop'
      ? configureClaudeDesktop(configPath, wrapperPath)
      : configureCodexDesktop(configPath, wrapperPath);
  }

  ipcMain.handle(
    'mcp:getClientStatus',
    async (_event, clientId: McpClientId): Promise<McpClientStatus> => getClientStatus(clientId),
  );

  ipcMain.handle(
    'mcp:configureClient',
    async (_event, clientId: McpClientId): Promise<McpClientConfigureResult> =>
      configureClient(clientId),
  );

  function getClaudeDesktopConfigPath(): string {
    return getClientConfigPath('claude-desktop');
  }

  function getMcpWrapperPath(): string {
    return resolveMcpWrapperPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    });
  }

  ipcMain.handle(
    'mcp:getClaudeDesktopStatus',
    async (): Promise<{
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
    },
  );

  ipcMain.handle(
    'mcp:configureClaudeDesktop',
    async (): Promise<{
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
        return {
          success: false,
          configPath,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
}

// ── Public entry point ──────────────────────────────────────────────────

export function registerIpcHandlers(ctx: AppContext): void {
  registerDialogHandlers();
  registerSiloHandlers(ctx);
  registerSettingsHandlers(ctx);
  registerMcpHandlers();
}
