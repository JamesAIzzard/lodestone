/**
 * Embedding worker thread entry point.
 *
 * Loads and runs the single embedding model off the main thread, keeping the
 * main Electron process event loop free for IPC and rendering during indexing.
 *
 * IMPORTANT: messages are processed through a serialized queue so only ONE
 * ONNX inference call is in-flight at a time. ONNX Runtime's native code
 * schedules cleanup callbacks via setImmediate; starting the next inference
 * synchronously — before those callbacks fire — crashes with a V8 HandleScope
 * violation. The `setImmediate(processNext)` yield at the end of each message
 * is what guarantees that ordering. Do not replace this with per-message
 * concurrent handlers.
 */

import { parentPort } from 'node:worker_threads';
import { BuiltInEmbeddingService } from './embedding-builtin';
import type { WorkerRequest } from './embedding-worker-protocol';

if (!parentPort) {
  throw new Error('embedding-worker must be run as a worker thread');
}
const port = parentPort;

// The single embedding service, created on first 'init'.
let service: BuiltInEmbeddingService | null = null;

// ── Message queue — serialize all ONNX calls ────────────────────────────────

const queue: WorkerRequest[] = [];
let processing = false;

port.on('message', (msg: WorkerRequest) => {
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
        if (!service) {
          service = new BuiltInEmbeddingService(msg.modelDir);
          // Force model load now so latency is paid during init, not on the
          // first real embed.
          await service.embed('warmup');
        }
        port.postMessage({
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
        if (!service) throw new Error('Embedding model not initialized');
        const vector = await service.embed(msg.text);
        port.postMessage({ id: msg.id, type: 'embed-ok', vector });
        break;
      }
      case 'embedBatch': {
        if (!service) throw new Error('Embedding model not initialized');
        const vectors = await service.embedBatch(msg.texts);
        port.postMessage({ id: msg.id, type: 'embedBatch-ok', vectors });
        break;
      }
      case 'dispose': {
        if (service) {
          await service.dispose();
          service = null;
        }
        port.postMessage({ id: msg.id, type: 'dispose-ok' });
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    port.postMessage({ id: msg.id, type: 'error', message });
  }

  // Yield to the event loop before the next message. ONNX runtime schedules
  // native cleanup callbacks via setImmediate; calling processNext()
  // synchronously would start the next inference before those callbacks fire,
  // crashing with a HandleScope violation.
  setImmediate(() => processNext());
}
