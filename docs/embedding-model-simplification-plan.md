# Embedding Model Simplification Plan

## Goal

Make Lodestone use exactly one bundled local embedding model.

There is no user-facing model choice, no runtime model download, no model cache, no setup dialog, and no compatibility layer for old embedding model configuration. Indexes built with any previous model cannot be confirmed against the current model, so they are not trusted and are rebuilt automatically on next launch.

A second goal rides along with the first: **remove every legacy shim.** We want a single, clean implementation. We accept that the user must rebuild any old index — but the rebuild is automatic and invisible, so the cost falls on the machine, not the user.

## Recommendation

Use `Snowflake/snowflake-arctic-embed-s` as the single Lodestone embedding model.

Why this model:

- It keeps the same 384-dimensional vector size as the current `snowflake-arctic-embed-xs`, so sqlite-vec table shape and index storage stay in the same class.
- It is only modestly larger than the current default: Snowflake reports 33M parameters for `s` versus 22M for `xs`.
- It improves retrieval quality without moving to a base-size model: Snowflake reports MTEB retrieval NDCG@10 of 51.98 for `s` versus 50.15 for `xs`.
- It is supported by Transformers.js on Hugging Face, matching the current inference stack.
- It keeps Lodestone on the Snowflake query prefix pattern.
- It is Apache-2.0, so redistribution is permitted. Keep upstream license material with the vendored files.

Why bundle:

- The q8 ONNX artifact is small enough for the app bundle: `onnx/model_quantized.onnx` is about 34 MB.
- The model weights are platform-agnostic. They do not multiply across Windows, macOS, and Linux targets.
- Bundling removes runtime download code and first-run network dependency.
- Model version becomes part of the app version. Updating the model is an app update.

### A note on the 384-dimension choice

Keeping 384 dimensions means the sqlite-vec table shape does not change — no vector-storage churn. But it also means a stale `arctic-xs` index is **structurally compatible** with `arctic-s` query vectors: searching an un-rebuilt index will not error, it will silently return degraded results. Therefore index validity must be enforced by **explicit identity comparison** (model key + dimensions + schema version), never by relying on a dimension mismatch to surface the problem. The `peekIndexState` gate below is the mechanism.

## Canonical Model Constant

Replace the multi-model registry with one exported constant:

```ts
export const EMBEDDING_MODEL = {
  key: 'snowflake-arctic-embed-s',
  displayName: 'Snowflake Arctic Embed S',
  dimensions: 384,
  maxTokens: 512,
  chunkTokens: 512,
  queryPrefix: 'Represent this sentence for searching relevant passages: ',
  documentPrefix: '',
  dtype: 'q8',
  pathSafeId: 'arctic-s',
};
```

Do not keep model definitions for `snowflake-arctic-embed-xs`, `nomic-embed-text-v1.5`, or `all-MiniLM-L6-v2`. Those identifiers should only appear in tests or fixture data if needed to prove old DB metadata triggers a rebuild.

Change pooling from `mean` to `cls` in both query and document embedding calls. Snowflake's Transformers.js example uses `{ normalize: true, pooling: 'cls' }`, and query-time and index-time vectors must use the same pooling strategy.

## Product Behavior

On startup:

1. The app constructs the bundled model directory path.
2. The embedding worker loads that local directory directly.
3. Each silo inspects its index with the `peekIndexState` gate (below).
4. Silos with a fresh or unusable index reindex from disk automatically; silos with a usable index open and serve immediately.
5. Indexing and semantic search use the single bundled model.

There is no download path, cache presence check, remote fallback, setup dialog, model status IPC, retry UI, packaged-model validation flow, mismatch prompt, or manual rebuild action.

### Index validity: the `peekIndexState` gate

Index validity (schema version) and model identity (model key) were previously checked in two separate places with two vocabularies. They are now one read-only peek with three outcomes:

