import { app } from 'electron';
import started from 'electron-squirrel-startup';
import { createAppContext, type AppContext } from './main/context';
import { createWindow } from './main/window';
import { createTray } from './main/tray';
import { initializeBackend, shutdownBackend } from './main/lifecycle';
import { registerIpcHandlers } from './main/ipc-handlers';
import { startMcpBridgeProcess } from './main/mcp-bridge';
import { detectExistingDataDir, runFirstRunSetup } from './main/portable';
import { lodestoneConfigFileExists, getDefaultLodestoneConfigPath } from './backend/config';

const MCP_BRIDGE_ARG = '--mcp-bridge';
const SHUTDOWN_TIMEOUT_MS = 5000;

if (started) {
  app.quit();
}

const mcpBridgeProcess = isMcpBridgeProcess();

configureAppIdentity();
if (mcpBridgeProcess) redirectLogsAwayFromMcpProtocol();

const ctx = createAppContext();

if (!mcpBridgeProcess) {
  registerGuiSingleInstanceBehavior(ctx);
}

app.on('ready', async () => {
  if (mcpBridgeProcess) {
    await startMcpBridge(ctx);
    return;
  }

  await startGui(ctx);
});

app.on('before-quit', () => {
  ctx.isQuitting = true;
});

app.on('will-quit', (event) => {
  if (!needsBackendShutdown(ctx)) return;

  ctx.shuttingDown = true;
  event.preventDefault();

  ctx.internalApi?.stop();
  ctx.internalApi = null;

  Promise.race([shutdownBackend(ctx), quitAfterShutdownTimeout()]).finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (mcpBridgeProcess) return;
  keepGuiProcessRunningInTray();
});

app.on('activate', () => {
  if (mcpBridgeProcess) return;
  showOrCreateMainWindow(ctx);
});

function isMcpBridgeProcess(): boolean {
  return process.argv.includes(MCP_BRIDGE_ARG);
}

function configureAppIdentity(): void {
  app.setName(app.isPackaged ? 'Lodestone' : 'Lodestone-Dev');
}

function redirectLogsAwayFromMcpProtocol(): void {
  console.log = (...args: unknown[]) => console.error(...args);
}

function registerGuiSingleInstanceBehavior(ctx: AppContext): void {
  if (app.requestSingleInstanceLock()) {
    app.on('second-instance', () => showMainWindow(ctx));
    return;
  }

  console.log('[main] Another GUI instance is already running; exiting');
  app.quit();
}

async function startMcpBridge(ctx: AppContext): Promise<void> {
  try {
    await startMcpBridgeProcess(ctx);
  } catch (err) {
    console.error('[main] MCP bridge process failed:', err);
    app.quit();
  }
}

async function startGui(ctx: AppContext): Promise<void> {
  await resolvePackagedGuiDataDirectory();

  registerIpcHandlers(ctx);
  createWindow(ctx);
  createTray(ctx);
  startBackendAfterRendererLoads(ctx);
}

async function resolvePackagedGuiDataDirectory(): Promise<void> {
  if (!app.isPackaged) return;

  const existing = detectExistingDataDir();
  if (existing) {
    app.setPath('userData', existing);
    return;
  }

  if (lodestoneConfigFileExists(getDefaultLodestoneConfigPath(app.getPath('userData')))) {
    return;
  }

  const chosen = await runFirstRunSetup();
  if (chosen !== app.getPath('userData')) {
    app.setPath('userData', chosen);
  }
}

function startBackendAfterRendererLoads(ctx: AppContext): void {
  if (!ctx.mainWindow) throw new Error('Main window was not created');

  ctx.mainWindow.webContents.once('did-finish-load', async () => {
    try {
      await initializeBackend(ctx);
      await startGuiInternalApi(ctx);
    } catch (err) {
      console.error('[main] Backend initialization error:', err);
    }
  });
}

async function startGuiInternalApi(ctx: AppContext): Promise<void> {
  const { InternalApi } = await import('./main/internal-api');
  ctx.internalApi = new InternalApi(ctx);
  ctx.internalApi.start();
}

function needsBackendShutdown(ctx: AppContext): boolean {
  return !ctx.shuttingDown && (ctx.siloManagers.size > 0 || ctx.embeddingServices.size > 0);
}

function quitAfterShutdownTimeout(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      console.warn('[main] Shutdown timed out after 5 s; force-quitting');
      resolve();
    }, SHUTDOWN_TIMEOUT_MS).unref();
  });
}

function keepGuiProcessRunningInTray(): void {
  return;
}

function showOrCreateMainWindow(ctx: AppContext): void {
  if (ctx.mainWindow) {
    showMainWindow(ctx);
    return;
  }

  createWindow(ctx);
}

function showMainWindow(ctx: AppContext): void {
  if (!ctx.mainWindow) return;

  if (ctx.mainWindow.isMinimized()) ctx.mainWindow.restore();
  ctx.mainWindow.show();
  ctx.mainWindow.focus();
}
