/**
 * Deterministic `EmbeddingService` stub for tests.
 *
 * Returns the same constant unit vector for every input. Vectors satisfy
 * `vec.length === dimensions` and are L2-normalised so the SQL-side
 * cosine math stays well-defined. Search-quality assertions are not the
 * point of these tests; behaviour-preservation is.
 *
 * If a test wants to exercise an embedding-failure path (like the
 * existing `silo-manager.test.ts:27`), build a one-off failing service
 * inline rather than reaching for this stub.
 */

import type { EmbeddingService } from '../embedding';

export interface StubEmbeddingOptions {
  dimensions?: number;
  modelName?: string;
  maxTokens?: number;
  chunkTokens?: number;
}

export function createStubEmbedding(opts: StubEmbeddingOptions = {}): EmbeddingService {
  const dimensions = opts.dimensions ?? 4;
  const norm = 1 / Math.sqrt(dimensions);
  const unit = Array.from({ length: dimensions }, () => norm);

  return {
    dimensions,
    modelName: opts.modelName ?? 'stub',
    maxTokens: opts.maxTokens ?? 512,
    chunkTokens: opts.chunkTokens ?? 512,
    embed: async () => unit.slice(),
    embedBatch: async (texts) => texts.map(() => unit.slice()),
    ensureReady: async () => undefined,
    dispose: async () => undefined,
  };
}
