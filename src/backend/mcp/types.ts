/**
 * MCP Server types — dependency injection interface and handle.
 */

import type { Readable, Writable } from 'node:stream';
import type { SearchResult, DirectoryResult, SiloStatus, MemoryRecord, MemorySearchResult, RelatedMemoryResult } from '../../shared/types';
import type { EditOperation, EditResult } from '../edit';

export interface McpServerDeps {
  /** Custom input stream (e.g. a named-pipe socket). Falls back to process.stdin. */
  input?: Readable;
  /** Custom output stream (e.g. a named-pipe socket). Falls back to process.stdout. */
  output?: Writable;
  /** Proxy search through the GUI process. */
  search: (params: {
    query: string;
    silo?: string;
    maxResults?: number;
    startPath?: string;
    mode?: 'hybrid' | 'bm25' | 'semantic' | 'filepath' | 'regex';
    filePattern?: string;
    regexFlags?: string;
  }) => Promise<{ results: SearchResult[]; warnings: string[] }>;
  /** Proxy directory exploration through the GUI process. */
  explore: (params: {
    query?: string;
    silo?: string;
    startPath?: string;
    maxDepth?: number;
    maxResults?: number;
    fullContents?: boolean;
  }) => Promise<{ results: DirectoryResult[]; warnings: string[] }>;
  /** Proxy status through the GUI process. */
  status: () => Promise<{ silos: SiloStatus[] }>;
  /** Proxy edit operations through the GUI process. */
  edit: (params: {
    operation: EditOperation;
    contextLines: number;
    siloDirectories: string[];
  }) => Promise<EditResult>;
  /** Get config defaults (e.g. contextLines) from the GUI process. */
  getDefaults: () => Promise<{ contextLines: number }>;
  /** Write or update a memory entry. */
  memoryRemember: (params: {
    topic: string;
    body: string;
    confidence?: number;
    contextHint?: string;
    force?: boolean;
    actionDate?: string | null;
    recurrence?: string | null;
    priority?: number | null;
    status?: string | null;
    completedOn?: string | null;
  }) => Promise<
    | { status: 'created'; id: number }
    | { status: 'duplicate'; existing: MemoryRecord; similarity: number }
  >;
  /** Check if a memory database is currently connected. */
  isMemoryConnected?: () => boolean;
  /** Search memories using the decaying-sum signal pipeline. */
  memoryRecall: (params: {
    query: string;
    maxResults?: number;
    mode?: 'hybrid' | 'semantic' | 'bm25';
    updatedAfter?: string;
    updatedBefore?: string;
    actionAfter?: string;
    actionBefore?: string;
    completedAfter?: string;
    completedBefore?: string;
    status?: string | null;
  }) => Promise<MemorySearchResult[]>;
  /** Explicitly update a memory by id. */
  memoryRevise: (params: {
    id: number;
    body?: string;
    confidence?: number;
    contextHint?: string | null;
    actionDate?: string | null;
    recurrence?: string | null;
    priority?: number | null;
    topic?: string;
    status?: string | null;
    completedOn?: string | null;
  }) => Promise<{ completionRecordId?: number; nextActionDate?: string }>;
  /** Soft-delete a memory by id. */
  memoryForget: (params: { id: number; reason?: string }) => Promise<void>;
  /**
   * Advance a recurring memory to its next occurrence without completing it.
   * Records a skip note in the body if reason is provided.
   */
  memorySkip: (params: { id: number; reason?: string }) => Promise<{ nextActionDate: string }>;
  /** Return N most recently updated memories. */
  memoryOrient: (params: { maxResults?: number }) => Promise<MemoryRecord[]>;
  /** Return agenda items grouped by overdue and upcoming. */
  memoryAgenda: (params: {
    when: string;
    includeCompleted?: boolean;
    maxResults?: number;
  }) => Promise<{ overdue: MemoryRecord[]; upcoming: MemoryRecord[] }>;
  /** Fetch a single memory record by id (for lodestone_read of m-puids). */
  memoryGetById: (params: { id: number }) => Promise<MemoryRecord | null>;
  /** Find the top-N most similar active memories to a given memory id. */
  memoryFindRelated: (params: { id: number; topN?: number }) => Promise<RelatedMemoryResult[]>;
  /** Fire-and-forget notification to the GUI to trigger the shimmer on a card. */
  notifyActivity?: (params: { channel: 'silo' | 'memory'; siloName?: string }) => void;
}

/** Handle returned by startMcpServer for runtime control. */
export interface McpServerHandle {
  /** Shut down the MCP server. */
  stop: () => Promise<void>;
}
