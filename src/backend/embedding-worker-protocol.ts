/**
 * Message protocol for communication between the main thread
 * (WorkerEmbeddingProxy) and the embedding worker thread.
 */

// ── Requests (main → worker) ────────────────────────────────────────────────

export interface InitRequest {
  id: number;
  type: 'init';
  cacheDir: string;
}

export interface EmbedRequest {
  id: number;
  type: 'embed';
  text: string;
}

export interface EmbedBatchRequest {
  id: number;
  type: 'embedBatch';
  texts: string[];
}

export interface DisposeRequest {
  id: number;
  type: 'dispose';
}

export type WorkerRequest = InitRequest | EmbedRequest | EmbedBatchRequest | DisposeRequest;

// ── Responses (worker → main) ───────────────────────────────────────────────

export interface InitOkResponse {
  id: number;
  type: 'init-ok';
  dimensions: number;
  modelName: string;
  maxTokens: number;
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
