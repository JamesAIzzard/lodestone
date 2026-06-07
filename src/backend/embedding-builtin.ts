/**
 * Built-in embedding service using Transformers.js / ONNX Runtime.
 *
 * This module is intentionally separate from embedding.ts so that the
 * @huggingface/transformers dependency is only loaded in the worker thread,
 * never in the main Electron process.
 *
 * Lodestone uses exactly one embedding model — there is no registry and no
 * model id parameter; all configuration comes from {@link EMBEDDING_MODEL}.
 * Weights are vendored under resources/models and loaded from a local
 * directory supplied by the main process.
 * Query and document prefixes are applied transparently:
 *   - embed()      → query prefix (used for search queries)
 *   - embedBatch() → document prefix (used for indexing chunks)
 */

import os from 'node:os';
import {
  pipeline,
  env,
  type FeatureExtractionPipeline,
  type FeatureExtractionPipelineOptions,
} from '@huggingface/transformers';
import type { EmbeddingService } from './embedding';
import { EMBEDDING_MODEL } from './embedding-model';

export class BuiltInEmbeddingService implements EmbeddingService {
  private extractor: FeatureExtractionPipeline | null = null;

  readonly dimensions = EMBEDDING_MODEL.dimensions;
  readonly modelName = EMBEDDING_MODEL.displayName;
  readonly maxTokens = EMBEDDING_MODEL.maxTokens;
  readonly chunkTokens = EMBEDDING_MODEL.chunkTokens;

  constructor(private readonly modelDir: string) {}

  private async getExtractor(): Promise<FeatureExtractionPipeline> {
    if (!this.extractor) {
      // The model is vendored locally and loaded by absolute path. Disable
      // remote models so a missing or corrupt bundled file fails fast and
      // offline, instead of silently attempting a (malformed) network fetch.
      env.allowRemoteModels = false;

      // Limit ONNX Runtime thread count to avoid saturating all CPU cores
      // during indexing. Cap at 2 (or half the cores, whichever is smaller).
      const cpuCount = os.cpus().length;
      const onnxThreads = Math.max(1, Math.min(2, Math.floor(cpuCount / 2)));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.extractor = await (pipeline as any)('feature-extraction', this.modelDir, {
        dtype: EMBEDDING_MODEL.dtype,
        session_options: {
          intraOpNumThreads: onnxThreads,
          interOpNumThreads: 1,
        },
      }) as FeatureExtractionPipeline;
    }
    return this.extractor;
  }

  /**
   * Embed a single text with the **query** prefix.
   * Used for search queries in silo-manager.ts.
   */
  async embed(text: string): Promise<number[]> {
    const extractor = await this.getExtractor();
    const prefixed = EMBEDDING_MODEL.queryPrefix + text;
    const result = await extractor(prefixed, {
      pooling: 'cls',
      normalize: true,
      truncation: true,
      max_length: this.maxTokens,
    } as FeatureExtractionPipelineOptions);
    // Extract data before disposal — result is a Tensor backed by WASM heap
    // memory that V8's GC does not manage. Explicit disposal is required to
    // prevent the WASM heap from growing unboundedly across many embed() calls.
    try {
      return Array.from((result.data as Float32Array).subarray(0, this.dimensions));
    } finally {
      result.dispose();
    }
  }

  /**
   * Embed a batch of texts with the **document** prefix.
   * Used for indexing file chunks in pipeline.ts.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.getExtractor();
    const prefixed = EMBEDDING_MODEL.documentPrefix
      ? texts.map((t) => EMBEDDING_MODEL.documentPrefix + t)
      : texts;
    const result = await extractor(prefixed, {
      pooling: 'cls',
      normalize: true,
      truncation: true,
      max_length: this.maxTokens,
    } as FeatureExtractionPipelineOptions);
    // Extract all vectors before disposal — see embed() comment above.
    try {
      const data = result.data as Float32Array;
      const vectors: number[][] = [];
      for (let i = 0; i < texts.length; i++) {
        const start = i * this.dimensions;
        vectors.push(Array.from(data.subarray(start, start + this.dimensions)));
      }
      return vectors;
    } finally {
      result.dispose();
    }
  }

  async ensureReady(): Promise<void> {
    // Dimensions are known from EMBEDDING_MODEL at construction time — nothing to probe.
  }

  async dispose(): Promise<void> {
    if (this.extractor) {
      await this.extractor.dispose();
      this.extractor = null;
    }
  }
}
