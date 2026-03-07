/**
 * Memory-related types — portable subset of src/shared/types.ts.
 *
 * Only includes types needed for the Worker's memory subsystem.
 * Silo, search, directory, and server types are omitted.
 */

// ── Memory ────────────────────────────────────────────────────────────────────

/** Lifecycle status values for memory/task entries. */
export type MemoryStatusValue = 'open' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';

/** Priority levels: 1=low, 2=medium, 3=high. */
export type PriorityLevel = 1 | 2 | 3;

export interface MemoryRecord {
  id: number;
  topic: string;
  body: string;
  confidence: number;
  contextHint: string | null;
  actionDate: string | null;
  dueDate: string | null;       // ISO 8601 date — hard deadline
  recurrence: string | null;
  priority: PriorityLevel | null;
  status: MemoryStatusValue | null;
  completedOn: string | null;   // ISO 8601 date — implies completed when set
  projectId: number | null;      // FK to projects table
  dayOrderPosition: number | null; // manual within-day sort position (from day_order table)
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;      // ISO 8601 datetime — set on soft delete, null for active
  deletionReason: string | null;  // optional explanation stored on soft delete
}

export interface ProjectRecord {
  id: number;
  name: string;
  color: string;        // SiloColor palette key (e.g. 'blue', 'red', 'emerald')
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  archivedAt: string | null;
}

export interface ProjectWithCounts extends ProjectRecord {
  openCount: number;
  completedCount: number;
  totalCount: number;
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
