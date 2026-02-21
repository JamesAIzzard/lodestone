/**
 * Message protocol for communication between the main thread
 * (WorkerEmbeddingProxy) and the embedding worker thread.
 *
 * The `modelId` field added to InitRequest allows the main process to
 * specify which built-in model the worker should load. This maps to a
 * key in MODEL_REGISTRY (e.g. 'snowflake-arctic-embed-xs').
 */

// ── Requests (main → worker) ────────────────────────────────────────────────

export interface InitRequest {
  id: number;
  type: 'init';
  cacheDir: string;
  /** Model identifier from the registry (e.g. 'snowflake-arctic-embed-xs') */
  modelId: string;
}

export interface EmbedRequest {
  id: number;
  type: 'embed';
  text: string;
  /** Route to the correct model when the worker hosts multiple models */
  modelId: string;
}

export interface EmbedBatchRequest {
  id: number;
  type: 'embedBatch';
  texts: string[];
  /** Route to the correct model when the worker hosts multiple models */
  modelId: string;
}

export interface DisposeRequest {
  id: number;
  type: 'dispose';
  /** If set, dispose only this model; otherwise dispose all */
  modelId?: string;
}

export type WorkerRequest = InitRequest | EmbedRequest | EmbedBatchRequest | DisposeRequest;

// ── Responses (worker → main) ───────────────────────────────────────────────

export interface InitOkResponse {
  id: number;
  type: 'init-ok';
  dimensions: number;
  modelName: string;
  maxTokens: number;
  chunkTokens: number;
}

export interface EmbedOkResponse {
  id: number;
  type: 'embed-ok';
  vector: number[];
}

export interface EmbedBatchOkResponse {
  id: number;
  type: 'embedBatch-ok';
  vectors: number[][];
}

export interface DisposeOkResponse {
  id: number;
  type: 'dispose-ok';
}

export interface ErrorResponse {
  id: number;
  type: 'error';
  message: string;
}

export type WorkerResponse =
  | InitOkResponse
  | EmbedOkResponse
  | EmbedBatchOkResponse
  | DisposeOkResponse
  | ErrorResponse;
