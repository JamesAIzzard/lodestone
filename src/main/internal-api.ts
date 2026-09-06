/**
 * Internal API — GUI-side named pipe server for MCP bridge communication.
 *
 * The GUI process creates a named pipe server that MCP bridge processes connect to.
 * All search and status queries from MCP go through this pipe, so the MCP
 * bridge process never opens databases or reads config directly.
 *
 * Protocol: newline-delimited JSON over \\.\pipe\lodestone-gui
 * - Requests  (MCP → GUI): { id, method, params? }
 * - Responses (GUI → MCP): { id, result?, error? }
 * - Push notifications (GUI → MCP): { method, params } (no id)
 */

import path from 'node:path';
import { app } from 'electron';
import { createServer, type Server, type Socket } from 'node:net';
import type { AppContext } from './context';
import {
  dispatchExplore,
  mergeDirectoryResults,
  dispatchSearch,
  mergeSearchResults,
  dispatchListing,
  mergeListing,
} from '../backend/search-merge';
import type {
  SearchResult,
  DirectoryResult,
  SiloStatus,
  ListingParams,
  SearchParams,
} from '../shared/types';
import type { EditOperation, EditResult } from '../backend/edit';
import { MailReadError } from '../backend/mail/account';
import { resolveMailMirrorFile } from './mail-attachment-route';
import { selectSilos, siloWarnings, toSiloNames } from './silo-selection';
import type {
  AttachmentContent,
  AttachmentFetchErrorCode,
  AttachmentFetchResponse,
} from '../backend/mail/attachment';

export type EmailAttachmentResponse = AttachmentFetchResponse;

