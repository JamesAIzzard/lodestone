# Embedding Model Simplification Plan

## Goal

Remove user-facing support for multiple embedding models and make Lodestone use one small, reliable local embedding model. The model ships **bundled inside the application**, so it is always present — there is no download flow, no network dependency at first run, and no setup dialog. Indexing and semantic search work immediately and offline.

The chosen model should not be meaningfully heavier to run than the current default, `Snowflake/snowflake-arctic-embed-xs`.

## Recommendation

Use `Snowflake/snowflake-arctic-embed-s` as the single Lodestone embedding model, **bundled with the app**.

Why this model:

- It keeps the same 384-dimensional vector size as the current `xs` model, so index storage and sqlite-vec query shape stay in the same class.
- It is only a modest runtime increase over `xs`: Snowflake reports 33M parameters for `s` versus 22M for `xs`.
- It improves retrieval quality without jumping to a base-size or 300M+ model: Snowflake reports MTEB retrieval NDCG@10 of 51.98 for `s` versus 50.15 for `xs`.
- It has first-party Transformers.js support on Hugging Face, matching the current inference stack.
- It keeps Lodestone on the existing Snowflake query prefix and CLS-pooling usage pattern.
- It is Apache-2.0, which permits redistribution — so bundling the weights in the installer is license-clean (keep the upstream LICENSE/NOTICE alongside the files).

Why bundle rather than download:

- The model is tiny relative to the app. The q8 ONNX artifact (`onnx/model_quantized.onnx`) is **34 MB** on Hugging Face; the current `xs` q8 artifact is 22 MB on disk locally. Plus tokenizer/config that is a few hundred KB. Against an Electron runtime already in the 150 MB+ range, +34 MB is noise.
- The model file is just weights — platform-agnostic. It does **not** multiply across win/mac/linux the way native binaries do; one file serves every target.
- Bundling eliminates the entire runtime-download surface: cache-presence checks, download progress wiring, the blocking setup dialog, cancel/retry/error states, and the startup gate. That was the riskiest and most code-heavy part of the original plan.
- It makes first run reliable and offline: no Hugging Face availability, rate-limit, corporate-proxy, or firewall dependency, and no half-downloaded/corrupt cache to detect.
- Model version is pinned to app version — updating the model is an app update, which is the correct coupling and removes cache/version drift.

Use these model constants:

```ts
export const EMBEDDING_MODEL = {
  key: 'snowflake-arctic-embed-s',
  displayName: 'Snowflake Arctic Embed S',
  hfModelId: 'Snowflake/snowflake-arctic-embed-s',
  dimensions: 384,
  maxTokens: 512,
  chunkTokens: 512,
  queryPrefix: 'Represent this sentence for searching relevant passages: ',
  documentPrefix: '',
  dtype: 'q8',
  pathSafeId: 'arctic-s',
};
```

Also change the current pooling from `mean` to `cls` for Snowflake embeddings. Snowflake's usage docs recommend CLS pooling for optimal retrieval quality, and their Transformers.js example uses `{ normalize: true, pooling: 'cls' }`. This must be applied to **both** `embed()` (query) and `embedBatch()` (document) so index-time and query-time vectors match.

## Models Considered

### Snowflake Arctic Embed XS

Current default. It is very small and already integrated. Keeping it would be the lowest-risk option, but it does not reduce the sense that Lodestone is pinned to an older model.

Relevant facts:

- 22M parameters
- 384 dimensions
- 512 token context
- Snowflake-reported retrieval score: 50.15
- Transformers.js support
- Apache-2.0

### Snowflake Arctic Embed S

Recommended. It is the best fit for "a bit better, still lightweight," and small enough to bundle without meaningfully growing the installer.

Relevant facts:

- 33M parameters
- 384 dimensions
- 512 token context
- Snowflake-reported retrieval score: 51.98
- q8 ONNX artifact: 34 MB
- Transformers.js support
- Apache-2.0 (redistribution permitted)

### Snowflake Arctic Embed M / M v1.5 / M v2.0

Good quality, but too large for this constraint. These move Lodestone from a tiny embedding model to a base-size model, and a base-size model is a heavier bundle.

Relevant facts:

- Around 110M-300M parameters depending on variant
- Typically 768 dimensions or larger
- Better retrieval quality, but higher memory, inference time, and index footprint

### Google EmbeddingGemma 300M

Not recommended for the default Lodestone model under the current constraint.

It is worth watching, but it is not a good default if the target is "not heavier than current Snowflake." It has roughly 300M parameters, which is an order of magnitude larger than `snowflake-arctic-embed-xs`. It outputs 768 dimensions by default. Its Matryoshka support can reduce stored vector dimensions to 512, 256, or 128, but that mainly helps index storage; it does not make the transformer itself as light as a 22M/33M model.

