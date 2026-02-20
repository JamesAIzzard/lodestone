/**
 * Embedding service abstraction layer.
 *
 * Provides a unified interface for generating vector embeddings from text,
 * with two backends: built-in (Transformers.js / ONNX) and Ollama REST API.
 */

import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';
import path from 'node:path';

// ── Interface ────────────────────────────────────────────────────────────────

export interface EmbeddingService {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly modelName: string;
  /** Maximum tokens the model handles well (for chunking decisions) */
  readonly maxTokens: number;
  dispose(): Promise<void>;
}

// ── Built-in (Transformers.js) ───────────────────────────────────────────────

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

// ── Ollama ───────────────────────────────────────────────────────────────────

export class OllamaEmbeddingService implements EmbeddingService {
  private _dimensions: number | null = null;

  readonly maxTokens = 8192; // nomic-embed-text supports up to 8192

  constructor(
    private readonly baseUrl: string,
    readonly modelName: string,
  ) {}

  get dimensions(): number {
    if (this._dimensions === null) {
      throw new Error('Ollama dimensions unknown — call embed() at least once first');
    }
    return this._dimensions;
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.callOllama([text]);
    return result[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return this.callOllama(texts);
  }

  private async callOllama(input: string[]): Promise<number[][]> {
    const url = `${this.baseUrl}/api/embed`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.modelName, input }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Ollama embed failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as { embeddings: number[][] };
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== input.length) {
      throw new Error(`Ollama returned unexpected shape: expected ${input.length} embeddings`);
    }

    // Learn dimensions from the first response
    if (this._dimensions === null && data.embeddings.length > 0) {
      this._dimensions = data.embeddings[0].length;
    }

    return data.embeddings;
  }

  async dispose(): Promise<void> {
    // Nothing to clean up for the REST client
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export interface EmbeddingServiceOptions {
  /** Model identifier: 'built-in' for the bundled model, or an Ollama model name */
  model: string;
  /** Ollama base URL (only used when model is not 'built-in') */
  ollamaUrl: string;
  /** Cache directory for built-in model files */
  modelCacheDir: string;
}

/**
 * Create the appropriate embedding service based on configuration.
 */
export function createEmbeddingService(options: EmbeddingServiceOptions): EmbeddingService {
  if (options.model === 'built-in') {
    return new BuiltInEmbeddingService(options.modelCacheDir);
  }
  return new OllamaEmbeddingService(options.ollamaUrl, options.model);
}

// ── Ollama Utilities ─────────────────────────────────────────────────────────

/**
 * Check if Ollama is reachable and return the list of available models.
 * Returns null if Ollama is not reachable.
 */
export async function checkOllamaConnection(
  baseUrl: string,
): Promise<{ models: string[] } | null> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { models: Array<{ name: string }> };
    const models = data.models.map((m) => m.name);
    return { models };
  } catch {
    return null;
  }
}
