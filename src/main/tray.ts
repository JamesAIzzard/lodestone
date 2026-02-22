/**
 * System tray icon and context menu.
 */

import { app, Menu, nativeImage, Tray } from 'electron';
import type { AppContext } from './context';
import { createWindow } from './window';
import { stopSilo, wakeSilo } from './lifecycle';

export function buildTrayMenu(ctx: AppContext): Menu {
  const statusLabel = (state: string) =>
    state === 'stopped' ? '⏸ Stopped'
      : state === 'waiting' ? '⏳ Waiting'
        : state === 'indexing' ? '⟳ Indexing'
          : state === 'error' ? '✕ Error'
            : '● Ready';

  const siloItems = Array.from(ctx.siloManagers.entries()).map(([name, manager]) => ({
    label: `${name}  ${statusLabel(manager.getStatus().watcherState)}`,
    enabled: false,
  }));

  const allStopped = ctx.siloManagers.size > 0 &&
    Array.from(ctx.siloManagers.values()).every((m) => m.isStopped);
  const anyStopped = Array.from(ctx.siloManagers.values()).some((m) => m.isStopped);

  return Menu.buildFromTemplate([
    {
      label: 'Open Dashboard',
      click: () => {
        if (ctx.mainWindow) {
          ctx.mainWindow.show();
          ctx.mainWindow.focus();
        } else {
          createWindow(ctx);
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Silos',
      submenu: siloItems.length > 0
        ? siloItems
        : [{ label: 'No silos configured', enabled: false }],
    },
    {
      label: 'Stop All',
      enabled: !allStopped,
      click: async () => {
        for (const [name, manager] of ctx.siloManagers) {
          if (!manager.isStopped) {
            await stopSilo(ctx, name);
          }
        }
      },
    },
    {
      label: 'Wake All',
      enabled: anyStopped,
      click: async () => {
        for (const [name, manager] of ctx.siloManagers) {
          if (manager.isStopped) {
            await wakeSilo(ctx, name);
          }
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        ctx.isQuitting = true;
        app.quit();
      },
    },
  ]);
}

export function createTray(ctx: AppContext): Tray {
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAQElEQVR4nGNgGNTg////W0CYIs1kGYKkEQaINwSLZuINwaOZsCFEaMZvCMUGUOwFqgQiHkMoSguUp0ayNNMNAADkCUHcy6YwLAAAAABJRU5ErkJggg==',
  );
  const tray = new Tray(icon);
  tray.setToolTip('Lodestone');
  tray.setContextMenu(buildTrayMenu(ctx));

  tray.on('double-click', () => {
    if (ctx.mainWindow) {
      ctx.mainWindow.show();
      ctx.mainWindow.focus();
    } else {
      createWindow(ctx);
    }
  });

  ctx.tray = tray;
  return tray;
}
