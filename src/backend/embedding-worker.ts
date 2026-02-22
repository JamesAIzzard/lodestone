/**
 * Worker thread entry point for ONNX embedding inference.
 *
 * Runs in a separate thread via worker_threads to keep the main Electron
 * process event loop free for IPC and rendering during indexing.
 *
 * IMPORTANT: There is exactly ONE worker thread for ALL built-in models.
 * ONNX Runtime's native code has process-global state that crashes when
 * multiple worker threads load models concurrently. This single worker
 * hosts a Map of BuiltInEmbeddingService instances keyed by model ID.
 *
 * Messages are serialized through a queue so only one ONNX inference
 * call is in-flight at a time — the native runtime crashes if multiple
 * async sessions overlap (V8 HandleScope conflict).
 */

import { parentPort } from 'node:worker_threads';
import { BuiltInEmbeddingService } from './embedding-builtin';
import type { WorkerRequest } from './embedding-worker-protocol';

/** All loaded models, keyed by model ID */
const services = new Map<string, BuiltInEmbeddingService>();

// ── Message queue — serialize all ONNX calls ────────────────────────────────

const queue: WorkerRequest[] = [];
let processing = false;

parentPort!.on('message', (msg: WorkerRequest) => {
  queue.push(msg);
  if (!processing) processNext();
});

async function processNext(): Promise<void> {
  if (queue.length === 0) {
    processing = false;
    return;
  }

  processing = true;
  const msg = queue.shift()!;

  try {
    switch (msg.type) {
      case 'init': {
        let service = services.get(msg.modelId);
        if (!service) {
          service = new BuiltInEmbeddingService(msg.modelId, msg.cacheDir);
          // Force model load so latency is paid during init, not first real embed
          await service.embed('warmup');
          services.set(msg.modelId, service);
        }
        parentPort!.postMessage({
          id: msg.id,
          type: 'init-ok',
          dimensions: service.dimensions,
          modelName: service.modelName,
          maxTokens: service.maxTokens,
          chunkTokens: service.chunkTokens,
        });
        break;
      }
      case 'embed': {
        const service = services.get(msg.modelId);
        if (!service) throw new Error(`Model "${msg.modelId}" not initialized`);
        const vector = await service.embed(msg.text);
        parentPort!.postMessage({ id: msg.id, type: 'embed-ok', vector });
        break;
      }
      case 'embedBatch': {
        const service = services.get(msg.modelId);
        if (!service) throw new Error(`Model "${msg.modelId}" not initialized`);
        const vectors = await service.embedBatch(msg.texts);
        parentPort!.postMessage({ id: msg.id, type: 'embedBatch-ok', vectors });
        break;
      }
      case 'dispose': {
        if (msg.modelId) {
          // Dispose a specific model
          const service = services.get(msg.modelId);
          if (service) {
            await service.dispose();
            services.delete(msg.modelId);
          }
        } else {
          // Dispose all models
          for (const [id, service] of services) {
            await service.dispose();
            services.delete(id);
          }
        }
        parentPort!.postMessage({ id: msg.id, type: 'dispose-ok' });
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort!.postMessage({ id: msg.id, type: 'error', message });
  }

  // Yield to the event loop before processing the next message.
  // ONNX runtime schedules native cleanup callbacks via setImmediate;
  // calling processNext() synchronously would start the next inference
  // before those callbacks fire, crashing with a HandleScope violation.
  setImmediate(() => processNext());
}
