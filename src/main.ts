/**
 * Electron main process entry point.
 *
 * This file is a thin orchestrator: it bootstraps the app, creates the
 * shared AppContext, and dispatches to either GUI mode or headless MCP mode.
 * All substantial logic lives in the extracted modules under src/main/.
 */

import { app } from 'electron';
import started from 'electron-squirrel-startup';
import { createAppContext } from './main/context';
import { createWindow } from './main/window';
import { createTray } from './main/tray';
import { initializeBackend, shutdownBackend } from './main/lifecycle';
import { registerIpcHandlers } from './main/ipc-handlers';
import { startMcpMode } from './main/mcp-mode';
import { detectExistingDataDir, runFirstRunSetup } from './main/portable';
import { configExists, getDefaultConfigPath } from './backend/config';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

const isMcpMode = process.argv.includes('--mcp');

// Ensure app name is always "Lodestone" so app.getPath('userData') resolves to
// %APPDATA%/Lodestone regardless of how the process was launched.
app.setName('Lodestone');

// In MCP mode stdout is reserved for JSON-RPC. Redirect console.log to stderr.
if (isMcpMode) {
  console.log = (...args: unknown[]) => console.error(...args);
}

const ctx = createAppContext(isMcpMode);

// ── Single-Instance Lock (GUI only) ──────────────────────────────────────────
// Prevent duplicate GUI instances. MCP mode is exempt — it coexists with the
// GUI and its lifecycle is managed by the MCP client + parent PID polling.

if (!isMcpMode) {
  const gotLock = app.requestSingleInstanceLock();

  if (!gotLock) {
    console.log('[main] Another GUI instance is already running — exiting');
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (ctx.mainWindow) {
        if (ctx.mainWindow.isMinimized()) ctx.mainWindow.restore();
        ctx.mainWindow.show();
        ctx.mainWindow.focus();
      }
    });
  }
}

// ── App Lifecycle ────────────────────────────────────────────────────────────

app.on('ready', async () => {
  // ── Portable / first-run data directory resolution ────────────────────────
  // Must happen before any call to ctx.getUserDataDir() / app.getPath('userData').
  // Skipped in MCP mode (no UI available) and in dev builds (app.isPackaged = false).
  if (!isMcpMode && app.isPackaged) {
    const existing = detectExistingDataDir();
    if (existing) {
      // Found a portable or custom data dir — redirect userData before backend starts
      app.setPath('userData', existing);
    } else if (!configExists(getDefaultConfigPath(app.getPath('userData')))) {
      // No portable dir and no AppData config → true first run
      const chosen = await runFirstRunSetup();
      if (chosen !== app.getPath('userData')) {
        app.setPath('userData', chosen);
      }
    }
  }

  if (isMcpMode) {
    startMcpMode(ctx).catch((err) => {
      console.error('[main] MCP mode failed:', err);
      app.quit();
    });
    return;
  }

  // Normal GUI mode
  registerIpcHandlers(ctx);
  createWindow(ctx);
  createTray(ctx);

  // Defer backend init until the renderer has loaded so that heavy
  // reconciliation / ONNX embedding work doesn't starve the event loop.
  ctx.mainWindow!.webContents.once('did-finish-load', () => {
    initializeBackend(ctx).catch((err) => {
      console.error('[main] Backend initialization error:', err);
    });
  });
});

app.on('before-quit', () => {
  ctx.isQuitting = true;
});

app.on('will-quit', (event) => {
  if (ctx.siloManagers.size > 0 || ctx.embeddingServices.size > 0) {
    event.preventDefault();

    // Race shutdown against a hard timeout so a stuck silo can't keep the
    // process alive forever.
    const SHUTDOWN_TIMEOUT_MS = 5000;
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        console.warn('[main] Shutdown timed out after 5 s — force-quitting');
        resolve();
      }, SHUTDOWN_TIMEOUT_MS).unref();
    });

    Promise.race([shutdownBackend(ctx), timeout]).finally(() => app.quit());
  }
});

app.on('window-all-closed', () => {
  if (isMcpMode) return;
  if (process.platform === 'darwin') {
    // macOS: app stays in dock
  }
  // Otherwise: app stays in tray
});

app.on('activate', () => {
  if (isMcpMode) return;
  if (ctx.mainWindow) {
    ctx.mainWindow.show();
    ctx.mainWindow.focus();
  } else {
    createWindow(ctx);
  }
});
