/**
 * System tray icon and context menu.
 */

import { app, Menu, nativeImage, Tray } from 'electron';
import type { AppContext } from './context';
import { createWindow } from './window';
import { sleepSilo, wakeSilo } from './lifecycle';

export function buildTrayMenu(ctx: AppContext): Menu {
  const statusLabel = (state: string) =>
    state === 'sleeping' ? '⏸ Sleeping'
      : state === 'waiting' ? '⏳ Waiting'
        : state === 'indexing' ? '⟳ Indexing'
          : state === 'error' ? '✕ Error'
            : '● Idle';

  const siloItems = Array.from(ctx.siloManagers.entries()).map(([name, manager]) => ({
    label: `${name}  ${statusLabel(manager.getStatus().watcherState)}`,
    enabled: false,
  }));

  const allSleeping = ctx.siloManagers.size > 0 &&
    Array.from(ctx.siloManagers.values()).every((m) => m.isSleeping);
  const anySleeping = Array.from(ctx.siloManagers.values()).some((m) => m.isSleeping);

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
      label: 'Sleep All',
      enabled: !allSleeping,
      click: async () => {
        for (const [name, manager] of ctx.siloManagers) {
          if (!manager.isSleeping) {
            await sleepSilo(ctx, name);
          }
        }
      },
    },
    {
      label: 'Wake All',
      enabled: anySleeping,
      click: async () => {
        for (const [name, manager] of ctx.siloManagers) {
          if (manager.isSleeping) {
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
