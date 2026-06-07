/**
 * Headless process that speaks MCP to the client and proxies every Lodestone
 * operation to the running GUI process.
 */

import { app } from 'electron';
import { createConnection, type Socket } from 'node:net';
import { startMcpServer } from '../backend/mcp';
import type { SearchResult, DirectoryResult, SiloStatus } from '../shared/types';
import type { EditResult } from '../backend/edit';
import type { AppContext } from './context';
import { GUI_PIPE_NAME } from './internal-api';

const RPC_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;

type McpServerHandle = Awaited<ReturnType<typeof startMcpServer>>;

class LineBuffer {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let idx: number;

    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      lines.push(this.buffer.slice(0, idx));
      this.buffer = this.buffer.slice(idx + 1);
    }

    return lines;
  }
}

class GuiPipeClient {
  private lineBuffer = new LineBuffer();
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (err: Error) => void;
    }
  >();

  constructor(private socket: Socket) {
    socket.on('data', (data) => {
      const lines = this.lineBuffer.push(data.toString('utf-8'));
      for (const line of lines) {
        if (!line.trim()) continue;
        this.handleMessage(line);
      }
    });
  }

  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const msg = JSON.stringify({ id, method, params }) + '\n';

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `RPC call '${method}' timed out after ${RPC_TIMEOUT_MS / 1000}s; is the Lodestone GUI responsive?`,
          ),
        );
      }, RPC_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (result: unknown) => {
          clearTimeout(timer);
          resolve(result as T);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.socket.write(msg);
    });
  }

  private handleMessage(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: string };

    try {
      msg = JSON.parse(raw);
    } catch {
      console.error('[mcp] Invalid JSON from GUI pipe:', raw.slice(0, 200));
      return;
    }

    if (msg.id === undefined) return;

    const entry = this.pending.get(msg.id);
    if (!entry) return;

    this.pending.delete(msg.id);
    if (msg.error) {
      entry.reject(new Error(msg.error));
    } else {
      entry.resolve(msg.result);
    }
  }
}

export async function startMcpBridgeProcess(_ctx: AppContext): Promise<void> {
  console.log('[main] Starting MCP bridge process');

  const ipcPath = getWrapperPipePath();
  if (!ipcPath) {
    console.error(
      '[main] MCP bridge process requires --ipc-path=<pipe>. Use mcp-wrapper.js to launch.',
    );
    app.quit();
    return;
  }

  const guiSocket = await connectToRequiredGuiPipe();
  if (!guiSocket) {
    app.quit();
    return;
  }

  const gui = new GuiPipeClient(guiSocket);
  const wrapperSocket = await connectToWrapperPipe(ipcPath);
  const mcpHandle = await startProxiedMcpServer(gui, wrapperSocket);

  registerBridgeShutdown({ mcpHandle, wrapperSocket, guiSocket });
}

function getWrapperPipePath(): string | null {
  const ipcPathArg = process.argv.find((arg) => arg.startsWith('--ipc-path='));
  return ipcPathArg?.split('=')[1] ?? null;
}

async function connectToRequiredGuiPipe(): Promise<Socket | null> {
  console.log('[main] Connecting to GUI pipe...');

  try {
    const socket = await connectToPipe(GUI_PIPE_NAME);
    console.log('[main] Connected to GUI pipe');
    return socket;
  } catch (err) {
    console.error(
      '[main] Failed to connect to Lodestone GUI. Is it running?\n' +
        '  The MCP server requires the Lodestone GUI to be open.',
      err,
    );
    return null;
  }
}

async function connectToWrapperPipe(ipcPath: string): Promise<Socket> {
  console.log('[main] Connecting to MCP wrapper pipe...');
  const wrapperSocket = createConnection(ipcPath);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      wrapperSocket.destroy();
      reject(
        new Error(`Connection to MCP wrapper pipe timed out after ${CONNECT_TIMEOUT_MS / 1000}s`),
      );
    }, CONNECT_TIMEOUT_MS);

    wrapperSocket.once('connect', () => {
      clearTimeout(timer);
      console.log(`[main] Connected to MCP wrapper pipe: ${ipcPath}`);
      resolve();
    });
    wrapperSocket.once('error', (err) => {
      clearTimeout(timer);
      console.error('[main] Failed to connect to MCP wrapper pipe:', err);
      reject(err);
    });
  });

  return wrapperSocket;
}

function startProxiedMcpServer(
  gui: GuiPipeClient,
  wrapperSocket: Socket,
): Promise<McpServerHandle> {
  return startMcpServer({
    input: wrapperSocket,
    output: wrapperSocket,
    silo: {
      search: (params) =>
        gui.call<{ results: SearchResult[]; warnings: string[] }>('search', params),
      explore: (params) =>
        gui.call<{ results: DirectoryResult[]; warnings: string[] }>('explore', params),
      status: () => gui.call<{ silos: SiloStatus[] }>('status'),
      edit: (params) => gui.call<EditResult>('edit', params),
      getDefaults: () => gui.call<{ contextLines: number }>('getDefaults'),
    },
    notifyActivity: (params) => {
      gui.call('notify.activity', params as Record<string, unknown>).catch((): void => undefined);
    },
  });
}

function registerBridgeShutdown({
  mcpHandle,
  wrapperSocket,
  guiSocket,
}: {
  mcpHandle: McpServerHandle;
  wrapperSocket: Socket;
  guiSocket: Socket;
}): void {
  let shuttingDown = false;
  let parentPollTimer: ReturnType<typeof setInterval> | null = null;

  const shutdown = async () => {
    if (shuttingDown) return;

    shuttingDown = true;
    console.log('[main] Shutting down MCP bridge process...');
    if (parentPollTimer) clearInterval(parentPollTimer);

    await mcpHandle.stop();
    wrapperSocket.destroy();
    guiSocket.destroy();
    app.quit();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  wrapperSocket.on('close', shutdown);
  guiSocket.on('close', () => {
    console.log('[main] GUI pipe disconnected; shutting down');
    shutdown();
  });

  parentPollTimer = pollParentProcess(shutdown);
}

function pollParentProcess(onParentExit: () => void): ReturnType<typeof setInterval> {
  const parentPid = process.ppid;
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      console.log(`[main] Parent process (PID ${parentPid}) gone; shutting down`);
      onParentExit();
    }
  }, 2000);

  timer.unref();
  return timer;
}

function connectToPipe(pipeName: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(pipeName);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Connection to ${pipeName} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
