/**
 * MCP Server types — dependency injection interface and handle.
 */

import type { Readable, Writable } from 'node:stream';
import type { SearchResult, DirectoryResult, SiloStatus } from '../../shared/types';
import type { EditOperation, EditResult } from '../edit';
import type { IMemoryService } from '../memory-service';

export interface McpServerDeps {
  /** Custom input stream (e.g. a named-pipe socket). Falls back to process.stdin. */
  input?: Readable;
  /** Custom output stream (e.g. a named-pipe socket). Falls back to process.stdout. */
  output?: Writable;
  /** Silo operations — search, explore, edit, status. */
  silo: {
    /** Full-text + semantic search across indexed files. */
    search: (params: {
      query: string;
      silo?: string;
      maxResults?: number;
      startPath?: string;
      mode?: 'hybrid' | 'bm25' | 'semantic' | 'filepath' | 'regex';
      filePattern?: string;
      regexFlags?: string;
    }) => Promise<{ results: SearchResult[]; warnings: string[] }>;
    /** Directory exploration / browsing. */
    explore: (params: {
      query?: string;
      silo?: string;
      startPath?: string;
      maxDepth?: number;
      maxResults?: number;
      fullContents?: boolean;
    }) => Promise<{ results: DirectoryResult[]; warnings: string[] }>;
    /** Silo status (file counts, watcher state, etc.). */
    status: () => Promise<{ silos: SiloStatus[] }>;
    /** File edit operations (str_replace, insert, overwrite, etc.). */
    edit: (params: {
      operation: EditOperation;
      contextLines: number;
      siloDirectories: string[];
    }) => Promise<EditResult>;
    /** Config defaults (e.g. contextLines). */
    getDefaults: () => Promise<{ contextLines: number }>;
  };
  /** Memory service — all memory operations (remember, recall, revise, etc.). */
  memory: IMemoryService;
  /** Fire-and-forget notification to the GUI to trigger the shimmer on a card. */
  notifyActivity?: (params: { channel: 'silo' | 'memory'; siloName?: string }) => void;
}

/** Handle returned by startMcpServer for runtime control. */
export interface McpServerHandle {
  /** Shut down the MCP server. */
  stop: () => Promise<void>;
}
