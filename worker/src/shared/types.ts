/**
 * Memory-related types — portable subset of src/shared/types.ts.
 *
 * Only includes types needed for the Worker's memory subsystem.
 * Silo, search, directory, and server types are omitted.
 */

// ── Memory ────────────────────────────────────────────────────────────────────

/** Lifecycle status values for memory/task entries. */
export type MemoryStatusValue = 'open' | 'completed' | 'cancelled';

/** Priority levels: 1=low, 2=medium, 3=high, 4=critical. */
export type PriorityLevel = 1 | 2 | 3 | 4;

export interface MemoryRecord {
  id: number;
  topic: string;
  body: string;
  confidence: number;
  contextHint: string | null;
  actionDate: string | null;
  recurrence: string | null;
  priority: PriorityLevel | null;
  status: MemoryStatusValue | null;
  completedOn: string | null;   // ISO 8601 date — implies completed when set
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;      // ISO 8601 datetime — set on soft delete, null for active
  deletionReason: string | null;  // optional explanation stored on soft delete
}

export interface MemorySearchResult extends MemoryRecord {
  score: number;
  scoreLabel: string;
  signals: Record<string, number>;
}

export interface RelatedMemoryResult {
  id: number;
  topic: string;
  /** Cosine similarity in [0, 1]. */
  similarity: number;
}

export interface MemoryStatus {
  connected: boolean;
  dbPath: string | null;
  memoryCount: number;
  databaseSizeBytes: number;
}
