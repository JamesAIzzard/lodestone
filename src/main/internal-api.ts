/**
 * Internal API — GUI-side named pipe server for MCP process communication.
 *
 * The GUI process creates a named pipe server that MCP processes connect to.
 * All search and status queries from MCP go through this pipe, so the MCP
 * process never opens databases or reads config directly.
 *
 * Protocol: newline-delimited JSON over \\.\pipe\lodestone-gui
 * - Requests  (MCP → GUI): { id, method, params? }
 * - Responses (GUI → MCP): { id, result?, error? }
 * - Push notifications (GUI → MCP): { method, params } (no id)
 */

import path from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import type { AppContext } from './context';
import { dispatchExplore, mergeDirectoryResults, dispatchSearch, mergeSearchResults } from '../backend/search-merge';
import { resolveModelAlias } from '../backend/model-registry';
import type { SearchResult, DirectoryResult, SiloStatus, SearchParams, MemoryRecord, MemorySearchResult } from '../shared/types';
import type { EditOperation, EditResult } from '../backend/edit';
import type { SiloManager } from '../backend/silo-manager';
import { MEMORY_MODEL } from '../backend/memory-store';

/** Windows named pipe path. */
export const GUI_PIPE_NAME = '\\\\.\\pipe\\lodestone-gui';

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

// ── Types ───────────────────────────────────────────────────────────────────

interface PipeRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

// ── InternalApi ─────────────────────────────────────────────────────────────

export class InternalApi {
  private server: Server | null = null;
  private clients = new Set<Socket>();

  constructor(private ctx: AppContext) {}

  start(): void {
    this.server = createServer((socket) => this.handleConnection(socket));

    this.server.on('error', (err: NodeJS.ErrnoException) => {
      console.error('[internal-api] Server error:', err);
    });

    this.server.listen(GUI_PIPE_NAME, () => {
      console.log(`[internal-api] Listening on ${GUI_PIPE_NAME}`);
    });
  }

