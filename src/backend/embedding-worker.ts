/**
 * Worker thread entry point for ONNX embedding inference.
 *
 * Runs in a separate thread via worker_threads to keep the main Electron
 * process event loop free for IPC and rendering during indexing.
 */

import { parentPort } from 'node:worker_threads';
import { BuiltInEmbeddingService } from './embedding-builtin';
import type { WorkerRequest } from './embedding-worker-protocol';

let service: BuiltInEmbeddingService | null = null;

parentPort!.on('message', async (msg: WorkerRequest) => {
  try {
    switch (msg.type) {
      case 'init': {
        service = new BuiltInEmbeddingService(msg.cacheDir);
        // Force model load so latency is paid during init, not first real embed
        await service.embed('warmup');
        parentPort!.postMessage({
          id: msg.id,
          type: 'init-ok',
          dimensions: service.dimensions,
          modelName: service.modelName,
          maxTokens: service.maxTokens,
        });
        break;
      }
      case 'embed': {
        if (!service) throw new Error('Worker not initialized');
        const vector = await service.embed(msg.text);
        parentPort!.postMessage({ id: msg.id, type: 'embed-ok', vector });
        break;
      }
      case 'embedBatch': {
        if (!service) throw new Error('Worker not initialized');
        const vectors = await service.embedBatch(msg.texts);
        parentPort!.postMessage({ id: msg.id, type: 'embedBatch-ok', vectors });
        break;
      }
      case 'dispose': {
        if (service) {
          await service.dispose();
          service = null;
        }
        parentPort!.postMessage({ id: msg.id, type: 'dispose-ok' });
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort!.postMessage({ id: msg.id, type: 'error', message });
  }
});
