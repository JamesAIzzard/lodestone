/**
 * Memory store — barrel re-exports.
 *
 * This index maintains backwards compatibility: all imports from
 * '../backend/memory-store' or './memory-store' continue to work
 * unchanged after the split into concern-based modules.
 */

// Re-export shared types for backwards compatibility with existing importers
export type { MemoryRecord, RelatedMemoryResult } from '../../shared/types';

// Helpers
export { float32Buffer, rowToRecord, getMemoryDatabaseSizeBytes, type MemoryDatabase } from './helpers';

// Schema, constants, database lifecycle
export { MEMORY_MODEL, MEMORY_DIMENSIONS, createMemoryDatabase, openMemoryDatabase, validateMemoryDatabase, readMemoryMeta } from './schema';

// Write operations
export { insertMemory, updateMemory, deleteMemory } from './write';

// Read operations
export {
  getMemory,
  getMemoryCount,
  getRecentMemories,
  getMemoriesByActionDateRange,
  filterMemoryIdsByDate,
  getOverdueMemories,
  getActiveUpcomingMemories,
  getRecentActiveMemories,
} from './read';

// Similarity / dedup
export { DEDUP_THRESHOLD, type SimilarMemoryResult, findSimilarMemory, findRelatedMemories } from './similarity';
