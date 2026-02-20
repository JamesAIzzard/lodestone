import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let indexingPaused = false;

// Mock silo data for the tray menu (matches shared/mock-data.ts)
const traySilos = [
  { name: 'personal-kb', status: 'idle', files: 342 },
  { name: 'dietrix', status: 'indexing', files: 128 },
  { name: 'reference-papers', status: 'idle', files: 23 },
];

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  // Close-to-tray: hide window instead of closing
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── System Tray ───────────────────────────────────────────────────────────────

function buildTrayMenu(): Menu {
  const statusLabel = (status: string) =>
    status === 'indexing' ? '⟳ Indexing' : status === 'error' ? '✕ Error' : '● Idle';

  return Menu.buildFromTemplate([
    {
      label: 'Open Dashboard',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Silos',
      submenu: traySilos.map((silo) => ({
        label: `${silo.name}  ${statusLabel(silo.status)}  (${silo.files} files)`,
        enabled: false,
      })),
    },
    {
      label: indexingPaused ? 'Resume Indexing' : 'Pause Indexing',
      click: () => {
        indexingPaused = !indexingPaused;
        if (tray) tray.setContextMenu(buildTrayMenu());
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  // Create a 16x16 placeholder icon (white diamond on transparent)
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAQElEQVR4nGNgGNTg////W0CYIs1kGYKkEQaINwSLZuINwaOZsCFEaMZvCMUGUOwFqgQiHkMoSguUp0ayNNMNAADkCUHcy6YwLAAAAABJRU5ErkJggg==',
  );
  tray = new Tray(icon);
  tray.setToolTip('Lodestone');
  tray.setContextMenu(buildTrayMenu());

  // Double-click tray icon opens dashboard (Windows convention)
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}

// ── IPC Handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('dialog:selectDirectories', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'multiSelections'],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('shell:openPath', async (_event, filePath: string) => {
  await shell.openPath(filePath);
});

// ── App Lifecycle ─────────────────────────────────────────────────────────────

app.on('ready', () => {
  createWindow();
  createTray();
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  // On Windows/Linux: don't quit when all windows are closed (tray keeps running)
  // On macOS: standard behavior
  if (process.platform === 'darwin') {
    // macOS: app stays in dock, no action needed
  }
  // Otherwise: app stays in tray
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
});
