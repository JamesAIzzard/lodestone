/**
 * Electron window creation and close-to-tray behaviour.
 */

import { BrowserWindow } from 'electron';
import path from 'node:path';
import type { AppContext } from './context';

export function createWindow(ctx: AppContext): BrowserWindow {
  const win = new BrowserWindow({
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
    win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  // Close-to-tray: hide window instead of closing
  win.on('close', (event) => {
    if (!ctx.isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    ctx.mainWindow = null;
  });

  ctx.mainWindow = win;
  return win;
}
