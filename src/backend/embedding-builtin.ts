/**
 * Built-in embedding service using Transformers.js / ONNX Runtime.
 *
 * This module is intentionally separate from embedding.ts so that the
 * @huggingface/transformers dependency is only loaded in the worker thread,
 * never in the main Electron process.
 */

import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';
import type { EmbeddingService } from './embedding';

const BUILTIN_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const BUILTIN_DIMENSIONS = 384;
const BUILTIN_MAX_TOKENS = 128; // produces poor results beyond this

export class BuiltInEmbeddingService implements EmbeddingService {
  private extractor: FeatureExtractionPipeline | null = null;

  readonly dimensions = BUILTIN_DIMENSIONS;
  readonly modelName = 'built-in (all-MiniLM-L6-v2)';
  readonly maxTokens = BUILTIN_MAX_TOKENS;

  /**
   * @param cacheDir Directory to store downloaded model files.
   *                 In Electron, use app.getPath('userData') + '/models'.
   */
  constructor(private readonly cacheDir: string) {}

  private async getExtractor(): Promise<FeatureExtractionPipeline> {
    if (!this.extractor) {
      env.cacheDir = this.cacheDir;
      env.allowLocalModels = true;
      env.allowRemoteModels = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.extractor = await (pipeline as any)('feature-extraction', BUILTIN_MODEL_ID, {
        dtype: 'q8',
      }) as FeatureExtractionPipeline;
    }
    return this.extractor;
  }

  async embed(text: string): Promise<number[]> {
    const extractor = await this.getExtractor();
    const result = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(result.data as Float32Array).slice(0, this.dimensions);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.getExtractor();
    const result = await extractor(texts, { pooling: 'mean', normalize: true });
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
