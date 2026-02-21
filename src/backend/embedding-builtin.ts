/**
 * Built-in embedding service using Transformers.js / ONNX Runtime.
 *
 * This module is intentionally separate from embedding.ts so that the
 * @huggingface/transformers dependency is only loaded in the worker thread,
 * never in the main Electron process.
 *
 * Phase 3: Now uses the model registry for configuration instead of
 * hardcoded constants. Query and document prefixes are applied
 * transparently based on the model definition:
 *   - embed()      → query prefix (used for search queries)
 *   - embedBatch() → document prefix (used for indexing chunks)
 */

import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';
import type { EmbeddingService } from './embedding';
import {
  getModelDefinition,
  DEFAULT_MODEL,
  type ModelDefinition,
} from './model-registry';

export class BuiltInEmbeddingService implements EmbeddingService {
  private extractor: FeatureExtractionPipeline | null = null;
  private readonly def: ModelDefinition;

  readonly dimensions: number;
  readonly modelName: string;
  readonly maxTokens: number;

  /**
   * @param modelId  Registry key (e.g. 'snowflake-arctic-embed-xs').
   *                 Falls back to DEFAULT_MODEL if the ID is not in the registry.
   * @param cacheDir Directory to store downloaded model files.
   *                 In Electron, use app.getPath('userData') + '/models'.
   */
  constructor(
    private readonly modelId: string,
    private readonly cacheDir: string,
  ) {
    const def = getModelDefinition(modelId) ?? getModelDefinition(DEFAULT_MODEL)!;
    this.def = def;
    this.dimensions = def.dimensions;
    this.modelName = `${modelId} (${def.displayName})`;
    this.maxTokens = def.maxTokens;
  }

  private async getExtractor(): Promise<FeatureExtractionPipeline> {
    if (!this.extractor) {
      env.cacheDir = this.cacheDir;
      env.allowLocalModels = true;
      env.allowRemoteModels = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.extractor = await (pipeline as any)('feature-extraction', this.def.hfModelId, {
        dtype: this.def.dtype,
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
    const prefixed = this.def.queryPrefix + text;
    const result = await extractor(prefixed, { pooling: 'mean', normalize: true });
    return Array.from(result.data as Float32Array).slice(0, this.dimensions);
  }

  /**
   * Embed a batch of texts with the **document** prefix.
   * Used for indexing file chunks in pipeline.ts.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.getExtractor();
    const prefixed = this.def.documentPrefix
      ? texts.map((t) => this.def.documentPrefix + t)
      : texts;
    const result = await extractor(prefixed, { pooling: 'mean', normalize: true });
    const data = result.data as Float32Array;
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i++) {
      const start = i * this.dimensions;
      vectors.push(Array.from(data.slice(start, start + this.dimensions)));
    }
    return vectors;
  }

  async dispose(): Promise<void> {
    if (this.extractor) {
      await this.extractor.dispose();
      this.extractor = null;
    }
  }
}