```ts
type IndexState = 'fresh' | 'usable' | 'unusable';

// fresh    — no file, or a file with no `files` table              → create & index
// usable   — version === SCHEMA_VERSION
//            && model === EMBEDDING_MODEL.key
//            && dimensions === EMBEDDING_MODEL.dimensions          → open & serve
// unusable — file has content but ANY of the above can't confirm   → delete & index
```

`unusable` is named for the decision, not the cause. It covers a wrong schema version (genuinely wrong structure), a wrong model (structure is fine, but the stored vectors are semantically meaningless against the current model), and missing or unreadable metadata (cannot tell). What unifies them is not a shared defect — it is that the index cannot be *confirmed*, so it will not be *used*.

The gate is **strict**: a missing `version`, `model`, or `dimensions` row reads as `unusable`, never as a default. (Today `loadMeta` defaults a missing `version` to `SCHEMA_VERSION`, which would be a false confirm — the gate must read these keys raw.)

### Automatic rebuild

`unusable` and `fresh` take the **same branch**: delete the index file if present, create a fresh database, and let the normal startup reconcile index everything from disk. A rebuild is therefore not a distinct subsystem — it is a `fresh` start with a `delete` prepended, running through the indexing path that already exists and is already serialized by the global `IndexingQueue` (only one silo embeds at a time).

While this runs, the silo reports `watcherState: 'indexing'`, identical to a first index. There is **no user-visible "rebuild" state, no prompt, and no manual rebuild button.** The rebuild is invisible: the user sees a silo indexing, the same as any first run or large change.

The `SQLite` index is a derived cache, not source data — the user's files on disk are the truth. Deleting and rebuilding never destroys anything irreplaceable, which is what makes automatic deletion safe.

## Implementation Plan

### Phase 1: Remove the Model Surface

Backend:

- Replace `src/backend/model-registry.ts` with the single `EMBEDDING_MODEL` constant.
- Remove `MODEL_REGISTRY`, `DEFAULT_MODEL`, `LEGACY_MODEL`, `getModelDefinition()`, `getBundledModelIds()`, and `getModelPathSafeId()` unless a tiny path-safe helper is still useful for DB filename generation.
- Update `BuiltInEmbeddingService` so it no longer accepts a model ID. It should use `EMBEDDING_MODEL` directly.
- Change `embed()` and `embedBatch()` in `src/backend/embedding-builtin.ts` to use `pooling: 'cls'`.
- Keep DB metadata writes, but always write `EMBEDDING_MODEL.key`.

Main process:

- Replace `AppContext.embeddingServices: Map<string, EmbeddingService>` with a single `embeddingService: EmbeddingService | null`.
- Change `getOrCreateEmbeddingService(model)` to `getOrCreateEmbeddingService()`.
- Update startup, shutdown, IPC search, and internal API search code to use the single embedding service.
- Remove model grouping from cross-silo search dispatch (`groupByModel` in `search-merge.ts`). Embed the query once for semantic/hybrid search and reuse that vector across all searchable silos. Change `dispatchSearch`'s `resolveService: (model) => …` parameter to a single service.

Config and IPC:

- Remove `default_model_key` and `embedding_model_key` from config types and newly written config.
- The config parser already reads only named fields and ignores unknowns, and `resolveSiloRuntimeConfig` falls back to a default — so stale model fields in an existing `config.toml` are silently dropped on the next save. No defensive migration code is needed.
- Remove `embeddingModelKey` from new silo creation and silo update IPC payloads.
- Remove `embeddingModelOverride`, `resolvedEmbeddingModelKey`, `availableModels`, `defaultModel`, and `modelPathSafeIds` from shared renderer-facing types unless a read-only model label still needs one canonical string. These move together with `preload.ts`, `electron-api.d.ts`, the IPC handler that returns them, and the `AddSiloModal` consumer, or TypeScript breaks.

Renderer:

