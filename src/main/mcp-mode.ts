/**
 * Headless MCP mode — runs Lodestone without a window or tray.
 *
 * In this mode:
 * - No Electron window or tray is created
 * - Logging goes to stderr (stdout is unused — MCP traffic flows over a named pipe)
 * - The MCP pipe connects immediately; silos start in the background
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
} from '../backend/config';
import { startMcpServer } from '../backend/mcp-server';
import type { AppContext } from './context';
import { registerManager, shutdownBackend } from './lifecycle';

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

  // Register all silos — this creates managers and enqueues non-sleeping
  // silos for sequential background startup via ctx.siloStartQueue.
  // The MCP server will accept requests immediately; silos that haven't
  // finished reconciliation yet will return partial results with warnings.
  for (const [name, siloToml] of Object.entries(ctx.config.silos)) {
    registerManager(ctx, name, siloToml);
  }

  // Connect to the named pipe created by mcp-wrapper.js — before silos finish
  console.log(`[main] Connecting to MCP pipe (silos starting in background)`);
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
    clearInterval(parentPollTimer);
    await stopMcp();
    socket.destroy();
    await shutdownBackend(ctx);
    app.quit();
  };

  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());

  socket.on('close', () => shutdown());

  // ── Orphan Prevention ────────────────────────────────────────────────────
  // On Windows, if the parent wrapper process is killed via TerminateProcess()
  // (which is how Task Manager, Claude Desktop, and child.kill() work), none
  // of our signal handlers fire and the named pipe may not close promptly.
  // Poll the parent PID to detect this and self-exit.
  const parentPid = process.ppid;
  const parentPollTimer = setInterval(() => {
    try {
      // process.kill(pid, 0) throws if the process no longer exists
      process.kill(parentPid, 0);
    } catch {
      console.log(`[main] Parent process (PID ${parentPid}) gone — shutting down`);
      shutdown();
    }
  }, 2000);
  parentPollTimer.unref();
}