Other concerns:

- The official Hugging Face repo is gated behind Google's Gemma license acceptance, which complicates redistribution/bundling.
- Transformers.js use appears to depend on community ONNX exports rather than the same first-party model path Lodestone uses today.
- It may be attractive for multilingual use later, but Lodestone's default should optimize for reliable local setup and predictable CPU inference.

## Desired Product Behavior

Because the model is bundled, there is no download flow and no setup dialog. On GUI startup:

1. The embedding service initializes against the bundled model directly — no download/setup presence check, no network.
2. Silos start normally.
3. Semantic search and indexing are available immediately.

Still validate the bundled model at load time and surface a friendly error if the packaged files are missing, corrupt, or in the wrong layout. This is a packaging/runtime integrity check, not a user-facing download flow.

Old indexes built with a different embedding model (`snowflake-arctic-embed-xs`, `nomic-embed-text-v1.5`, or `all-MiniLM-L6-v2`) are invalidated: they report `modelMismatch`, semantic/hybrid search is blocked immediately, and the user rebuilds the silo against the bundled `s` model. This keeps the current mismatch behavior and avoids serving mixed-quality results from a stale index. It is independent of bundling — it is about index compatibility, not model availability.

## Implementation Plan

### Phase 1: Collapse the Model Surface

This phase is not independently shippable unless Phase 2 lands with it. Do not ship the new default model until the bundled local-only path is in place; otherwise the app could silently download `snowflake-arctic-embed-s` at runtime through the current cache path. Phase 1 and Phase 2 should be treated as a single release boundary so the user-visible change lands as one coherent behavior: one model, bundled, offline.

Backend:

- Replace `MODEL_REGISTRY` with a single canonical model definition in `src/backend/model-registry.ts`.
- Keep helper functions only where they still simplify call sites, or replace them with constants. In particular, resolve `getBundledModelIds()` and the `bundled` field — with a single bundled model, `getBundledModelIds()` either returns the one key or is removed along with its callers (notably `ServerStatus.availableModels`).
- Set `DEFAULT_MODEL` to `snowflake-arctic-embed-s`.
- Update `BuiltInEmbeddingService` to assume the canonical model unless a model ID is passed for compatibility.
- Change Snowflake pooling from `mean` to `cls` in `embed()` and `embedBatch()` (`src/backend/embedding-builtin.ts`, currently lines 93 and 119).
- Keep DB meta model checks. Any DB built with `snowflake-arctic-embed-xs`, `nomic-embed-text-v1.5`, or `all-MiniLM-L6-v2` should report `modelMismatch` and require rebuild. Reuse the existing mismatch/migration machinery (see the recent "legacy shim to reload old databases" work) rather than adding new logic.

Main process:

- Simplify `AppContext.embeddingServices` from `Map<string, EmbeddingService>` to a single optional embedding service.
- Simplify `getOrCreateEmbeddingService(model)` to `getOrCreateEmbeddingService()`.
- Remove model dispatch where possible in search paths. The query embedding service should always be the canonical service.
- Keep old model fields tolerated at IPC boundaries for one release if that makes migration safer.

Renderer:

- Remove the default embedding model selector from Settings.
- Remove the Model step from Add Silo.
- Remove the per-silo model dropdown from Silo Detail.
- Remove the model selector from Onboarding.
- Keep a read-only model label if useful, but do not present it as a choice.
- Keep model mismatch warnings, rewriting them around "this index was built with an older embedding model; rebuild required."

Types/config:

- Stop writing `default_model_key` and `embedding_model_key` for newly saved config where possible.
- Continue reading old config fields for backward compatibility.
- Update `ServerStatus` to remove `availableModels` and `modelPathSafeIds`, or mark them optional during transition.
- Update portable DB config handling so old stored model values are informational only.

Tests:

- Update config parsing tests for legacy model fields.
- Add/adjust tests that old model metadata triggers mismatch.
- Update embedding service tests to expect only the canonical model.
- Update IPC/type tests if present.

### Phase 2: Bundle the Model and Go Local-Only

Replace runtime download with a bundled model loaded from local disk.

Vendoring (committed to the repo):

- Vendor the model directory into the repo at `resources/models/Snowflake/snowflake-arctic-embed-s/`, in the Transformers.js local layout, **committed to git**:
  - `config.json`
  - tokenizer/metadata files proven necessary by an offline load test; at minimum expect `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`, and likely `vocab.txt`
  - `onnx/model_quantized.onnx`
  - upstream license material (`LICENSE`, and `NOTICE` if present)
  - a Lodestone provenance file, e.g. `LODESTONE_MODEL_PROVENANCE.md`, recording:
    - Hugging Face repo: `Snowflake/snowflake-arctic-embed-s`
    - exact commit SHA downloaded
    - file list and sizes
    - date fetched
    - license