  stop(): void {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
    }
    console.log('[internal-api] Stopped');
  }

  /** Broadcast a push notification to all connected MCP clients. */
  pushNotification(method: string, params: unknown): void {
    const msg = JSON.stringify({ method, params }) + '\n';
    for (const client of this.clients) {
      if (!client.destroyed) {
        client.write(msg);
      }
    }
  }

  // ── Connection Handling ─────────────────────────────────────────────────

  private handleConnection(socket: Socket): void {
    console.log('[internal-api] MCP client connected');
    this.clients.add(socket);

    const lineBuffer = new LineBuffer();

    socket.on('data', (data) => {
      const lines = lineBuffer.push(data.toString('utf-8'));
      for (const line of lines) {
        if (!line.trim()) continue;
        this.handleMessage(socket, line);
      }
    });

    socket.on('close', () => {
      console.log('[internal-api] MCP client disconnected');
      this.clients.delete(socket);
    });

    socket.on('error', (err) => {
      console.error('[internal-api] Client socket error:', err);
      this.clients.delete(socket);
    });
  }

  private async handleMessage(socket: Socket, raw: string): Promise<void> {
    let req: PipeRequest;
    try {
      req = JSON.parse(raw);
    } catch {
      console.error('[internal-api] Invalid JSON:', raw.slice(0, 200));
      return;
    }

    try {
      let result: unknown;
      switch (req.method) {
        case 'search':
          result = await this.handleSearch(req.params ?? {});
          break;
        case 'explore':
          result = await this.handleExplore(req.params ?? {});
          break;
        case 'status':
          result = await this.handleStatus();
          break;
        case 'edit':
          result = await this.handleEdit(req.params ?? {});
          break;
        case 'getDefaults':
          result = this.handleGetDefaults();
          break;
        case 'notify.activity':
          result = this.handleNotifyActivity(req.params ?? {});
          break;
        case 'memory.remember':
          result = await this.handleMemoryRemember(req.params ?? {});
          break;
        case 'memory.recall':
          result = await this.handleMemoryRecall(req.params ?? {});
          break;
        case 'memory.revise':
          result = await this.handleMemoryRevise(req.params ?? {});
          break;
        case 'memory.forget':
          result = this.handleMemoryForget(req.params ?? {});
          break;
        case 'memory.orient':
          result = this.handleMemoryOrient(req.params ?? {});
          break;
        default:
          this.sendResponse(socket, req.id, undefined, `Unknown method: ${req.method}`);
          return;
      }
      this.sendResponse(socket, req.id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[internal-api] Error handling ${req.method}:`, message);
      this.sendResponse(socket, req.id, undefined, message);
    }
  }

  private sendResponse(socket: Socket, id: number, result?: unknown, error?: string): void {
    if (socket.destroyed) return;
    const msg = error !== undefined
      ? JSON.stringify({ id, error })
      : JSON.stringify({ id, result });
    socket.write(msg + '\n');
  }

  // ── Method Handlers ───────────────────────────────────────────────────

  /**
   * Handle a search request. Mirrors the IPC `silos:search` handler logic.
   */
  private async handleSearch(params: Record<string, unknown>): Promise<{
    results: SearchResult[];
    warnings: string[];
  }> {
    const query = params.query as string;
    const silo = params.silo as string | undefined;
    const maxResults = (params.maxResults as number) ?? 10;
    const mode = (params.mode as SearchParams['mode']) ?? 'hybrid';
    const startPath = params.startPath as string | undefined;
    const filePattern = params.filePattern as string | undefined;
    const regexFlags = params.regexFlags as string | undefined;

    if (!query) throw new Error('Missing required parameter: query');

    const searchParams: SearchParams = { query, mode, limit: maxResults, startPath, filePattern, regexFlags };

    // Notify renderer that a silo is being queried (triggers shimmer effect)
    this.ctx.mainWindow?.webContents.send('mcp:activity', { channel: 'silo', siloName: silo });

    // Collect managers — skip stopped and model-mismatched silos
    const ready: [string, SiloManager][] = [];
    const warnings: string[] = [];

    if (silo) {
      const m = this.ctx.siloManagers.get(silo);
      if (!m) throw new Error(`Silo "${silo}" not found`);
      if (m.isStopped) throw new Error(`Silo "${silo}" is stopped`);
      if (m.hasModelMismatch()) throw new Error(`Silo "${silo}" has a model mismatch — rebuild required`);
      ready.push([silo, m]);
    } else {
      for (const [name, m] of this.ctx.siloManagers) {
        if (!m.isStopped && !m.hasModelMismatch()) ready.push([name, m]);
      }
    }

    // Check readiness — collect warnings for partial results
    // Regex mode doesn't need an embedding service, so skip that warning
    for (const [name, manager] of ready) {
      const service = manager.getEmbeddingService();
      const status = manager.getStatus();
      if (mode !== 'regex' && !service) {
        warnings.push(`Silo "${name}" is still initializing and not yet searchable.`);
      } else if (status.watcherState === 'indexing') {
        const prog = status.reconcileProgress;
        if (prog) {
          warnings.push(
            `Silo "${name}" is indexing (${prog.current.toLocaleString()} / ${prog.total.toLocaleString()} files) — results may be incomplete.`,
          );
        } else {
          warnings.push(`Silo "${name}" is indexing — results may be incomplete.`);
        }
      }
    }

    // Filepath and regex modes can search any ready silo; other modes need an embedding service
    const searchable = mode === 'regex' || mode === 'filepath'
      ? ready
      : ready.filter(([, m]) => m.getEmbeddingService() !== null);

    if (searchable.length === 0) {
      return { results: [], warnings };
    }

    const raw = await dispatchSearch(
      searchParams,
      searchable,
      (model) => this.ctx.embeddingServices.get(resolveModelAlias(model)) ?? null,
    );

    const merged = mergeSearchResults(raw, maxResults);

    const results: SearchResult[] = merged.map((r) => ({
      filePath: r.filePath,
      siloName: r.siloName,
      score: r.score,
      scoreLabel: r.scoreLabel,
      signals: r.signals,
      hint: r.hint,
    }));

    return { results, warnings };
  }

  /**
   * Handle an explore request. Mirrors the IPC `silos:explore` handler logic.
   */
  private async handleExplore(params: Record<string, unknown>): Promise<{
    results: DirectoryResult[];
    warnings: string[];
  }> {
    const query = params.query as string | undefined;
    const silo = params.silo as string | undefined;
    const startPath = params.startPath as string | undefined;
    const maxDepth = (params.maxDepth as number) ?? 2;
    const maxResults = (params.maxResults as number) ?? 20;
    const fullContents = params.fullContents as boolean | undefined;

    // Notify renderer that a silo is being queried (triggers shimmer effect)
    this.ctx.mainWindow?.webContents.send('mcp:activity', { channel: 'silo', siloName: silo });

    // Collect searchable managers
    const ready: [string, SiloManager][] = [];
    const warnings: string[] = [];

    if (silo) {
      const m = this.ctx.siloManagers.get(silo);
      if (!m) throw new Error(`Silo "${silo}" not found`);
      if (m.isStopped) throw new Error(`Silo "${silo}" is stopped`);
      if (m.hasModelMismatch()) throw new Error(`Silo "${silo}" has a model mismatch — rebuild required`);
      ready.push([silo, m]);
    } else {
      for (const [name, m] of this.ctx.siloManagers) {
        if (!m.isStopped && !m.hasModelMismatch()) ready.push([name, m]);
      }
    }

    // Check readiness
    for (const [name, manager] of ready) {
      const status = manager.getStatus();
      if (status.watcherState === 'indexing') {
        const prog = status.reconcileProgress;
        if (prog) {
          warnings.push(
            `Silo "${name}" is indexing (${prog.current.toLocaleString()} / ${prog.total.toLocaleString()} files) — results may be incomplete.`,
          );
        } else {
          warnings.push(`Silo "${name}" is indexing — results may be incomplete.`);
        }
      }
    }

    if (ready.length === 0) {
      return { results: [], warnings };
    }

    // No embeddings needed — directory scoring uses string-based scorers
    const raw = await dispatchExplore(
      { query, startPath, maxDepth, maxResults, fullContents },
      ready,
    );

    const merged = mergeDirectoryResults(raw, maxResults);

    const results: DirectoryResult[] = merged.map((r) => ({
      dirPath: r.dirPath,
      dirName: r.dirName,
      siloName: r.siloName,
      score: r.score,
      scoreSource: r.scoreSource,
      axes: r.axes,
      fileCount: r.fileCount,
      subdirCount: r.subdirCount,
      depth: r.depth,
      children: r.children,
      files: r.files,
    }));

    return { results, warnings };
  }

  /**
   * Handle an edit request. Delegates to the edit module.
   * After a successful text edit or create, triggers immediate reindexing
   * so subsequent searches reflect the change without waiting for chokidar.
   */
  private async handleEdit(params: Record<string, unknown>): Promise<EditResult> {
    this.ctx.mainWindow?.webContents.send('mcp:activity', { channel: 'silo' });
    const { executeEdit } = await import('../backend/edit');
    const operation = params.operation as EditOperation;
    const contextLines = (params.contextLines as number) ?? 10;
    const siloDirectories = (params.siloDirectories as string[]) ?? [];
    const result = await executeEdit(operation, contextLines, siloDirectories);

    // Trigger immediate reindex for text edits and file creation
    if (result.success && result.sourcePath) {
      const op = (operation as { op: string }).op;
      if (['str_replace', 'insert_at_line', 'overwrite', 'append', 'create'].includes(op)) {
        this.reindexEditedFile(result.sourcePath);
      }
    }

    return result;
  }

  /**
   * Find the silo that owns a file path and trigger an immediate reindex.
   * Fire-and-forget — errors are logged but don't affect the edit result.
   */
  private reindexEditedFile(filePath: string): void {
    const resolved = path.resolve(filePath);
    for (const manager of this.ctx.siloManagers.values()) {
      const dirs = manager.getConfig().directories;
      const isOwned = dirs.some(d => resolved.startsWith(path.resolve(d) + path.sep));
      if (isOwned) {
        manager.reindexFile(filePath).catch(err => {
          console.error(`[internal-api] reindex failed for ${filePath}:`, err);
        });
        return;
      }
    }
  }

  /**
   * Return config defaults relevant to the MCP server.
   */
  private handleNotifyActivity(params: Record<string, unknown>): Record<string, never> {
    const channel = params.channel as 'silo' | 'memory';
    const siloName = params.siloName as string | undefined;
    this.ctx.mainWindow?.webContents.send('mcp:activity', { channel, siloName });
    return {};
  }

  private handleGetDefaults(): { contextLines: number } {
    const contextLines = this.ctx.config?.defaults.context_lines ?? 10;
    return { contextLines };
  }

  // ── Memory Method Handlers ───────────────────────────────────────────────

  private async handleMemoryRemember(params: Record<string, unknown>): Promise<{ id: number; updated: boolean }> {
    this.ctx.mainWindow?.webContents.send('mcp:activity', { channel: 'memory' });
    const mm = this.ctx.memoryManager;
    if (!mm?.isConnected()) throw new Error('No memory database connected');

    const topic = (params.topic as string | undefined) ?? 'GENERAL';
    const body = params.body as string;
    const confidence = (params.confidence as number | undefined) ?? 1.0;
    const contextHint = (params.contextHint as string | undefined) ?? null;

    if (!body?.trim()) throw new Error('Missing required parameter: body');

    const service = this.ctx.getOrCreateEmbeddingService(MEMORY_MODEL);
    await service.ensureReady();

    const result = await mm.remember(topic, body.trim(), confidence, contextHint, service);
    this.notifyMemoriesChanged();
    return result;
  }

  private async handleMemoryRecall(params: Record<string, unknown>): Promise<MemorySearchResult[]> {
    this.ctx.mainWindow?.webContents.send('mcp:activity', { channel: 'memory' });
    const mm = this.ctx.memoryManager;
    if (!mm?.isConnected()) throw new Error('No memory database connected');

    const query = params.query as string;
    const maxResults = (params.maxResults as number | undefined) ?? 5;

    if (!query?.trim()) throw new Error('Missing required parameter: query');

    const service = this.ctx.getOrCreateEmbeddingService(MEMORY_MODEL);
    await service.ensureReady();

    return mm.recall(query.trim(), maxResults, service);
  }

  private async handleMemoryRevise(params: Record<string, unknown>): Promise<void> {
    this.ctx.mainWindow?.webContents.send('mcp:activity', { channel: 'memory' });
    const mm = this.ctx.memoryManager;
    if (!mm?.isConnected()) throw new Error('No memory database connected');

    const id = params.id as number;
    if (typeof id !== 'number') throw new Error('Missing required parameter: id');

    const updates: { body?: string; confidence?: number; contextHint?: string | null } = {};
    if (typeof params.body === 'string') updates.body = params.body;
    if (typeof params.confidence === 'number') updates.confidence = params.confidence;
    if ('contextHint' in params) updates.contextHint = params.contextHint as string | null;

    if (Object.keys(updates).length === 0) throw new Error('No fields to update');

    const service = this.ctx.getOrCreateEmbeddingService(MEMORY_MODEL);
    await service.ensureReady();

    await mm.revise(id, updates, service);
    this.notifyMemoriesChanged();
  }

  private handleMemoryForget(params: Record<string, unknown>): void {
    this.ctx.mainWindow?.webContents.send('mcp:activity', { channel: 'memory' });
    const mm = this.ctx.memoryManager;
    if (!mm?.isConnected()) throw new Error('No memory database connected');

    const id = params.id as number;
    if (typeof id !== 'number') throw new Error('Missing required parameter: id');

    mm.forget(id);
    this.notifyMemoriesChanged();
  }

  private handleMemoryOrient(params: Record<string, unknown>): MemoryRecord[] {
    this.ctx.mainWindow?.webContents.send('mcp:activity', { channel: 'memory' });
    const mm = this.ctx.memoryManager;
    if (!mm?.isConnected()) throw new Error('No memory database connected');

    const maxResults = (params.maxResults as number | undefined) ?? 10;
    return mm.orient(maxResults);
  }

  private notifyMemoriesChanged(): void {
    this.ctx.mainWindow?.webContents.send('memories:changed');
  }

  /**
   * Handle a status request. Mirrors the IPC `silos:list` handler.
   */
  private handleStatus(): { silos: SiloStatus[] } {
    this.ctx.mainWindow?.webContents.send('mcp:activity', { channel: 'silo' });
    const statuses: SiloStatus[] = [];
    for (const manager of this.ctx.siloManagers.values()) {
      const status = manager.getStatus();
      const cfg = manager.getConfig();
      const siloToml = this.ctx.config?.silos[cfg.name];
      statuses.push({
        config: {
          name: cfg.name,
          directories: cfg.directories,
          extensions: cfg.extensions,
          ignorePatterns: cfg.ignore,
          ignoreFilePatterns: cfg.ignoreFiles,
          hasIgnoreOverride: siloToml?.ignore !== undefined,
          hasFileIgnoreOverride: siloToml?.ignore_files !== undefined,
          hasExtensionOverride: siloToml?.extensions !== undefined,
          modelOverride: cfg.model === resolveModelAlias(this.ctx.config?.embeddings.model ?? '') ? null : cfg.model,
          dbPath: cfg.dbPath,
          description: cfg.description,
          color: cfg.color,
          icon: cfg.icon,
        },
        indexedFileCount: status.indexedFileCount,
        chunkCount: status.chunkCount,
        lastUpdated: status.lastUpdated?.toISOString() ?? null,
        databaseSizeBytes: status.databaseSizeBytes,
        watcherState: status.watcherState,
        errorMessage: status.errorMessage,
        reconcileProgress: status.reconcileProgress,
        modelMismatch: status.modelMismatch,
        resolvedDbPath: status.resolvedDbPath,
        resolvedModel: cfg.model,
      });
    }
    return { silos: statuses };
  }

}
