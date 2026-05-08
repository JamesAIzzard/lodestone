/**
 * Backend lifecycle — initialization, sleep/wake, and shutdown.
 */

import {
  loadLodestoneConfig,
  saveLodestoneConfig,
  createDefaultLodestoneConfig,
  lodestoneConfigFileExists,
  resolveSiloRuntimeConfig,
} from '../backend/config';
import { SiloManager } from '../backend/silo-manager';
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

  for (const [name, siloToml] of Object.entries(ctx.config!.silos)) {
    registerManager(ctx, name, siloToml);
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
  siloToml: import('../backend/config').SiloTomlConfig,
): SiloManager {
  const resolved = resolveSiloRuntimeConfig(name, siloToml, ctx.config!);
  const embeddingService = ctx.getOrCreateEmbeddingService(resolved.embeddingModelKey);
  const manager = new SiloManager(
    resolved,
    embeddingService,
    ctx.getUserDataDir(),
    ctx.indexingQueue,
  );

  ctx.siloManagers.set(name, manager);
  attachActivityForwarding(ctx, manager);
  manager.onStateChange(() => notifySilosChanged(ctx));

  if (resolved.isStopped) {
    manager.loadStoppedStatus();
    console.log(`[main] Silo "${name}" is stopped`);
  } else {
    enqueueSiloStart(name, manager);
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
  if (!manager.isStopped) return { success: true };

  if (ctx.config) {
    const siloToml = ctx.config.silos[name];
    if (siloToml) {
      delete siloToml.is_stopped;
      saveLodestoneConfig(ctx.configPath(), ctx.config);
    }
  }

  await manager.wake();

  notifySilosChanged(ctx);
  return { success: true };
}

// ── Shutdown ────────────────────────────────────────────────────────────────

export async function shutdownBackend(ctx: AppContext): Promise<void> {
  for (const [name, manager] of ctx.siloManagers) {
    try {
      await manager.stop();
      console.log(`[main] Silo "${name}" stopped`);
    } catch (err) {
      console.error(`[main] Error stopping silo "${name}":`, err);
    }
  }
  ctx.siloManagers.clear();

  for (const [modelId, service] of ctx.embeddingServices) {
    try {
      await service.dispose();
      console.log(`[main] Embedding service "${modelId}" disposed`);
    } catch (err) {
      console.error(`[main] Error disposing embedding service "${modelId}":`, err);
    }
  }
  ctx.embeddingServices.clear();
}
