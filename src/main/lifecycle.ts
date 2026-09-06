/**
 * Backend lifecycle — initialization, sleep/wake, and shutdown.
 */

import {
  loadLodestoneConfig,
  saveLodestoneConfig,
  createDefaultLodestoneConfig,
  lodestoneConfigFileExists,
  resolveSiloRuntimeConfig,
  mailDataDir,
  type SiloTomlConfig,
} from '../backend/config';
import { SiloManager } from '../backend/silo-manager';
import { MailAccount } from '../backend/mail/account';
import { SafeStorageCredentialStore } from '../backend/mail/credential-store';
import { openManifest } from '../backend/mail/manifest';
import { repairManifest } from '../backend/mail/startup-repair';
import { ensureMailSiloConfig } from '../backend/mail/account-config';
import type { AppContext } from './context';
import { attachActivityForwarding } from './activity';
import { buildTrayMenu } from './tray';

// ── Notifications ────────────────────────────────────────────────────────────

/** Rebuild the tray menu and notify the renderer that silo state changed. */
export function notifySilosChanged(ctx: AppContext): void {
  if (ctx.tray) ctx.tray.setContextMenu(buildTrayMenu(ctx));
  ctx.mainWindow?.webContents.send('silos:changed');
}

// ── Configuration ────────────────────────────────────────────────────────────

/** Load config from disk, or create + persist defaults if missing/corrupt. */
export function loadOrInitConfig(ctx: AppContext): void {
  const configPath = ctx.configPath();

  if (lodestoneConfigFileExists(configPath)) {
    try {
      ctx.config = loadLodestoneConfig(configPath);
      console.log(`[main] Loaded config from ${configPath}`);
    } catch (err) {
      console.error('[main] Failed to load config:', err);
      ctx.config = createDefaultLodestoneConfig();
    }
  } else {
    ctx.config = createDefaultLodestoneConfig();
    saveLodestoneConfig(configPath, ctx.config);
    console.log(`[main] Created default config at ${configPath}`);
  }
}

// ── Initialization ──────────────────────────────────────────────────────────

export async function initializeBackend(ctx: AppContext): Promise<void> {
  loadOrInitConfig(ctx);
  const config = ctx.config;
  if (!config) throw new Error('Config not loaded');

  const silosBeforeMailRepair = JSON.stringify(config.silos);
  for (const [hash, account] of Object.entries(config.mail_accounts)) {
    ensureMailSiloConfig(config, ctx.getUserDataDir(), hash, account);
  }
  if (JSON.stringify(config.silos) !== silosBeforeMailRepair) {
    saveLodestoneConfig(ctx.configPath(), config);
  }

  const deferredMailSilos: Array<{ hash: string; manager: SiloManager }> = [];
  for (const [name, siloToml] of Object.entries(config.silos)) {
    const owner = siloToml.managed_by;
    const deferStart = owner?.startsWith('mail:') === true;
    const manager = registerManager(ctx, name, siloToml, { deferStart });
    if (deferStart && owner) {
      deferredMailSilos.push({ hash: owner.slice('mail:'.length), manager });
    }
  }

  for (const { hash, manager } of deferredMailSilos) {
    try {
      await manager.start();
    } catch (error) {
      console.error(`[mail:${hash}] Failed to start managed silo:`, safeMailError(error));
    }
  }

  const credentialStore = new SafeStorageCredentialStore(ctx.getUserDataDir());
  for (const [hash, accountConfig] of Object.entries(config.mail_accounts)) {
    let manifest: ReturnType<typeof openManifest> | undefined;
    try {
      const paths = mailDataDir(ctx.getUserDataDir(), hash);
      manifest = openManifest(paths.manifest);
      await repairManifest(manifest, paths);
      const silo = ctx.siloManagers.get(accountConfig.silo_name);
      if (!silo) throw new Error('Managed mail silo is unavailable.');
      const account = new MailAccount({
        accountHash: hash,
        config: accountConfig,
        manifest,
        dirs: paths,
        credentialStore,
        silo,
      });
      ctx.mailAccounts.set(hash, account);
      if (config.silos[accountConfig.silo_name]?.is_stopped) await account.pause();
      else account.start();
    } catch (error) {
      try {
        manifest?.close();
      } catch {
        // Continue initialising other accounts.
      }
      console.error(`[mail:${hash}] Failed to initialise account:`, safeMailError(error));
    }
  }

  notifySilosChanged(ctx);
}

