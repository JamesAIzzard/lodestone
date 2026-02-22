/**
 * Activity event forwarding from SiloManagers to the renderer process.
 *
 * Converts internal WatcherEvent objects to serializable ActivityEvent DTOs
 * and pushes them to the renderer via the BrowserWindow's webContents.
 */

import type { SiloManager } from '../backend/silo-manager';
import type { ActivityEvent } from '../shared/types';
import type { AppContext } from './context';

export function pushActivityToRenderer(ctx: AppContext, event: ActivityEvent): void {
  if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
    ctx.mainWindow.webContents.send('activity:push', event);
  }
}

export function attachActivityForwarding(ctx: AppContext, manager: SiloManager): void {
  manager.onEvent((event) => {
    pushActivityToRenderer(ctx, {
      id: String(ctx.nextEventId++),
      timestamp: event.timestamp.toISOString(),
      siloName: event.siloName,
      filePath: event.filePath,
      eventType: event.eventType,
      errorMessage: event.errorMessage,
    });
  });
}