/** Windows named pipe path. Dev builds use a distinct name to coexist with an installed build. */
export const GUI_PIPE_NAME = app.isPackaged
  ? '\\\\.\\pipe\\lodestone-gui'
  : '\\\\.\\pipe\\lodestone-gui-dev';

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
        case 'listByDate':
          result = await this.handleListByDate(req.params ?? {});
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
        case 'getLlmInstructionsConfig':
          result = this.handleGetLlmInstructionsConfig();
          break;
        case 'notify.activity':
          result = this.handleNotifyActivity(req.params ?? {});
          break;
        case 'email.readAttachment':
          result = await this.handleEmailReadAttachment(req.params ?? {});
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
    const msg =
      error !== undefined ? JSON.stringify({ id, error }) : JSON.stringify({ id, result });
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
    const siloNames = toSiloNames(params.silo);
    const maxResults = (params.maxResults as number) ?? 10;
    const mode = (params.mode as SearchParams['mode']) ?? 'hybrid';
    const startPath = params.startPath as string | undefined;
    const filePattern = params.filePattern as string | undefined;
    const dateFromMs = params.dateFromMs as number | undefined;
    const dateToMs = params.dateToMs as number | undefined;
    const regexFlags = params.regexFlags as string | undefined;

    if (!query) throw new Error('Missing required parameter: query');

    const searchParams: SearchParams = {
      query,
      mode,
      limit: maxResults,
      startPath,
      filePattern,
      dateFromMs,
      dateToMs,
      regexFlags,
    };

    // Notify renderer that a silo is being queried (triggers shimmer effect)
    this.ctx.mainWindow?.webContents.send('mcp:activity', {
      channel: 'silo',
      siloName: siloNames?.length === 1 ? siloNames[0] : undefined,
    });

    const ready = selectSilos(this.ctx.siloManagers, siloNames);
    const needsEmbedding = mode === 'hybrid' || mode === 'semantic';
    const warnings = await siloWarnings(ready, needsEmbedding);

    const searchable = needsEmbedding
      ? ready.filter(([, manager]) => manager.getEmbeddingService() !== null)
      : ready;

    if (searchable.length === 0) {
      return { results: [], warnings };
    }

    const raw = await dispatchSearch(searchParams, searchable, this.ctx.embeddingService);

    const merged = mergeSearchResults(raw, maxResults);

    const results: SearchResult[] = merged.map((r) => ({
      filePath: r.filePath,
      siloName: r.siloName,
      dateMs: r.dateMs,
      score: r.score,
      scoreLabel: r.scoreLabel,
      signals: r.signals,
      hint: r.hint,
      chunks: r.chunks,
    }));

    return { results, warnings };
  }

  private async handleListByDate(params: Record<string, unknown>): Promise<{
    results: SearchResult[];
    warnings: string[];
    total: number;
  }> {
    const siloNames = toSiloNames(params.silo);
    const limit = (params.limit as number) ?? 10;
    const offset = (params.offset as number) ?? 0;
    const listingParams: ListingParams = {
      startPath: params.startPath as string | undefined,
      filePattern: params.filePattern as string | undefined,
      dateFromMs: params.dateFromMs as number | undefined,
      dateToMs: params.dateToMs as number | undefined,
      limit,
      offset,
    };

    this.ctx.mainWindow?.webContents.send('mcp:activity', {
      channel: 'silo',
      siloName: siloNames?.length === 1 ? siloNames[0] : undefined,
    });

    const ready = selectSilos(this.ctx.siloManagers, siloNames);
    const warnings = await siloWarnings(ready, false);
    const { raw, total } = await dispatchListing(listingParams, ready);
    const results = mergeListing(raw, offset, limit);
    return { results, warnings, total };
  }

  /**
   * Handle an explore request. Mirrors the IPC `silos:explore` handler logic.
   */
  private async handleExplore(params: Record<string, unknown>): Promise<{
    results: DirectoryResult[];
    warnings: string[];
  }> {
    const query = params.query as string | undefined;
    const siloNames = toSiloNames(params.silo);
    const startPath = params.startPath as string | undefined;
    const maxDepth = (params.maxDepth as number) ?? 2;
    const maxResults = (params.maxResults as number) ?? 20;
    const fullContents = params.fullContents as boolean | undefined;

    // Notify renderer that a silo is being queried (triggers shimmer effect)
    this.ctx.mainWindow?.webContents.send('mcp:activity', {
      channel: 'silo',
      siloName: siloNames?.length === 1 ? siloNames[0] : undefined,
    });

    const ready = selectSilos(this.ctx.siloManagers, siloNames);
    const warnings = await siloWarnings(ready, false);

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
    const { canonicalisePolicyPath, executeEdit } = await import('../backend/edit');
    const operation = params.operation as EditOperation;
    const contextLines = (params.contextLines as number) ?? 10;
    const siloDirectories = (params.siloDirectories as string[]) ?? [];
    const readOnlyRoots = [...this.ctx.siloManagers.values()]
      .filter((manager) => manager.getConfig().readOnly)
      .flatMap((manager) => manager.getConfig().indexedDirectories)
      .map(canonicalisePolicyPath);
    const result = await executeEdit(operation, contextLines, siloDirectories, { readOnlyRoots });

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
      const dirs = manager.getConfig().indexedDirectories;
      const isOwned = dirs.some((d) => resolved.startsWith(path.resolve(d) + path.sep));
      if (isOwned) {
        manager.reindexFile(filePath).catch((err) => {
          console.error(`[internal-api] reindex failed for ${filePath}:`, err);
        });
        return;
      }
    }
  }

  /** Notify the renderer about MCP activity. */
  private handleNotifyActivity(params: Record<string, unknown>): Record<string, never> {
    const channel = params.channel as 'silo';
    const siloName = params.siloName as string | undefined;
    this.ctx.mainWindow?.webContents.send('mcp:activity', { channel, siloName });
    return {};
  }

  private async handleEmailReadAttachment(
    params: Record<string, unknown>,
  ): Promise<EmailAttachmentResponse> {
    const filePath = typeof params.filepath === 'string' ? params.filepath : '';
    const attachment = params.attachment as number;
    const resolved = resolveMailMirrorFile(this.ctx, filePath);
    if ('code' in resolved) return { kind: 'error', ...resolved };

    this.ctx.mainWindow?.webContents.send('mcp:activity', {
      channel: 'silo',
      siloName: resolved.siloName,
    });
    try {
      return attachmentResponse(
        await resolved.account.readAttachment(resolved.fileName, attachment),
      );
    } catch (error) {
      const code = error instanceof MailReadError ? error.reason : 'protocol';
      return { kind: 'error', code, message: mailReadErrorMessage(code) };
    }
  }

  private handleGetDefaults(): { contextLines: number } {
    const contextLines = this.ctx.config?.defaults.edit_context_lines ?? 10;
    return { contextLines };
  }

  private handleGetLlmInstructionsConfig(): { notePath?: string } {
    return { notePath: this.ctx.config?.llm_instructions_note_path };
  }

  /**
   * Handle a status request. Mirrors the IPC `silos:list` handler.
   */
  private async handleStatus(): Promise<{ silos: SiloStatus[] }> {
    this.ctx.mainWindow?.webContents.send('mcp:activity', { channel: 'silo' });
    const statuses: SiloStatus[] = [];
    for (const manager of this.ctx.siloManagers.values()) {
      const status = await manager.getStatus();
      const cfg = manager.getConfig();
      const siloToml = this.ctx.config?.silos[cfg.name];
      statuses.push({
        config: {
          name: cfg.name,
          indexedDirectories: cfg.indexedDirectories,
          indexedFileExtensions: cfg.indexedFileExtensions,
          ignoredFolderPatterns: cfg.ignoredFolderPatterns,
          ignoredFilePatterns: cfg.ignoredFilePatterns,
          hasIgnoredFolderPatternsOverride: siloToml?.ignored_folder_patterns !== undefined,
          hasIgnoredFilePatternsOverride: siloToml?.ignored_file_patterns !== undefined,
          hasIndexedFileExtensionsOverride: siloToml?.indexed_file_extensions !== undefined,
          indexDbPath: cfg.indexDbPath,
          contentDescription: cfg.contentDescription,
          accentColor: cfg.accentColor,
          iconName: cfg.iconName,
          readOnly: cfg.readOnly,
          managedBy: cfg.managedBy,
          supportsPathSearch: cfg.supportsPathSearch,
        },
        available: status.available,
        indexCaughtUp: status.indexCaughtUp,
        indexedFileCount: status.indexedFileCount,
        chunkCount: status.chunkCount,
        lastUpdated: status.lastUpdated?.toISOString() ?? null,
        databaseSizeBytes: status.databaseSizeBytes,
        watcherState: status.watcherState,
        errorMessage: status.errorMessage,
        reconcileProgress: status.reconcileProgress,
        resolvedDbPath: status.resolvedDbPath,
      });
    }
    return { silos: statuses };
  }
}

function attachmentResponse(content: AttachmentContent): EmailAttachmentResponse {
  return {
    kind: 'attachment',
    dataBase64: Buffer.from(content.bytes).toString('base64'),
    mime: content.mime,
    name: content.name,
    charset: content.charset,
    size: content.bytes.byteLength,
  };
}

function mailReadErrorMessage(code: AttachmentFetchErrorCode): string {
  const messages: Record<string, string> = {
    'not-email': 'The reference is not a mirrored email.',
    unavailable: 'This mail source is temporarily unavailable.',
    'not-found': 'The email or attachment is no longer available. Search again and retry.',
    stale: 'The mirrored attachment metadata is stale. Synchronise or search again and retry.',
    'too-large': "The attachment exceeds Lodestone's read limit.",
    encrypted: 'The attachment is encrypted and cannot be read.',
    unsupported: 'This attachment type or content is not supported.',
    auth: 'The mail account requires reauthorisation.',
    transient: 'The mail server is temporarily unavailable. Try again later.',
    protocol: 'The mail server could not complete the attachment read.',
  };
  return messages[code] ?? messages.protocol;
}