- Remove the default embedding model selector from Settings.
- Remove the Model step from Add Silo.
- Remove the per-silo model dropdown from Silo Detail.
- Remove the model selector from Onboarding.
- Remove formatter helpers that only exist for model display parsing, such as `modelIdFromDisplay()` and `toModelSlug()`, if no longer used.

### Phase 2: Vendor and Load the Bundled Model

Vendoring:

- Commit the model directory at:

```text
resources/models/Snowflake/snowflake-arctic-embed-s/
```

- Include:
  - `config.json`
  - tokenizer files needed by Transformers.js, expected to include `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`, and likely `vocab.txt`
  - `onnx/model_quantized.onnx`
  - upstream license material, such as `LICENSE` and `NOTICE` if present
  - `LODESTONE_MODEL_PROVENANCE.md` with Hugging Face repo, commit SHA, fetched date, file list, sizes, and license

- Vendor only the chosen q8 ONNX weight file. Do not include `model.safetensors`, full-size ONNX files, or alternate quantizations.
- Add `resources/models` to `packagerConfig.extraResource` in `forge.config.ts`.
- A helper script such as `scripts/fetch-embedding-model.mjs` may be added to regenerate the vendored directory, but builds must not fetch the model.

Runtime:

- Construct the absolute model directory in the main process:

```ts
const modelDir = app.isPackaged
  ? path.join(process.resourcesPath, 'models', 'Snowflake', 'snowflake-arctic-embed-s')
  : path.join(app.getAppPath(), 'resources', 'models', 'Snowflake', 'snowflake-arctic-embed-s');
```

- Pass `modelDir` through `createEmbeddingService(...)`, `WorkerEmbeddingProxy`, and the worker `init` message.
- In `src/backend/embedding-builtin.ts`, call Transformers.js with the local directory directly:

```ts
pipeline('feature-extraction', modelDir, {
  dtype: EMBEDDING_MODEL.dtype,
  session_options: {
    intraOpNumThreads: onnxThreads,
    interOpNumThreads: 1,
  },
});
```

- Remove `env.cacheDir`, `env.localModelPath`, `env.allowRemoteModels`, and model-cache directory handling.
- Remove `getModelCacheDir()` from `src/main/context.ts` if nothing else uses it.
- Keep the existing worker warmup behavior. It now loads from the bundled model directory.

### Phase 3: The `peekIndexState` Gate and Automatic Rebuild

Backend:

- Add `peekIndexState(dbPath): 'fresh' | 'usable' | 'unusable'` as a read-only peek alongside the existing functions in `src/backend/store/peek.ts`. It reads `version`, `model`, and `dimensions` raw from the `meta` table; missing any one of them yields `unusable`.
- Wire the gate into silo startup **before** the database is opened for writes:
  - `fresh` → create DB, `saveMeta`, reconcile from disk.
  - `unusable` → delete the `.db` (plus `-wal`/`-shm` companions), then take the `fresh` path.
  - `usable` → open and serve; the `CREATE TABLE IF NOT EXISTS` calls are harmless no-ops.
- **Write `model`, `dimensions`, and `version` at DB-creation time**, not later during reconcile. This closes the auto-reindex-loop window: a rebuild that is interrupted (or merely started) must read back as `usable` on the next launch and resume via normal reconcile, rather than being deleted and restarted from zero. Today `version` is stamped early but `model`/`dimensions` are written later by `saveMeta` — move them together.
- Remove the `modelMismatch` field and the `checkAndPersistMeta` comparison logic. Identity is now decided by the gate before open; what remains is a plain `saveMeta` on a fresh or rebuilt DB.

Search:

- Continue skipping stopped silos.
- For semantic and hybrid search, require the single embedding service.
- For BM25, filepath, and regex modes, keep existing no-query-embedding behavior.
- A silo that is auto-rebuilding is in the `indexing` state and is naturally not yet serving complete results — the same as any first index. No special-casing required.

Renderer:

