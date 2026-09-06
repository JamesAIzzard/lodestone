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
  parseMailAccountsConfig,
  mailDataDir,
  type MailAccountTomlConfig,
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
  configureClaudeCode,
  configureCodexDesktop,
  getClaudeDesktopConfigPath as resolveClaudeDesktopConfigPath,
  getClaudeDesktopStatus,
  getClaudeCodeConfigPath as resolveClaudeCodeConfigPath,
  getClaudeCodeStatus,
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
  LlmInstructionsSettings,
  ExploreParams,
  SearchParams,
} from '../shared/types';
import type { AppContext } from './context';
import { stopSilo, wakeSilo, registerManager, notifySilosChanged } from './lifecycle';
import { ensureMailSiloConfig } from '../backend/mail/account-config';
import { accountHash, accountUid } from '../backend/mail/identity';
import { selectSilos, toSiloNames } from './silo-selection';
import { createImapAdapter } from '../backend/mail/imap-adapter';
import { SafeStorageCredentialStore, type Credential } from '../backend/mail/credential-store';
import {
  beginAuthorisation,
  completeAuthorisation,
  MICROSOFT_THUNDERBIRD,
  type PendingAuthorisation,
} from '../backend/mail/oauth';
import { MailAccount } from '../backend/mail/account';
import { openManifest } from '../backend/mail/manifest';
import { repairManifest } from '../backend/mail/startup-repair';
import { ensureDirs } from '../backend/mail/mirror-files';
import type { Folder } from '../backend/mail/types';

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

  ipcMain.handle('shell:openExternal', async (_event, targetUrl: string) => {
    const url = new URL(targetUrl);
    if (url.protocol !== 'https:') throw new Error('Only HTTPS links can be opened.');
    await shell.openExternal(url.toString());
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
          readOnly: cfg.readOnly,
          managedBy: cfg.managedBy,
          supportsPathSearch: cfg.supportsPathSearch,
        },
        available: status.available,
        indexCaughtUp: status.indexCaughtUp,
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
    async (_event, params: SearchParams, siloName?: string | string[]): Promise<SearchResult[]> => {
      const ready = selectSilos(ctx.siloManagers, toSiloNames(siloName));

      if (ready.length === 0) return [];

      const limit = params.limit ?? 10;
      const mode = params.mode ?? 'hybrid';

      const needsEmbedding = mode === 'hybrid' || mode === 'semantic';
      const searchable = needsEmbedding
        ? ready.filter(([, manager]) => manager.getEmbeddingService() !== null)
        : ready;

      if (searchable.length === 0) return [];

      const raw = await dispatchSearch(params, searchable, ctx.embeddingService);

      const merged = mergeSearchResults(raw, limit);

      return merged.map((r) => ({
        filePath: r.filePath,
        siloName: r.siloName,
        dateMs: r.dateMs,
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
      const ready = selectSilos(ctx.siloManagers, toSiloNames(params.silo));

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
      const owner = manager.getConfig().managedBy;
      if (owner) return managedSiloError(name, owner, 'removed');

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
      const owner = manager.getConfig().managedBy;
      if (owner) return managedSiloError(name, owner, 'removed');

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
        indexedDirectories?: string[];
        readOnly?: boolean;
      },
    ): Promise<{ success: boolean; error?: string }> => {
      if (!ctx.config) return { success: false, error: 'Config not loaded' };
      const siloToml = ctx.config.silos[name];
      if (!siloToml) return { success: false, error: `Silo "${name}" not found` };

      const manager = ctx.siloManagers.get(name);
      const owner = manager?.getConfig().managedBy ?? siloToml.managed_by;
      const rawUpdates = updates as Record<string, unknown>;
      const changesDirectories =
        'indexedDirectories' in rawUpdates || 'indexed_directories' in rawUpdates;
      const clearsReadOnly = rawUpdates.readOnly === false || rawUpdates.read_only === false;
      if (owner && (changesDirectories || clearsReadOnly)) {
        return managedSiloError(name, owner, 'reconfigured');
      }

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

type MailCredentialInput =
  | { kind: 'password'; password: string }
  | { kind: 'oauth'; callbackUrl?: string };

interface MailConnectionRequest {
  host: string;
  port: number;
  username: string;
  auth: MailCredentialInput & { clientId?: string };
}

type MailAccountInput = MailAccountTomlConfig;

function registerMailHandlers(ctx: AppContext): void {
  const pendingAuthorisations = new Map<
    string,
    { pending: PendingAuthorisation; clientId: string }
  >();
  const testedOAuthCredentials = new Map<string, Credential>();

  ipcMain.handle('mail:list', () =>
    [...ctx.mailAccounts.values()].map((account) => account.status()),
  );

  ipcMain.handle(
    'mail:begin-oauth',
    async (_event, input: { clientId: string; loginHint: string }): Promise<{ url: string }> => {
      const clientId = input.clientId.trim();
      if (!clientId) throw new Error('OAuth client ID is required.');
      const pending = beginAuthorisation({ ...MICROSOFT_THUNDERBIRD, clientId }, input.loginHint);
      pendingAuthorisations.set(pending.state, { pending, clientId });
      await shell.openExternal(pending.url);
      return { url: pending.url };
    },
  );

  ipcMain.handle(
    'mail:test-connection',
    async (
      _event,
      request: MailConnectionRequest,
    ): Promise<{ ok: boolean; folders?: Folder[]; error?: string }> => {
      let adapter: ReturnType<typeof createImapAdapter> | null = null;
      try {
        const uid = accountUid(request.host, request.port, request.username);
        const resolvedCredential = await credentialFromInput(
          request.auth,
          pendingAuthorisations,
          request.auth.clientId,
        );
        const credential = resolvedCredential.credential;
        const oauthAccessToken = resolvedCredential.accessToken;
        const auth =
          credential.kind === 'password'
            ? ({ kind: 'password', password: credential.password } as const)
            : oauthAuth(oauthAccessToken);
        adapter = createImapAdapter({
          host: request.host,
          port: request.port,
          username: request.username,
          auth,
          log: () => undefined,
        });
        const folders = await adapter.listFolders();
        if (credential.kind === 'oauth') testedOAuthCredentials.set(uid, credential);
        return { ok: true, folders };
      } catch (error) {
        return { ok: false, error: rendererSafeMailError(error) };
      } finally {
        await adapter?.close().catch((): void => undefined);
      }
    },
  );

  ipcMain.handle(
    'mail:cancel-setup',
    (_event, input: { host: string; port: number; username: string }): void => {
      testedOAuthCredentials.delete(accountUid(input.host, input.port, input.username));
      pendingAuthorisations.clear();
    },
  );

  ipcMain.handle(
    'mail:create',
    async (
      _event,
      input: {
        config: MailAccountInput;
        credential: MailCredentialInput;
        appearance?: { accentColor: string; iconName: string };
      },
    ): Promise<{ success: boolean; hash?: string; error?: string }> => {
      if (!ctx.config) return { success: false, error: 'Config not loaded' };
      const uid = accountUid(input.config.host, input.config.port, input.config.username);
      const hash = accountHash(uid);
      if (ctx.mailAccounts.has(hash)) {
        return { success: false, error: 'That mail account is already connected.' };
      }

      let createdManager: SiloManager | undefined;
      let createdManifest: ReturnType<typeof openManifest> | undefined;
      let createdSiloName: string | undefined;
      const store = new SafeStorageCredentialStore(ctx.getUserDataDir());
      const paths = mailDataDir(ctx.getUserDataDir(), hash);
      try {
        const config = parseMailAccountsConfig({ [hash]: input.config })[hash];
        const testedOAuthCredential = testedOAuthCredentials.get(uid);
        const credential =
          input.credential.kind === 'oauth'
            ? ((testedOAuthCredential?.kind === 'oauth' &&
              testedOAuthCredential.clientId === config.oauth_client_id
                ? testedOAuthCredential
                : undefined) ??
              (
                await credentialFromInput(
                  input.credential,
                  pendingAuthorisations,
                  config.oauth_client_id,
                )
              ).credential)
            : input.credential;
        await ensureDirs(paths);
        await store.save(hash, credential);
        ctx.config.mail_accounts[hash] = config;
        const siloConfig = ensureMailSiloConfig(ctx.config, ctx.getUserDataDir(), hash, config);
        if (input.appearance) {
          siloConfig.accent_color = validateSiloColor(input.appearance.accentColor);
          siloConfig.icon_name = validateSiloIcon(input.appearance.iconName);
        }
        createdSiloName = config.silo_name;
        saveLodestoneConfig(ctx.configPath(), ctx.config);

        const manager = registerManager(ctx, config.silo_name, ctx.config.silos[config.silo_name], {
          deferStart: true,
        });
        createdManager = manager;
        await manager.start();
        const manifest = openManifest(paths.manifest);
        createdManifest = manifest;
        await repairManifest(manifest, paths);
        const account = new MailAccount({
          accountHash: hash,
          config,
          manifest,
          dirs: paths,
          credentialStore: store,
          silo: manager,
        });
        ctx.mailAccounts.set(hash, account);
        testedOAuthCredentials.delete(uid);
        account.start();
        notifySilosChanged(ctx);
        return { success: true, hash };
      } catch (error) {
        try {
          createdManifest?.close();
        } catch {
          // Best-effort rollback continues with the remaining artefacts.
        }
        await createdManager?.stop().catch((): void => undefined);
        if (createdManager && createdSiloName) ctx.siloManagers.delete(createdSiloName);
        if (createdSiloName && ctx.config.silos[createdSiloName]?.managed_by === `mail:${hash}`) {
          delete ctx.config.silos[createdSiloName];
        }
        delete ctx.config.mail_accounts[hash];
        saveLodestoneConfig(ctx.configPath(), ctx.config);
        await store.delete(hash).catch((): void => undefined);
        await fs.promises
          .rm(paths.root, { recursive: true, force: true })
          .catch((): void => undefined);
        return { success: false, error: rendererSafeMailError(error) };
      }
    },
  );

  ipcMain.handle(
    'mail:update-settings',
    async (
      _event,
      input: {
        hash: string;
        patch: Partial<
          Pick<
            MailAccountTomlConfig,
            | 'sync_interval_seconds'
            | 'silo_name'
            | 'received_after'
            | 'selection_mode'
            | 'selected_folders'
          >
        >;
      },
    ): Promise<{ success: boolean; error?: string }> => {
      if (!ctx.config) return { success: false, error: 'Config not loaded' };
      const account = ctx.mailAccounts.get(input.hash);
      const current = ctx.config.mail_accounts[input.hash];
      if (!account || !current) return { success: false, error: 'Mail account not found.' };
      try {
        const next = parseMailAccountsConfig({
          [input.hash]: { ...current, ...input.patch },
        })[input.hash];
        if (next.silo_name !== current.silo_name) {
          await renameManagedMailSilo(ctx, current.silo_name, next.silo_name, input.hash);
        }
        const selectionChanged =
          next.received_after !== current.received_after ||
          next.selection_mode !== current.selection_mode ||
          JSON.stringify(next.selected_folders) !== JSON.stringify(current.selected_folders);
        Object.assign(current, next);
        Object.assign(account.config, next);
        account.setSyncInterval(next.sync_interval_seconds);
        saveLodestoneConfig(ctx.configPath(), ctx.config);
        if (selectionChanged) {
          await account.applySelection({
            receivedAfter:
              next.received_after === 'unlimited' ? null : new Date(next.received_after),
            mode: next.selection_mode,
            folderKeys: next.selected_folders,
          });
        }
        notifySilosChanged(ctx);
        return { success: true };
      } catch (error) {
        return { success: false, error: rendererSafeMailError(error) };
      }
    },
  );

  ipcMain.handle(
    'mail:reconnect',
    async (
      _event,
      input: { hash: string; credential: MailCredentialInput },
    ): Promise<{ success: boolean; error?: string }> => {
      const account = ctx.mailAccounts.get(input.hash);
      if (!account) return { success: false, error: 'Mail account not found.' };
      try {
        const credential = (
          await credentialFromInput(
            input.credential,
            pendingAuthorisations,
            account.config.oauth_client_id,
          )
        ).credential;
        await account.reconnect(credential);
        return { success: true };
      } catch (error) {
        return { success: false, error: rendererSafeMailError(error) };
      }
    },
  );

  ipcMain.handle('mail:sync-now', async (_event, input: { hash: string }) => {
    const account = ctx.mailAccounts.get(input.hash);
    if (!account) return { success: false, error: 'Mail account not found.' };
    void account.syncNow();
    return { success: true };
  });

  const remove = async (hash: string): Promise<{ success: boolean; error?: string }> => {
    if (!ctx.config) return { success: false, error: 'Config not loaded' };
    const account = ctx.mailAccounts.get(hash);
    if (!account) return { success: false, error: 'Mail account not found.' };
    let step: import('../backend/mail/account').RemovalStep = 'stop-scheduler';
    try {
      await account.remove();
      const siloName = account.config.silo_name;
      const manager = ctx.siloManagers.get(siloName);
      const indexPath = manager ? (await manager.getStatus()).resolvedDbPath : undefined;
      step = 'stop-silo';
      await manager?.stop();
      if (indexPath) {
        step = 'delete-index';
        await Promise.all(
          ['', '-wal', '-shm'].map((suffix) => fs.promises.rm(indexPath + suffix, { force: true })),
        );
      }
      ctx.siloManagers.delete(siloName);
      delete ctx.config.silos[siloName];
      delete ctx.config.mail_accounts[hash];
      step = 'save-config';
      saveLodestoneConfig(ctx.configPath(), ctx.config);
      step = 'delete-account-data';
      await fs.promises.rm(mailDataDir(ctx.getUserDataDir(), hash).root, {
        recursive: true,
        force: true,
      });
      ctx.mailAccounts.delete(hash);
      notifySilosChanged(ctx);
      return { success: true };
    } catch (error) {
      account.recordRemovalFailure(step);
      return { success: false, error: rendererSafeMailError(error) };
    }
  };
  ipcMain.handle('mail:remove', (_event, input: { hash: string }) => remove(input.hash));
  ipcMain.handle('mail:retry-remove', (_event, input: { hash: string }) => remove(input.hash));
}

async function credentialFromInput(
  input: MailCredentialInput,
  pending: Map<string, { pending: PendingAuthorisation; clientId: string }>,
  clientId?: string,
): Promise<{ credential: Credential; accessToken?: string }> {
  if (input.kind === 'password') return { credential: input };
  if (!input.callbackUrl) throw new Error('Complete Microsoft sign-in first.');
  let state: string | null;
  try {
    state = new URL(input.callbackUrl.trim()).searchParams.get('state');
  } catch {
    throw new Error('The pasted Microsoft callback URL is invalid.');
  }
  const stored = state ? pending.get(state) : undefined;
  if (!stored) throw new Error('The Microsoft sign-in has expired or does not match.');
  pending.delete(stored.pending.state);
  const provider = { ...MICROSOFT_THUNDERBIRD, clientId: clientId ?? stored.clientId };
  const tokens = await completeAuthorisation(provider, stored.pending, input.callbackUrl);
  return {
    credential: {
      kind: 'oauth',
      refreshToken: tokens.refreshToken,
      clientId: provider.clientId,
    },
    accessToken: tokens.accessToken,
  };
}

async function renameManagedMailSilo(
  ctx: AppContext,
  oldName: string,
  newName: string,
  hash: string,
): Promise<void> {
  if (!ctx.config) throw new Error('Config not loaded');
  const trimmed = newName.trim();
  if (!trimmed) throw new Error('Silo name cannot be empty.');
  if (ctx.siloManagers.has(trimmed) || ctx.config.silos[trimmed]) {
    throw new Error(`A silo named "${trimmed}" already exists.`);
  }
  const manager = ctx.siloManagers.get(oldName);
  const silo = ctx.config.silos[oldName];
  if (!manager || !silo || silo.managed_by !== `mail:${hash}`) {
    throw new Error('Managed mail silo is unavailable.');
  }
  await manager.stop();
  ctx.siloManagers.delete(oldName);
  ctx.config.silos[trimmed] = silo;
  delete ctx.config.silos[oldName];

  const replacement = registerManager(ctx, trimmed, silo, { deferStart: true });
  try {
    if (silo.is_stopped) replacement.loadStoppedStatus();
    else await replacement.start();
  } catch (error) {
    await replacement.stop().catch((): void => undefined);
    ctx.siloManagers.delete(trimmed);
    delete ctx.config.silos[trimmed];
    ctx.config.silos[oldName] = silo;
    ctx.siloManagers.set(oldName, manager);
    if (silo.is_stopped) manager.loadStoppedStatus();
    else await manager.start().catch((): void => undefined);
    throw error;
  }
}

function rendererSafeMailError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Mail operation failed.';
  return message.includes('@') ? 'Mail operation failed.' : message;
}

function oauthAuth(accessToken: string | undefined) {
  if (!accessToken) throw new Error('Microsoft sign-in did not return an access token.');
  return {
    kind: 'xoauth2' as const,
    accessToken: Object.assign(async (): Promise<string> => accessToken, {
      invalidate: (): void => undefined,
    }),
  };
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

  ipcMain.handle(
    'llm-instructions:get',
    async (): Promise<LlmInstructionsSettings> => ({
      notePath: ctx.config?.llm_instructions_note_path,
    }),
  );

  ipcMain.handle(
    'llm-instructions:update',
    async (_event, notePath?: string): Promise<{ success: boolean }> => {
      if (!ctx.config) return { success: false };

      const trimmedPath = notePath?.trim();
      if (trimmedPath) {
        ctx.config.llm_instructions_note_path = trimmedPath;
      } else {
        delete ctx.config.llm_instructions_note_path;
      }

      saveLodestoneConfig(ctx.configPath(), ctx.config);
      return { success: true };
    },
  );

  ipcMain.handle('defaults:reset-all', async (): Promise<{ success: boolean; error?: string }> => {
    if (!ctx.config) return { success: false };

    for (const [name, manager] of ctx.siloManagers) {
      const owner = manager.getConfig().managedBy;
      if (owner) return managedSiloError(name, owner, 'removed');
    }

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

function managedSiloError(
  name: string,
  owner: string,
  action: string,
): { success: false; error: string } {
  return {
    success: false,
    error: `Silo "${name}" is managed by "${owner}" and cannot be ${action} directly.`,
  };
}

function registerMcpHandlers(): void {
  function getClientConfigPath(clientId: McpClientId): string {
    switch (clientId) {
      case 'claude-desktop':
        return resolveClaudeDesktopConfigPath(app.getPath('appData'));
      case 'claude-code':
        return resolveClaudeCodeConfigPath(app.getPath('home'));
      case 'codex-desktop':
        return resolveCodexDesktopConfigPath(app.getPath('home'));
    }
  }

  function getClientStatus(clientId: McpClientId): McpClientStatus {
    const configPath = getClientConfigPath(clientId);
    switch (clientId) {
      case 'claude-desktop':
        return getClaudeDesktopStatus(configPath);
      case 'claude-code':
        return getClaudeCodeStatus(configPath);
      case 'codex-desktop':
        return getCodexDesktopStatus(configPath);
    }
  }

  function configureClient(clientId: McpClientId): McpClientConfigureResult {
    const configPath = getClientConfigPath(clientId);
    const wrapperPath = resolveMcpWrapperPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    });

    switch (clientId) {
      case 'claude-desktop':
        return configureClaudeDesktop(configPath, wrapperPath);
      case 'claude-code':
        return configureClaudeCode(configPath, wrapperPath);
      case 'codex-desktop':
        return configureCodexDesktop(configPath, wrapperPath);
    }
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
  registerMailHandlers(ctx);
  registerMcpHandlers();
}