/**
 * Create a SiloManager, register it in the context, wire up event forwarding,
 * and either load cached stopped stats or enqueue startup.
 */
export function registerManager(
  ctx: AppContext,
  name: string,
  siloToml: SiloTomlConfig,
  options: { deferStart?: boolean } = {},
): SiloManager {
  if (!ctx.config) throw new Error('Config not loaded');
  const resolved = resolveSiloRuntimeConfig(name, siloToml, ctx.config);
  const embeddingService = ctx.getOrCreateEmbeddingService();
  const manager = new SiloManager(
    resolved,
    embeddingService,
    ctx.getUserDataDir(),
    ctx.indexingQueue,
  );

  ctx.siloManagers.set(name, manager);
  attachActivityForwarding(ctx, manager);
  manager.onStateChange(() => notifySilosChanged(ctx));

  if (resolved.isStopped && !options.deferStart) {
    manager.loadStoppedStatus();
    console.log(`[main] Silo "${name}" is stopped`);
  } else if (!options.deferStart) {
    enqueueSiloStart(name, manager);
  } else {
    manager.loadWaitingStatus();
  }

  return manager;
}

/** Mark a silo as waiting and fire off its async start. */
function enqueueSiloStart(name: string, manager: SiloManager): void {
  manager.loadWaitingStatus();
  manager.start().catch((err) => {
    console.error(`[main] Failed to start silo "${name}":`, err);
  });
}

// ── Sleep / Wake ────────────────────────────────────────────────────────────

export async function stopSilo(
  ctx: AppContext,
  name: string,
): Promise<{ success: boolean; error?: string }> {
  const manager = ctx.siloManagers.get(name);
  if (!manager) return { success: false, error: `Silo "${name}" not found` };

  const owner = ctx.config?.silos[name]?.managed_by;
  const mailAccount = owner?.startsWith('mail:')
    ? ctx.mailAccounts.get(owner.slice('mail:'.length))
    : undefined;
  await mailAccount?.pause();
  if (manager.isStopped) return { success: true };

  await manager.freeze();

  if (ctx.config) {
    const siloToml = ctx.config.silos[name];
    if (siloToml) {
      siloToml.is_stopped = true;
      saveLodestoneConfig(ctx.configPath(), ctx.config);
    }
  }

  notifySilosChanged(ctx);
  return { success: true };
}

export async function wakeSilo(
  ctx: AppContext,
  name: string,
): Promise<{ success: boolean; error?: string }> {
  const manager = ctx.siloManagers.get(name);
  if (!manager) return { success: false, error: `Silo "${name}" not found` };

  const owner = ctx.config?.silos[name]?.managed_by;
  const mailAccount = owner?.startsWith('mail:')
    ? ctx.mailAccounts.get(owner.slice('mail:'.length))
    : undefined;
  if (!manager.isStopped) {
    mailAccount?.resume();
    return { success: true };
  }

  if (ctx.config) {
    const siloToml = ctx.config.silos[name];
    if (siloToml) {
      delete siloToml.is_stopped;
      saveLodestoneConfig(ctx.configPath(), ctx.config);
    }
  }

  await manager.wake();
  mailAccount?.resume();

  notifySilosChanged(ctx);
  return { success: true };
}

// ── Shutdown ────────────────────────────────────────────────────────────────

export async function shutdownBackend(ctx: AppContext): Promise<void> {
  await Promise.race([
    Promise.allSettled([...ctx.mailAccounts.values()].map((account) => account.shutdown())),
    shutdownTimeout(),
  ]);
  ctx.mailAccounts.clear();

  for (const [name, manager] of ctx.siloManagers) {
    try {
      await manager.stop();
      console.log(`[main] Silo "${name}" stopped`);
    } catch (err) {
      console.error(`[main] Error stopping silo "${name}":`, err);
    }
  }
  ctx.siloManagers.clear();

  if (ctx.embeddingService) {
    try {
      await ctx.embeddingService.dispose();
      console.log('[main] Embedding service disposed');
    } catch (err) {
      console.error('[main] Error disposing embedding service:', err);
    }
    ctx.embeddingService = null;
  }
}

function shutdownTimeout(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10_000).unref());
}

function safeMailError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.includes('@') ? error.name : error.message;
  }
  return 'unknown';
}
