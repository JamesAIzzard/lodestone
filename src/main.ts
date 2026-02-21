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

// ── App Lifecycle ────────────────────────────────────────────────────────────

app.on('ready', () => {
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
  if (ctx.siloManagers.size > 0) {
    event.preventDefault();
    shutdownBackend(ctx).finally(() => app.quit());
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