- Prefer vendoring all non-weight metadata files from the model root, plus only the chosen q8 ONNX weight file. Avoid accidentally bundling `model.safetensors`, full-size ONNX files, or alternate quantizations.
- Provide a one-time helper script (e.g. `scripts/fetch-embedding-model.mjs`) to populate or regenerate this directory when first adding the model or bumping its version. The build does **not** fetch — the files are already in the repo. Committing the 34 MB binary is acceptable; if the model is swapped frequently later, Git LFS is an option, but it is not needed now.
- Add `resources/models` to `extraResource` in `forge.config.ts` (alongside the existing `mcp-wrapper.js`, `assets/icon.png`), so the directory is copied into the packaged app's resources.

Runtime (load from local disk, no remote):

- In `src/backend/embedding-builtin.ts` `getExtractor()`, replace the current remote configuration with local-only in **both dev and packaged** builds (no remote fallback in either):
  - `env.allowRemoteModels = false`
  - `env.allowLocalModels = true`
  - `env.localModelPath = <modelsRoot>`
  - where `<modelsRoot>` is resolved by the Electron main process and passed to the embedding worker.
- Resolve `modelsRoot` in the main process, not inside the worker:
  - packaged: `path.join(process.resourcesPath, 'models')`
  - dev: `path.join(app.getAppPath(), 'resources/models')`, or another repo-root-derived path verified under Electron Forge/Vite dev
  - pass the resolved path through `createEmbeddingService(...)`, `WorkerEmbeddingProxy`, and the worker `init` message.
- The existing `pipeline('feature-extraction', def.hfModelId, …)` call resolves `Snowflake/snowflake-arctic-embed-s` under `localModelPath/Snowflake/snowflake-arctic-embed-s` unchanged — so the inference call itself does not change.
- Thread the resolved `modelsRoot` (local model path) through the worker `init` message in place of the current `cacheDir`, since the worker constructs `BuiltInEmbeddingService` (`src/backend/embedding-worker.ts`). The worker already warms the model on init via `service.embed('warmup')`; with local-only loading this warmup reads from disk instead of the network.
- If warmup fails because the local model cannot be loaded, surface a clear error such as: "Bundled embedding model could not be loaded. Lodestone may be incorrectly packaged or installed." Include the attempted `modelsRoot` in logs, but keep user-facing text concise.

Cleanup of the (now removed) download surface:

- Do not add any model-status / download IPC, progress callbacks, setup dialog, or startup gate. None of the original Phase 2 download flow is needed.

Tests:

- Test that the embedding service loads from the bundled local path with `allowRemoteModels = false` (no network).
- Test that the vendored directory layout matches what Transformers.js expects (path resolution for `hfModelId`) and includes license/provenance files.
- Verify warmup succeeds offline in a packaged-layout fixture (or a temp dir mimicking `resources/models`).
- Verify that a missing/corrupt local model produces the friendly packaging error instead of attempting a remote download.

### Phase 3: Cleanup and Migration Polish

- Remove dead model parsing utilities such as `modelIdFromDisplay` and `toModelSlug` if no longer used.
- Remove old docs/comments that describe multiple bundled models or a runtime download/cache flow.
- Consider a one-time config cleanup that removes old `default_model_key` and per-silo `embedding_model_key` values after successful rebuilds.
- Remove the old `model-cache` runtime download directory handling if nothing else uses it (note: `getModelCacheDir()` in `src/main/context.ts` may become unused once loading is local-only).
- Update README/docs to say Lodestone uses one local embedding model, bundled with the app, no download required.

## Source Notes

- Snowflake Arctic Embed model card: https://huggingface.co/Snowflake/snowflake-arctic-embed-xs
- Snowflake Arctic Embed S model page: https://huggingface.co/Snowflake/snowflake-arctic-embed-s
- Snowflake Arctic Embed S ONNX files (q8 `model_quantized.onnx` = 34 MB): https://huggingface.co/Snowflake/snowflake-arctic-embed-s/tree/main/onnx
- Google EmbeddingGemma model card: https://huggingface.co/google/embeddinggemma-300m
- EmbeddingGemma docs: https://ai.google.dev/gemma/docs/embeddinggemma
- Transformers.js Node usage, local models, and cache behavior: https://huggingface.co/docs/transformers.js/tutorials/node
