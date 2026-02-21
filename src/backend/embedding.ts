/**
 * Embedding service abstraction layer.
 *
 * Provides a unified interface for generating vector embeddings from text,
 * with two backends: built-in (Transformers.js / ONNX via worker thread)
 * and Ollama REST API.
 *
 * Phase 3: The factory now uses the model registry to determine whether a
 * model ID refers to a bundled model or an Ollama-hosted model. The legacy
 * 'built-in' alias is resolved via resolveModelAlias() for backward compat.
 */

import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { WorkerResponse } from './embedding-worker-protocol';
import {
  getModelDefinition,
  isBuiltInModel,
  resolveModelAlias,
  DEFAULT_MODEL,
} from './model-registry';

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

// ── Shared ONNX Worker ──────────────────────────────────────────────────────
//
// ONNX Runtime's native code has process-global state that crashes when
// multiple worker threads load models simultaneously. ALL built-in models
// share a single worker thread to avoid this. The worker holds a Map of
// BuiltInEmbeddingService instances keyed by model ID and serializes all
// ONNX calls through a queue.

let sharedWorker: Worker | null = null;
let sharedNextId = 1;
const sharedPending = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void }>();
const activeProxies = new Set<WorkerEmbeddingProxy>();

function ensureSharedWorker(): Worker {
  if (!sharedWorker) {
    const workerPath = path.join(__dirname, 'embedding-worker.js');
    sharedWorker = new Worker(workerPath);

    sharedWorker.on('message', (msg: WorkerResponse) => {
      const entry = sharedPending.get(msg.id);
      if (!entry) return;
      sharedPending.delete(msg.id);
      if (msg.type === 'error') {
        entry.reject(new Error(msg.message));
      } else {
        entry.resolve(msg);
      }
    });

    sharedWorker.on('error', (err) => {
      for (const entry of sharedPending.values()) entry.reject(err);
      sharedPending.clear();
    });

    sharedWorker.on('exit', (code) => {
      if (code !== 0 && sharedPending.size > 0) {
        const exitErr = new Error(`Embedding worker exited with code ${code}`);
        for (const entry of sharedPending.values()) entry.reject(exitErr);
        sharedPending.clear();
      }
      sharedWorker = null;
      // Reset init state so proxies re-init on next use (auto-respawn)
      for (const proxy of activeProxies) {
        proxy._resetInit();
      }
    });
  }
  return sharedWorker;
}

function postToSharedWorker<T>(msg: Record<string, unknown>): Promise<T> {
  const worker = ensureSharedWorker();
  return new Promise<T>((resolve, reject) => {
    const id = sharedNextId++;
    sharedPending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id });
  });
}

async function terminateSharedWorker(): Promise<void> {
  if (!sharedWorker) return;
  const worker = sharedWorker;
  sharedWorker = null;
  await worker.terminate();
}

// ── Built-in (Worker Thread Proxy) ──────────────────────────────────────────

/**
 * Proxy that delegates ONNX embedding inference to the shared worker thread.
 *
 * All built-in model proxies share a single worker. Each proxy sends an
 * 'init' message for its model on first use, and all embed/embedBatch
 * calls include the modelId so the worker routes to the correct model.
 *
 * The worker is terminated only when the last proxy is disposed.
 */
export class WorkerEmbeddingProxy implements EmbeddingService {
  private initPromise: Promise<void> | null = null;

  // Pre-populated from the model registry so callers can read
  // dimensions/maxTokens immediately (before worker warmup completes).
  private _dimensions: number;
  private _modelName: string;
  private _maxTokens: number;

  get dimensions(): number { return this._dimensions; }
  get modelName(): string { return this._modelName; }
  get maxTokens(): number { return this._maxTokens; }

  constructor(
    private readonly modelId: string,
    private readonly cacheDir: string,
  ) {
    // Seed from registry for instant access
    const def = getModelDefinition(modelId);
    this._dimensions = def?.dimensions ?? 384;
    this._modelName = def ? `${modelId} (${def.displayName})` : modelId;
    this._maxTokens = def?.maxTokens ?? 512;
    activeProxies.add(this);
  }

  /** @internal Called by shared worker on exit to reset init state for auto-respawn. */
  _resetInit(): void {
    this.initPromise = null;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  private ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit().catch((err) => {
        // Reset so the next call retries instead of caching a rejected promise
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const response = await postToSharedWorker<{
      dimensions: number;
      modelName: string;
      maxTokens: number;
    }>({
      type: 'init',
      cacheDir: this.cacheDir,
      modelId: this.modelId,
    });

    // Update with actual values from the worker (should match registry)
    this._dimensions = response.dimensions;
    this._modelName = response.modelName;
    this._maxTokens = response.maxTokens;
  }

  // ── EmbeddingService implementation ──────────────────────────────────────

  async embed(text: string): Promise<number[]> {
    await this.ensureInit();
    const response = await postToSharedWorker<{ vector: number[] }>({
      type: 'embed',
      text,
      modelId: this.modelId,
    });
    return response.vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    await this.ensureInit();
    const response = await postToSharedWorker<{ vectors: number[][] }>({
      type: 'embedBatch',
      texts,
      modelId: this.modelId,
    });
    return response.vectors;
  }

  async dispose(): Promise<void> {
    activeProxies.delete(this);
    try {
      await postToSharedWorker({ type: 'dispose', modelId: this.modelId });
    } catch {
      // Worker may already be gone
    }
    this.initPromise = null;

    // Terminate the worker when no proxies remain
    if (activeProxies.size === 0) {
      await terminateSharedWorker();
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
  /** Model identifier: a registry key (e.g. 'snowflake-arctic-embed-xs')
   *  or an Ollama model name. The legacy alias 'built-in' is also accepted. */
  model: string;
  /** Ollama base URL (only used when model is not a built-in) */
  ollamaUrl: string;
  /** Cache directory for built-in model files */
  modelCacheDir: string;
}

/**
 * Create the appropriate embedding service based on configuration.
 *
 * Uses the model registry to determine if the model is bundled (ONNX)
 * or external (Ollama). The legacy 'built-in' alias resolves to the
 * default model for backward compatibility with Phase 2 configs.
 */
export function createEmbeddingService(options: EmbeddingServiceOptions): EmbeddingService {
  // Resolve 'built-in' → actual default model key
  const modelId = resolveModelAlias(options.model);

  if (isBuiltInModel(modelId)) {
    return new WorkerEmbeddingProxy(modelId, options.modelCacheDir);
  }
  return new OllamaEmbeddingService(options.ollamaUrl, modelId);
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
