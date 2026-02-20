/**
 * Step 2.1 — Standalone validation of Transformers.js embedding (runs in Node, not Electron).
 * Usage: node src/backend/test-embedding-standalone.mjs
 */

import { pipeline, env } from '@huggingface/transformers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const EXPECTED_DIMENSIONS = 384;

// Use a local cache dir instead of Electron's app.getPath('userData')
const cacheDir = path.join(__dirname, '..', '..', '.model-cache');
env.cacheDir = cacheDir;
env.allowLocalModels = true;
env.allowRemoteModels = true;

console.log(`[embedding] Cache directory: ${cacheDir}`);
console.log(`[embedding] Model: ${MODEL_ID}`);

// --- Load the pipeline ---
console.log('[embedding] Loading feature-extraction pipeline (first load downloads the model)...');
const startLoad = performance.now();

const extractor = await pipeline('feature-extraction', MODEL_ID, {
  dtype: 'q8',
});

const loadTime = ((performance.now() - startLoad) / 1000).toFixed(2);
console.log(`[embedding] Pipeline loaded in ${loadTime}s`);

// --- Single embedding ---
console.log('[embedding] Embedding a single test string...');
const startSingle = performance.now();

const singleResult = await extractor(
  'How does the optimiser handle constraint violations?',
  { pooling: 'mean', normalize: true },
);

const singleTime = ((performance.now() - startSingle) / 1000).toFixed(3);
const vector = Array.from(singleResult.data).slice(0, EXPECTED_DIMENSIONS);

console.log(`[embedding] Single embedding: ${singleTime}s`);
console.log(`[embedding] Vector dimensions: ${vector.length}`);
console.log(`[embedding] First 5 values: [${vector.slice(0, 5).map((v) => v.toFixed(6)).join(', ')}]`);
console.log(`[embedding] L2 norm: ${Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)).toFixed(6)}`);

if (vector.length !== EXPECTED_DIMENSIONS) {
  console.error(`[embedding] FAIL: Expected ${EXPECTED_DIMENSIONS} dimensions, got ${vector.length}`);
  process.exit(1);
}

// --- Batch embedding ---
console.log('[embedding] Embedding a batch of 10 strings...');
const testTexts = [
  'Vector embeddings for semantic search',
  'How to configure chokidar file watchers',
  'TypeScript interface for embedding service',
  'Orama vector database setup and schema',
  'Markdown heading-based chunking strategy',
  'Electron IPC bridge between main and renderer',
  'TOML configuration file parsing with smol-toml',
  'BM25 keyword matching for code retrieval',
  'Resumable indexing for large file collections',
  'System tray integration on Windows',
];

const startBatch = performance.now();
const batchResult = await extractor(testTexts, { pooling: 'mean', normalize: true });
const batchTime = ((performance.now() - startBatch) / 1000).toFixed(3);

const dims = batchResult.dims;
console.log(`[embedding] Batch embedding: ${batchTime}s (${testTexts.length} texts)`);
console.log(`[embedding] Output shape: [${dims.join(', ')}]`);
console.log(`[embedding] Throughput: ${(testTexts.length / parseFloat(batchTime)).toFixed(1)} embeddings/sec`);

if (dims[0] !== testTexts.length || dims[1] !== EXPECTED_DIMENSIONS) {
  console.error(`[embedding] FAIL: Expected [${testTexts.length}, ${EXPECTED_DIMENSIONS}], got [${dims.join(', ')}]`);
  process.exit(1);
}

// --- Cosine similarity sanity check ---
function extractRow(data, row, cols) {
  const start = row * cols;
  return Array.from(data.slice(start, start + cols));
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const vecA = extractRow(batchResult.data, 0, EXPECTED_DIMENSIONS); // vector embeddings
const vecB = extractRow(batchResult.data, 3, EXPECTED_DIMENSIONS); // orama vector db
const vecC = extractRow(batchResult.data, 9, EXPECTED_DIMENSIONS); // system tray

const simAB = cosineSimilarity(vecA, vecB);
const simAC = cosineSimilarity(vecA, vecC);
console.log(`[embedding] Similarity ("vector embeddings" <-> "orama vector db"): ${simAB.toFixed(4)}`);
console.log(`[embedding] Similarity ("vector embeddings" <-> "system tray"): ${simAC.toFixed(4)}`);
console.log(`[embedding] Sanity check: ${simAB > simAC ? 'PASS' : 'FAIL'} (AB > AC)`);

// --- Reload test (cache) ---
console.log('[embedding] Reloading pipeline to test cache...');
const startReload = performance.now();
const extractor2 = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' });
const reloadTime = ((performance.now() - startReload) / 1000).toFixed(2);
console.log(`[embedding] Cache reload: ${reloadTime}s`);

await extractor.dispose();
await extractor2.dispose();

console.log('[embedding] Validation complete');
