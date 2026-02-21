/**
 * Headless MCP mode — runs Lodestone without a window or tray.
 *
 * In this mode:
 * - No Electron window or tray is created
 * - Logging goes to stderr (stdout is unused — MCP traffic flows over a named pipe)
 * - All silos are started and awaited before accepting MCP connections
 * - The process exits when the named pipe disconnects
 *
 * On Windows, Electron is a GUI app and cannot receive piped stdin
 * (electron/electron#4218). The mcp-wrapper.js proxy handles stdio with the
 * MCP client and relays traffic over a named pipe that Electron connects to.
 */

import { app } from 'electron';
import {
  loadConfig,
  saveConfig,
  createDefaultConfig,
  configExists,
  resolveSiloConfig,
} from '../backend/config';
import { SiloManager } from '../backend/silo-manager';
import { startMcpServer } from '../backend/mcp-server';
import type { AppContext } from './context';
import { shutdownBackend } from './lifecycle';

export async function startMcpMode(ctx: AppContext): Promise<void> {
  console.log('[main] Starting in MCP mode (headless)');

  const ipcPathArg = process.argv.find((a) => a.startsWith('--ipc-path='));
  const ipcPath = ipcPathArg?.split('=')[1];

  if (!ipcPath) {
    console.error('[main] MCP mode requires --ipc-path=<pipe>. Use mcp-wrapper.js to launch.');
    app.quit();
    return;
  }

  // Load config
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

  // Start all non-sleeping silos sequentially
  const pendingManagers: Array<[string, SiloManager]> = [];
  for (const [name, siloToml] of Object.entries(ctx.config.silos)) {
    const resolved = resolveSiloConfig(name, siloToml, ctx.config);
    const embeddingService = ctx.getOrCreateEmbeddingService(resolved.model);
    const manager = new SiloManager(
      resolved,
      embeddingService,
      ctx.getUserDataDir(),
    );

    ctx.siloManagers.set(name, manager);

    if (resolved.sleeping) {
      manager.loadSleepingStatus();
      console.log(`[main] Silo "${name}" is sleeping`);
    } else {
      pendingManagers.push([name, manager]);
    }
  }

  for (const [name, manager] of pendingManagers) {
    try {
      await manager.start();
      console.log(`[main] Silo "${name}" ready`);
    } catch (err) {
      console.error(`[main] Failed to start silo "${name}":`, err);
    }
  }
  console.log(`[main] All silos ready — connecting to MCP pipe`);

  // Connect to the named pipe created by mcp-wrapper.js
  const { createConnection } = await import('node:net');
  const socket = createConnection(ipcPath);

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => {
      console.log(`[main] Connected to MCP pipe: ${ipcPath}`);
      resolve();
    });
    socket.once('error', (err) => {
      console.error(`[main] Failed to connect to MCP pipe:`, err);
      reject(err);
    });
  });

  const stopMcp = await startMcpServer({
    config: ctx.config,
    siloManagers: ctx.siloManagers,
    input: socket,
    output: socket,
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[main] Shutting down MCP mode...');
    await stopMcp();
    socket.destroy();
    await shutdownBackend(ctx);
    app.quit();
  };

  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());

  socket.on('close', () => shutdown());
}
