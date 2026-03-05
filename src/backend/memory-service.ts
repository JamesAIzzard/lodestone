/**
 * IMemoryService — the contract for all memory operations.
 *
 * This interface decouples memory consumers (MCP tools, IPC handlers, GUI)
 * from the implementation (local SQLite via MemoryManager, or a future
 * Cloudflare Worker HTTP client). All methods are async to support both.
 *
 * Embedding is an internal concern — callers never pass an EmbeddingService.
 * The local implementation holds its own embedding provider; the Worker
 * implementation delegates embedding to Workers AI.
 */

import type {
  MemoryRecord,
  MemorySearchResult,
  MemoryStatus,
  MemoryStatusValue,
  PriorityLevel,
  RelatedMemoryResult,
} from '../shared/types';
import type { MemoryDateFilters } from './memory-search';
import type { DateRangeResult } from './date-parser';

// ── Param Types ──────────────────────────────────────────────────────────────

export interface RememberParams {
  topic: string;
  body: string;
  confidence?: number;
  contextHint?: string | null;
  force?: boolean;
  actionDate?: string | null;
  recurrence?: string | null;
  priority?: PriorityLevel | null;
  status?: MemoryStatusValue | null;
  completedOn?: string | null;
}

export type RememberResult =
  | { status: 'created'; id: number }
  | { status: 'duplicate'; existing: MemoryRecord; similarity: number };

export interface RecallParams {
  query: string;
  maxResults?: number;
  mode?: 'hybrid' | 'semantic' | 'bm25';
  dateFilters?: MemoryDateFilters;
}

export interface ReviseParams {
  id: number;
  body?: string;
  confidence?: number;
  contextHint?: string | null;
  actionDate?: string | null;
  recurrence?: string | null;
  priority?: PriorityLevel | null;
  topic?: string;
  status?: MemoryStatusValue | null;
  completedOn?: string | null;
}

export interface ReviseResult {
  completionRecordId?: number;
  nextActionDate?: string;
}

export interface SkipResult {
  nextActionDate: string;
}

export interface AgendaParams {
  when: DateRangeResult;
  includeCompleted?: boolean;
  maxResults?: number;
}

// ── Interface ────────────────────────────────────────────────────────────────

export interface IMemoryService {
  // ── Lifecycle ──────────────────────────────────────────────────────────────
  isConnected(): boolean;
  getStatus(): MemoryStatus;

  // ── Operations ─────────────────────────────────────────────────────────────
  remember(params: RememberParams): Promise<RememberResult>;
  recall(params: RecallParams): Promise<MemorySearchResult[]>;
  revise(params: ReviseParams): Promise<ReviseResult>;
  forget(id: number, reason?: string): Promise<void>;
  skip(id: number, reason?: string): Promise<SkipResult>;
  orient(maxResults?: number): Promise<MemoryRecord[]>;
  agenda(params: AgendaParams): Promise<AgendaResult>;
  getById(id: number): Promise<MemoryRecord | null>;
  findRelated(id: number, topN?: number): Promise<RelatedMemoryResult[]>;
}

// ── Shared Result Types ──────────────────────────────────────────────────────

export interface AgendaResult {
  /** Items whose action_date is before today and are not completed or cancelled. */
  overdue: MemoryRecord[];
  /** Items whose action_date falls within the requested time window. */
  upcoming: MemoryRecord[];
}