- No changes for rebuild. There is no `rebuild` watcher state, no "Rebuild Required" copy, no rebuild button, and no mismatch warning. `WatcherState` is unchanged.
- In Add Silo "Connect existing", do not surface or edit a model field. If a connected DB's index is unusable, it simply auto-rebuilds on start like any other silo.

### Removed Legacy Paths

These are explicit deletions, listed so they are not reintroduced. Most are safe specifically because the `xs → s` model switch invalidates every existing index — no confirmable old database survives this release, so migration code is provably dead the moment it ships.

| Delete | Location | Why it's safe |
|---|---|---|
| `migrateSchema()` | `src/backend/store/schema.ts` | Nothing confirmable survives the model switch; in-place upgrade is never exercised |
| `checkSchema()` and its `migrate` / `incompatible` branches + structural probing (`stored_key` / `file_id` / `term_id`) | `src/backend/store/schema.ts` | Subsumed by `peekIndexState`; `createSiloDatabase` only ever creates fresh |
| `normalizeStoredConfig()` + legacy snake_case-key prefill | `src/backend/store/peek.ts`, `AddSiloModal` (reverts commit 78fe5e2) | No legacy DBs to read; deliberate revert of the recent shim |
| `checkAndPersistMeta` mismatch logic | `src/backend/silo-manager.ts` | Becomes a plain `saveMeta` on fresh/rebuilt DBs |
| `modelMismatch` field, `'rebuild'` watcher state, rebuild button + IPC action + "Rebuild Required" copy | renderer + IPC | Rebuild is now invisible and automatic |
| `MODEL_REGISTRY`, `DEFAULT_MODEL`, `LEGACY_MODEL`, model selectors, `default_model_key` / `embedding_model_key`, `availableModels` IPC | backend + config + renderer | Single bundled model (Phases 1–2) |

After these deletions, `createSiloDatabase` reduces to: mkdir → open → load extension → pragmas → `CREATE TABLE IF NOT EXISTS` → stamp identity → create vec table. No inspection, no migration, no conditional delete.

## Tradeoffs (deliberate)

- **Schema evolution is now rebuild, not migrate.** With the migration path deleted, any future `SCHEMA_VERSION` bump invalidates every index and triggers an automatic rebuild — the same mechanism as a model change. For a local-first app where "rebuild" means "re-read your own files from a cold cache," this is an acceptable trade for never writing another migration.
- **No manual rebuild / escape hatch.** If an index were ever subtly corrupted in a way the gate reads as `usable` (correct identity, bad rows beneath), there is no in-app recovery short of deleting the `.db` by hand. This is intentional: such corruption is a bug to fix at its source, not a button to add. If it ever proves necessary, a "delete & reindex" context-menu action can be added later without disturbing any of this design.
- **The first launch after this release reindexes every silo.** Because `xs → s` invalidates all existing indexes, the first post-update launch auto-rebuilds all of them. This is serialized by `IndexingQueue` and deferred until after `did-finish-load`, so it is survivable, but it is a known heavy first launch and the most likely moment for the known startup event-loop pressure to show. Worth watching during verification.

## Tests

The bar for a test here is: **it exercises new branching logic against the real schema and fails if a real bug is present.** Tests that merely echo a value we just set, or assert UI absence the compiler already enforces, are not worth carrying. Following the existing suite's conventions — production schema via `LocalStoreFacade`, no mocks, deterministic stub vectors, no search-quality assertions — three tests earn their place.

### 1. `peekIndexState` truth table

The gate is brand-new branching logic and contains the one genuine trap we identified: `loadMeta` defaults a missing `version` to `SCHEMA_VERSION`, so a gate that naively reuses it would *false-confirm* a DB with no version row. Run all cases fast against the real schema (`createSiloDatabase` + `saveMeta` in a temp dir):

