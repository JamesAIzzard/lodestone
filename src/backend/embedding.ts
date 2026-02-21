/**
 * Embedding service abstraction layer.
 *
 * Provides a unified interface for generating vector embeddings from text,
 * with two backends: built-in (Transformers.js / ONNX via worker thread)
 * and Ollama REST API.
 */

import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { WorkerResponse } from './embedding-worker-protocol';

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

// ── Built-in (Worker Thread Proxy) ──────────────────────────────────────────

/**
 * Proxy that delegates ONNX embedding inference to a worker thread.
 *
 * Implements the same `EmbeddingService` interface so all callers
 * (pipeline, reconcile, watcher) are completely unaware of the threading.
 * The worker is spawned lazily on the first embed call, matching the
 * previous lazy-load pattern of BuiltInEmbeddingService.
 */
export class WorkerEmbeddingProxy implements EmbeddingService {
  private worker: Worker | null = null;
  private initPromise: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void }>();

  // Static defaults match the built-in model (all-MiniLM-L6-v2).
  // Available immediately so callers can read dimensions before the
  // first embed() call triggers lazy worker initialization.
  private _dimensions = 384;
  private _modelName = 'built-in (all-MiniLM-L6-v2)';
  private _maxTokens = 128;

  get dimensions(): number { return this._dimensions; }
  get modelName(): string { return this._modelName; }
  get maxTokens(): number { return this._maxTokens; }

  constructor(private readonly cacheDir: string) {}

  // ── Lifecycle ────────────────────────────────────────────────────────────

  private ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.spawnAndInit().catch((err) => {
        // Reset so the next call retries instead of caching a rejected promise
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  private async spawnAndInit(): Promise<void> {
    const workerPath = path.join(__dirname, 'embedding-worker.js');
    this.worker = new Worker(workerPath);

    this.worker.on('message', (msg: WorkerResponse) => {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);

      if (msg.type === 'error') {
        entry.reject(new Error(msg.message));
      } else {
        entry.resolve(msg);
      }
    });

    this.worker.on('error', (err) => {
      this.rejectAll(err);
    });

    this.worker.on('exit', (code) => {
      if (code !== 0 && this.pending.size > 0) {
        this.rejectAll(new Error(`Embedding worker exited with code ${code}`));
      }
    });

    // Send init and wait for model to load + warmup
    const response = await this.post<{ dimensions: number; modelName: string; maxTokens: number }>({
      type: 'init',
      cacheDir: this.cacheDir,
    });

    this._dimensions = response.dimensions;
    this._modelName = response.modelName;
    this._maxTokens = response.maxTokens;
  }

  // ── EmbeddingService implementation ──────────────────────────────────────

  async embed(text: string): Promise<number[]> {
    await this.ensureInit();
    const response = await this.post<{ vector: number[] }>({ type: 'embed', text });
    return response.vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    await this.ensureInit();
    const response = await this.post<{ vectors: number[][] }>({ type: 'embedBatch', texts });
    return response.vectors;
  }

  async dispose(): Promise<void> {
    if (!this.worker) return;
    try {
      await this.post({ type: 'dispose' });
    } catch {
      // Worker may already be gone
    }
    await this.worker.terminate();
    this.worker = null;
    this.initPromise = null;
  }

  // ── Internal messaging ───────────────────────────────────────────────────

  private post<T>(msg: Record<string, unknown>): Promise<T> {
    if (!this.worker) {
      return Promise.reject(new Error('Embedding worker is not running'));
    }
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ ...msg, id });
    });
  }

  private rejectAll(err: Error): void {
    for (const entry of this.pending.values()) {
      entry.reject(err);
    }
    this.pending.clear();
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
    return new WorkerEmbeddingProxy(options.modelCacheDir);
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
