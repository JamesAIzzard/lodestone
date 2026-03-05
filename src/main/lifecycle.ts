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
import { MemoryManager } from '../backend/memory-manager';
import { MEMORY_MODEL } from '../backend/memory-store';
import type { AppContext } from './context';
import { attachActivityForwarding } from './activity';
import { buildTrayMenu } from './tray';

/** Create a MemoryManager wired to the app's embedding service. */
export function createMemoryManager(ctx: AppContext): MemoryManager {
  const mm = new MemoryManager();
  mm.setEmbeddingProvider(async () => {
    const service = ctx.getOrCreateEmbeddingService(MEMORY_MODEL);
    await service.ensureReady();
    return service;
  });
  return mm;
}

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
}

// ── Initialization ──────────────────────────────────────────────────────────

export async function initializeBackend(ctx: AppContext): Promise<void> {
  loadOrInitConfig(ctx);

  // Auto-connect memory database if configured
  const memoryDbPath = ctx.config!.memory?.db_path;
  if (memoryDbPath) {
    ctx.memoryManager = createMemoryManager(ctx);
    try {
      ctx.memoryManager.connect(memoryDbPath);
      ctx.memoryManager.startPolling(() => {
        ctx.mainWindow?.webContents.send('memories:changed');
      });
      console.log(`[main] Connected memory database: ${memoryDbPath}`);
    } catch (err) {
      console.error('[main] Failed to connect memory database:', err);
      ctx.memoryManager = null;
    }
  }

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
  const resolved = resolveSiloConfig(name, siloToml, ctx.config!);
  const embeddingService = ctx.getOrCreateEmbeddingService(resolved.model);
  const manager = new SiloManager(
    resolved,
    embeddingService,
    ctx.getUserDataDir(),
    ctx.indexingQueue,
  );

  ctx.siloManagers.set(name, manager);
  attachActivityForwarding(ctx, manager);
  manager.onStateChange(() => notifySilosChanged(ctx));

  if (resolved.stopped) {
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
      siloToml.stopped = true;
      saveConfig(ctx.configPath(), ctx.config);
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
      delete siloToml.stopped;
      saveConfig(ctx.configPath(), ctx.config);
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
