/**
 * Backend lifecycle — initialization, sleep/wake, and shutdown.
 */

import {
  loadConfig,
  saveConfig,
  createDefaultConfig,
  configExists,
  resolveSiloConfig,
} from '../backend/config';
import { SiloManager } from '../backend/silo-manager';
import type { AppContext } from './context';
import { attachActivityForwarding } from './activity';
import { buildTrayMenu } from './tray';

// ── Initialization ──────────────────────────────────────────────────────────

export async function initializeBackend(ctx: AppContext): Promise<void> {
  const configPath = ctx.configPath();

  if (configExists(configPath)) {
    try {
      ctx.config = loadConfig(configPath);
      console.log(`[main] Loaded config from ${configPath}`);
    } catch (err) {
      console.error('[main] Failed to load config:', err);
      ctx.config = createDefaultConfig();
    }
  } else {
    ctx.config = createDefaultConfig();
    saveConfig(configPath, ctx.config);
    console.log(`[main] Created default config at ${configPath}`);
  }

  for (const [name, siloToml] of Object.entries(ctx.config.silos)) {
    registerManager(ctx, name, siloToml);
  }

  if (ctx.tray) ctx.tray.setContextMenu(buildTrayMenu(ctx));
}

/**
 * Create a SiloManager, register it in the context, wire up event forwarding,
 * and either load cached sleeping stats or enqueue startup.
 */
export function registerManager(
  ctx: AppContext,
  name: string,
  siloToml: import('../backend/config').SiloTomlConfig,
): SiloManager {
  const resolved = resolveSiloConfig(name, siloToml, ctx.config!);
  const embeddingService = ctx.getOrCreateEmbeddingService(resolved.model);
  const manager = new SiloManager(
    resolved,
    embeddingService,
    ctx.getUserDataDir(),
  );

  ctx.siloManagers.set(name, manager);
  attachActivityForwarding(ctx, manager);
  manager.onStateChange(() => {
    ctx.mainWindow?.webContents.send('silos:changed');
  });

  if (resolved.sleeping) {
    manager.loadSleepingStatus();
    console.log(`[main] Silo "${name}" is sleeping`);
  } else {
    ctx.enqueueSiloStart(name, manager);
  }

  return manager;
}

// ── Sleep / Wake ────────────────────────────────────────────────────────────

export async function sleepSilo(
  ctx: AppContext,
  name: string,
): Promise<{ success: boolean; error?: string }> {
  const manager = ctx.siloManagers.get(name);
  if (!manager) return { success: false, error: `Silo "${name}" not found` };
  if (manager.isSleeping) return { success: true };

  await manager.sleep();

  if (ctx.config) {
    const siloToml = ctx.config.silos[name];
    if (siloToml) {
      siloToml.sleeping = true;
      saveConfig(ctx.configPath(), ctx.config);
    }
  }

  if (ctx.tray) ctx.tray.setContextMenu(buildTrayMenu(ctx));
  return { success: true };
}

export async function wakeSilo(
  ctx: AppContext,
  name: string,
): Promise<{ success: boolean; error?: string }> {
  const manager = ctx.siloManagers.get(name);
  if (!manager) return { success: false, error: `Silo "${name}" not found` };
  if (!manager.isSleeping) return { success: true };

  if (ctx.config) {
    const siloToml = ctx.config.silos[name];
    if (siloToml) {
      delete siloToml.sleeping;
      saveConfig(ctx.configPath(), ctx.config);
    }
  }

  await manager.wake();

  if (ctx.tray) ctx.tray.setContextMenu(buildTrayMenu(ctx));
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
