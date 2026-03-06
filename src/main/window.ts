/**
 * Electron window creation and close-to-tray behaviour.
 */

import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import type { AppContext } from './context';

export function createWindow(ctx: AppContext): BrowserWindow {
  const win = new BrowserWindow({
    title: app.name,
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 600,
    backgroundColor: '#1a1a1a',
    autoHideMenuBar: true,
    icon: path.join(app.getAppPath(), 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Keep the window title as app.name (e.g. "Lodestone-Dev") instead of
  // letting the HTML <title> tag override it.
  win.on('page-title-updated', (event) => {
    event.preventDefault();
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