- no file, and a file with no `files` table → `fresh`
- `version`, `model`, `dimensions` all match `SCHEMA_VERSION` / `EMBEDDING_MODEL` → `usable`
- wrong `model` → `unusable`
- wrong `dimensions` → `unusable`
- **missing `version` row → `unusable`** (the highest-value assertion in the plan — guards against the `loadMeta` defaulting trap)
- missing `model` or `dimensions` row → `unusable`

### 2. Automatic rebuild, end-to-end

This **replaces** the existing model-mismatch test at `silo-manager-regression.test.ts:160-187`, whose `modelMismatch === true` assertion describes behaviour we are deleting. The new test asserts the behaviour we are adding, using the temp-dir facade so the unlink + recreate path runs for real:

- Build and index a DB whose stored model is something other than `EMBEDDING_MODEL.key` (the pre-existing-stale-index case).
- Start a `SiloManager` against that on-disk DB with the current model.
- Assert: the old index was discarded and reindexed from the files on disk, the silo ended `ready`, and a search returns the on-disk file. One test, whole feature.

### 3. No-reindex-loop guard

The scariest failure mode of *automatic* rebuild is an infinite delete → reindex → delete loop; the plan's defense is writing identity at DB-creation time. One assertion pins it:

- Immediately after `createSiloDatabase` (before any reconcile runs), `peekIndexState` already returns `usable`. This proves an interrupted rebuild resumes via normal reconcile instead of deleting and restarting from zero. The bug it catches is silent and catastrophic, and the assertion is a one-liner.

### Not unit-tested (deliberately)

- **`cls` pooling correctness** is a *one-time manual verification*, not a regression guard. A mock-the-argument test (`pooling: 'cls'` was passed) proves nothing about correctness, and a real-retrieval test needs the 34 MB ONNX model — slow, and it violates the suite's no-quality-assertions convention. It belongs in Phase 2 verification (below), done once when the model is vendored.
- **UI absence** (no model selector, no rebuild state/copy/action) is enforced by the compiler once `WatcherState` drops `rebuild` and the model types are removed — not worth brittle render-absence tests.
- **Packaging/config echoes** (`extraResource` contains `resources/models`, vendored dir has license files) are checklist items, not logic.
- **Cross-silo "embed once"** becomes near-trivial after `groupByModel` is deleted — low bug surface, skipped unless dispatch regresses.

### Existing tests to update or remove

- `config.test.ts` asserts `default_model_key` — rewrite for the single-model config.
- `silo-manager.test.ts` and `silo-manager-regression.test.ts` use `embeddingModelKey` and the model-a/model-b mismatch fixtures — the mismatch test is replaced by test #2 above; the rest rewrite around the gate.
- `embedding-builtin.test.ts` constructs the service with a model ID and asserts it rejects unknown ids — that whole contract is gone; rewrite for `EMBEDDING_MODEL`.

## Phase 2 Verification (one-time, manual)

When the model is first vendored, confirm `cls` pooling actually produces sane vectors for `arctic-s`: build a small index, run a known query, and confirm the expected document ranks at or near the top. This is the only change in the plan that cannot fail loudly, so it gets a deliberate human check once — not a permanent test.

## Cleanup

- Remove old comments and docs that describe multiple bundled models, runtime downloads, model cache, model setup, selectable embedding models, schema migration, or user-facing rebuild prompts.
- Update README/docs to say Lodestone uses one bundled local embedding model, and that indexes are rebuilt automatically when the bundled model or schema version changes.

## Source Notes

- Snowflake Arctic Embed XS: https://huggingface.co/Snowflake/snowflake-arctic-embed-xs
- Snowflake Arctic Embed S: https://huggingface.co/Snowflake/snowflake-arctic-embed-s
- Snowflake Arctic Embed S ONNX files: https://huggingface.co/Snowflake/snowflake-arctic-embed-s/tree/main/onnx
- Transformers.js Node usage: https://huggingface.co/docs/transformers.js/tutorials/node
