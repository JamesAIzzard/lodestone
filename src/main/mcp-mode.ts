/**
 * Headless MCP mode — runs Lodestone without a window or tray.
 *
 * In this mode the MCP process is a **pure protocol bridge**:
 * - No Electron window or tray is created
 * - No databases or config files are opened directly
 * - All search and status requests are proxied to the GUI process
 *   via a named pipe (\\.\pipe\lodestone-gui)
 * - The GUI process must be running — if it isn't, MCP reports an error
 *
 * On Windows, Electron is a GUI app and cannot receive piped stdin
 * (electron/electron#4218). The mcp-wrapper.js proxy handles stdio with the
 * MCP client and relays traffic over a named pipe that Electron connects to.
 */

import { app } from 'electron';
import { createConnection, type Socket } from 'node:net';
import { startMcpServer } from '../backend/mcp-server';
import type { SearchResult, DirectoryResult, SiloStatus, MemoryRecord, MemorySearchResult } from '../shared/types';
import type { EditResult } from '../backend/edit';
import type { AppContext } from './context';

/** Must match the pipe name in internal-api.ts (GUI side). */
const GUI_PIPE_NAME = '\\\\.\\pipe\\lodestone-gui';

// ── Line Buffer ─────────────────────────────────────────────────────────────

/** Accumulates data chunks and splits on newline boundaries. */
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

// ── GUI Pipe Client ─────────────────────────────────────────────────────────

/**
 * Client for the GUI process's internal API pipe.
 * Sends JSON-RPC-style requests and receives responses.
 */
class GuiPipeClient {
  private lineBuffer = new LineBuffer();
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (result: unknown) => void;
    reject: (err: Error) => void;
  }>();

  constructor(private socket: Socket) {
    socket.on('data', (data) => {
      const lines = this.lineBuffer.push(data.toString('utf-8'));
      for (const line of lines) {
        if (!line.trim()) continue;
        this.handleMessage(line);
      }
    });
  }

  /** Send a request to the GUI and wait for the response. */
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const msg = JSON.stringify({ id, method, params }) + '\n';
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
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

// ── Entry Point ─────────────────────────────────────────────────────────────

export async function startMcpMode(_ctx: AppContext): Promise<void> {
  console.log('[main] Starting in MCP mode (headless proxy)');

  // ── Parse wrapper pipe path ───────────────────────────────────────────
  const ipcPathArg = process.argv.find((a) => a.startsWith('--ipc-path='));
  const ipcPath = ipcPathArg?.split('=')[1];

  if (!ipcPath) {
    console.error('[main] MCP mode requires --ipc-path=<pipe>. Use mcp-wrapper.js to launch.');
    app.quit();
    return;
  }

  // ── Connect to GUI pipe ───────────────────────────────────────────────
  console.log('[main] Connecting to GUI pipe...');
  let guiSocket: Socket;
  try {
    guiSocket = await connectToPipe(GUI_PIPE_NAME);
    console.log('[main] Connected to GUI pipe');
  } catch (err) {
    console.error(
      '[main] Failed to connect to Lodestone GUI. Is it running?\n' +
      '  The MCP server requires the Lodestone GUI to be open.',
      err,
    );
    app.quit();
    return;
  }

  const gui = new GuiPipeClient(guiSocket);

  // ── Connect to wrapper pipe ───────────────────────────────────────────
  console.log('[main] Connecting to MCP wrapper pipe...');
  const wrapperSocket = createConnection(ipcPath);

  await new Promise<void>((resolve, reject) => {
    wrapperSocket.once('connect', () => {
      console.log(`[main] Connected to MCP wrapper pipe: ${ipcPath}`);
      resolve();
    });
    wrapperSocket.once('error', (err) => {
      console.error('[main] Failed to connect to MCP wrapper pipe:', err);
      reject(err);
    });
  });

  // ── Start MCP server (proxied through GUI pipe) ───────────────────────
  const mcpHandle = await startMcpServer({
    input: wrapperSocket,
    output: wrapperSocket,
    search: (params) => gui.call<{ results: SearchResult[]; warnings: string[] }>('search', params),
    explore: (params) => gui.call<{ results: DirectoryResult[]; warnings: string[] }>('explore', params),
    status: () => gui.call<{ silos: SiloStatus[] }>('status'),
    edit: (params) => gui.call<EditResult>('edit', params),
    getDefaults: () => gui.call<{ contextLines: number }>('getDefaults'),
    memoryRemember: (params) => gui.call<{ id: number; updated: boolean }>('memory.remember', params as Record<string, unknown>),
    memoryRecall: (params) => gui.call<MemorySearchResult[]>('memory.recall', params as Record<string, unknown>),
    memoryRevise: (params) => gui.call<void>('memory.revise', params as Record<string, unknown>),
    memoryForget: (params) => gui.call<void>('memory.forget', params as Record<string, unknown>),
    memoryOrient: (params) => gui.call<MemoryRecord[]>('memory.orient', params as Record<string, unknown>),
    memoryGetById: (params) => gui.call<MemoryRecord | null>('memory.getById', params as Record<string, unknown>),
    notifyActivity: (params) => { gui.call('notify.activity', params as Record<string, unknown>).catch(() => {}); },
  });

  // ── Shutdown ──────────────────────────────────────────────────────────

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[main] Shutting down MCP mode...');
    clearInterval(parentPollTimer);
    await mcpHandle.stop();
    wrapperSocket.destroy();
    guiSocket.destroy();
    app.quit();
  };

  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());

  wrapperSocket.on('close', () => shutdown());
  guiSocket.on('close', () => {
    console.log('[main] GUI pipe disconnected — shutting down');
    shutdown();
  });

  // ── Orphan Prevention ────────────────────────────────────────────────
  // On Windows, if the parent wrapper process is killed via TerminateProcess()
  // (which is how Task Manager, Claude Desktop, and child.kill() work), none
  // of our signal handlers fire and the named pipe may not close promptly.
  // Poll the parent PID to detect this and self-exit.
  const parentPid = process.ppid;
  const parentPollTimer = setInterval(() => {
    try {
      // process.kill(pid, 0) throws if the process no longer exists
      process.kill(parentPid, 0);
    } catch {
      console.log(`[main] Parent process (PID ${parentPid}) gone — shutting down`);
      shutdown();
    }
  }, 2000);
  parentPollTimer.unref();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Connect to a named pipe, returning the socket on success. */
function connectToPipe(pipeName: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(pipeName);
    socket.once('connect', () => resolve(socket));
    socket.once('error', (err) => reject(err));
  });
}
