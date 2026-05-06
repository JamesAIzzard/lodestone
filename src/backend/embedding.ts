/**
 * Embedding service abstraction layer.
 *
 * Provides a unified interface for generating vector embeddings from text,
 * using bundled Transformers.js / ONNX models through a shared worker thread.
 * The legacy 'built-in' alias is resolved via resolveModelAlias() for
 * backward compatibility.
 */

import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { WorkerResponse } from './embedding-worker-protocol';
import {
  getModelDefinition,
  resolveModelAlias,
} from './model-registry';

// ── Interface ────────────────────────────────────────────────────────────────

export interface EmbeddingService {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly modelName: string;
  /** Model's technical context window limit — used for max_length/truncation in ONNX */
  readonly maxTokens: number;
  /** Target chunk size for the pipeline chunkers — typically much smaller than maxTokens */
  readonly chunkTokens: number;
  /**
   * Ensure the service is ready for use (dimensions are known, model is loaded, etc.).
   * Callers should await this before reading `dimensions`.
   */
  ensureReady(): Promise<void>;
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

    // Don't let the worker thread prevent the process from exiting.
    // Graceful shutdown is handled by terminateSharedWorker(); this just
    // ensures the process can exit even if disposal is skipped.
    sharedWorker.unref();

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
  // dimensions/maxTokens/chunkTokens immediately (before worker warmup completes).
  private _dimensions: number;
  private _modelName: string;
  private _maxTokens: number;
  private _chunkTokens: number;

  get dimensions(): number { return this._dimensions; }
  get modelName(): string { return this._modelName; }
  get maxTokens(): number { return this._maxTokens; }
  get chunkTokens(): number { return this._chunkTokens; }

  constructor(
    private readonly modelId: string,
    private readonly cacheDir: string,
  ) {
    // Seed from registry for instant access
    const def = getModelDefinition(modelId);
    this._dimensions = def?.dimensions ?? 384;
    this._modelName = def ? `${modelId} (${def.displayName})` : modelId;
    this._maxTokens = def?.maxTokens ?? 512;
    this._chunkTokens = def?.chunkTokens ?? 512;
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
      chunkTokens: number;
    }>({
      type: 'init',
      cacheDir: this.cacheDir,
      modelId: this.modelId,
    });

    // Update with actual values from the worker (should match registry)
    this._dimensions = response.dimensions;
    this._modelName = response.modelName;
    this._maxTokens = response.maxTokens;
    this._chunkTokens = response.chunkTokens;
  }

  // ── EmbeddingService implementation ──────────────────────────────────────

  async ensureReady(): Promise<void> {
    await this.ensureInit();
  }

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

// ── Factory ──────────────────────────────────────────────────────────────────

export interface EmbeddingServiceOptions {
  /** Model identifier: a registry key (e.g. 'snowflake-arctic-embed-xs')
   *  or the legacy alias 'built-in'. */
  model: string;
  /** Cache directory for bundled model files */
  modelCacheDir: string;
}

/**
 * Create the bundled ONNX embedding service for the configured model.
 */
export function createEmbeddingService(options: EmbeddingServiceOptions): EmbeddingService {
  const modelId = resolveModelAlias(options.model);
  return new WorkerEmbeddingProxy(modelId, options.modelCacheDir);
}
