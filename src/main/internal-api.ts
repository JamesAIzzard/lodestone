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

import { createServer, type Server, type Socket } from 'node:net';
import type { AppContext } from './context';
import { dispatchExplore, mergeDirectoryResults, dispatchTwoAxisSearch, mergeTwoAxisResults } from '../backend/search-merge';
import { resolveModelAlias } from '../backend/model-registry';
import type { SearchResult, DirectoryResult, SiloStatus } from '../shared/types';
import type { TextEditOperation, EditResult } from '../backend/edit';
import type { SiloManager } from '../backend/silo-manager';

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
    const startPath = params.startPath as string | undefined;

    if (!query) throw new Error('Missing required parameter: query');

    // Notify renderer that an MCP search is happening (for visual effects)
    this.ctx.mainWindow?.webContents.send('mcp:search', { query, silo });

    // Collect searchable managers — skip stopped and model-mismatched silos
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
    for (const [name, manager] of ready) {
      const service = manager.getEmbeddingService();
      const status = manager.getStatus();
      if (!service) {
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

    // Filter to silos that have an embedding service ready
    const searchable = ready.filter(([, m]) => m.getEmbeddingService() !== null);

    if (searchable.length === 0) {
      return { results: [], warnings };
    }

    const raw = await dispatchTwoAxisSearch(
      query,
      searchable,
      (model) => this.ctx.embeddingServices.get(resolveModelAlias(model)) ?? null,
      maxResults,
      startPath,
    );

    const merged = mergeTwoAxisResults(raw, maxResults);

    const results: SearchResult[] = merged.map((r) => ({
      filePath: r.filePath,
      siloName: r.siloName,
      score: r.score,
      scoreSource: r.scoreSource,
      contentScore: r.contentScore,
      filenameScore: r.filenameScore,
      chunks: r.chunks.map((c) => ({
        sectionPath: c.sectionPath,
        text: c.text,
        startLine: c.startLine,
        endLine: c.endLine,
        scores: c.scores,
      })),
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

    // Notify renderer that an MCP explore is happening
    this.ctx.mainWindow?.webContents.send('mcp:search', { query: query ?? '', silo });

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
      segmentScore: r.segmentScore,
      keywordScore: r.keywordScore,
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
   */
  private async handleEdit(params: Record<string, unknown>): Promise<EditResult> {
    const { executeEdit } = await import('../backend/edit');
    const operation = params.operation as TextEditOperation;
    const contextLines = (params.contextLines as number) ?? 10;
    const siloDirectories = (params.siloDirectories as string[]) ?? [];
    return executeEdit(operation, contextLines, siloDirectories);
  }

  /**
   * Return config defaults relevant to the MCP server.
   */
  private handleGetDefaults(): { contextLines: number } {
    const contextLines = this.ctx.config?.defaults.context_lines ?? 10;
    return { contextLines };
  }

  /**
   * Handle a status request. Mirrors the IPC `silos:list` handler.
   */
  private handleStatus(): { silos: SiloStatus[] } {
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
