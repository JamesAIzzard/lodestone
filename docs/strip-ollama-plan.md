# Strip Ollama Connection — Removal Plan

**Goal:** Remove the entire Ollama-as-embedding-backend subsystem. The app already
ships with bundled ONNX models (Arctic Embed XS and Nomic Embed v1.5) that run
in-process via Transformers.js, so the optional REST connection to a local Ollama
server is dead weight. After this change, every embedding flows through the
shared ONNX worker thread. No external embedding service exists.

**Why now:** The bundled models cover the default and "bigger / better" choices
that 99% of users want, and the model registry is the single source of truth for
what's selectable. Carrying Ollama forward means an extra config key, an extra
embedding class, an HTTP probe in the status payload, an entire onboarding step,
and a settings section — all to support a code path most users never hit. When
they do hit it the failure modes (Ollama not running, model not pulled, Ollama
returning a different dimension than the index was built with) are confusing.
Cutting it removes a whole class of "why isn't search working?" bugs.

---

## Scope boundaries

**Stays** (file-search core, untouched):
- Bundled ONNX embedding via `WorkerEmbeddingProxy` and the shared embedding worker
- `MODEL_REGISTRY`, model definitions, prefixes, dtype, dimensions
- The `'built-in'` legacy alias resolution in [`resolveModelAlias`](../src/backend/model-registry.ts) — Phase 2 configs may still use it
- All silo, watcher, search, indexing, MCP, settings, and activity machinery

**Goes** (everything Ollama):
- `OllamaEmbeddingService` class and the `checkOllamaConnection` helper
- The factory branch that switches built-in vs Ollama (factory becomes a one-liner)
- `[embeddings] ollama_url` config key and its default `http://localhost:11434`
- `ollama:test` IPC handler and `testOllamaConnection` preload binding
- `ServerStatus.ollamaState` / `ollamaUrl` and the `OllamaConnectionState` type
- The "Ollama Connection" section in Settings (URL field, Test button, model badges)
- The "Ollama" step in Onboarding (Step 1 of 3 → flow collapses to 2 steps)
- The Ollama row in the sidebar status panel (collapsed + expanded variants)
- `isBuiltInModel()` — exists only to gate the Ollama branch
- All Ollama-flavoured comments and JSDoc throughout

---

## Inventory of changes

### 1. Backend embedding service — collapse to single-path

[src/backend/embedding.ts](../src/backend/embedding.ts):

- Delete the entire `// ── Ollama ───` section: `OllamaEmbeddingService` class
  (lines 233–298)
- Delete the `// ── Ollama Utilities ───` section: `checkOllamaConnection`
  (lines 329–349)
- Simplify the `EmbeddingServiceOptions` interface: drop `ollamaUrl`
- Simplify `createEmbeddingService` (lines 319–327) to:
  ```ts
  export function createEmbeddingService(options: EmbeddingServiceOptions): EmbeddingService {
    const modelId = resolveModelAlias(options.model);
    return new WorkerEmbeddingProxy(modelId, options.modelCacheDir);
  }
  ```
  (No more `isBuiltInModel` branch — every supported model is bundled.)
- Drop the `isBuiltInModel` import from the model-registry import block
- Tidy the file-level JSDoc (lines 1–11): the comment claims "two backends:
  built-in … and Ollama REST API" — rewrite to describe only the bundled-ONNX
  flow

### 2. Backend model registry — drop the helper that only Ollama needed

[src/backend/model-registry.ts](../src/backend/model-registry.ts):

- Delete `isBuiltInModel` (lines 114–120) — no remaining callers after step 1
- Update file header comment (lines 1–14): the "without Ollama" phrase becomes
  meaningless once Ollama is gone
- Update JSDoc on `getModelDefinition` (line 99) — drop "Returns undefined for
  Ollama models" (the function still returns undefined for unknown keys, but
  Ollama is no longer the canonical example)
- Update JSDoc on `getModelPathSafeId` (lines 132–135) — drop the
  "(e.g. Ollama)" example. The sanitization fallback can stay as defensive
  code for unrecognised registry keys, but the Ollama framing goes
- `LEGACY_MODEL` ('all-MiniLM-L6-v2') stays — it's referenced by mismatch
  detection, unrelated to Ollama

### 2a. Backend embedding-builtin — fail loudly on unknown model IDs

[src/backend/embedding-builtin.ts](../src/backend/embedding-builtin.ts) line 48
currently does:

```ts
const def = getModelDefinition(modelId) ?? getModelDefinition(DEFAULT_MODEL)!;
```

**Why this matters now:** while the Ollama branch existed, an unknown ID was
guaranteed to be a valid Ollama model name and the `WorkerEmbeddingProxy`
path was never reached for it. After step 1 collapses the factory, **every**
model ID — including legacy Ollama names like `nomic-embed-text` from a
user's existing `config.toml` — flows into `BuiltInEmbeddingService`. The
silent fallback then produces a confusing failure mode:

- `this.dimensions` is set from `DEFAULT_MODEL` (e.g. 384)
- `this.def.hfModelId` points at the default model's HuggingFace repo
- The actual ONNX inference runs against a *different* model than the user
  configured
- The silo's `meta.json` records the **resolved** model dimensions; on next
  startup, mismatch detection won't notice anything is wrong because the
  resolved dimensions match what's stored
- The user is left wondering why their "nomic" silo's results look like
  Arctic-XS results

**Fix:** make the constructor throw on unknown IDs:

```ts
constructor(
  private readonly modelId: string,
  private readonly cacheDir: string,
) {
  const def = getModelDefinition(modelId);
  if (!def) {
    throw new Error(
      `Unknown embedding model "${modelId}". ` +
      `Available models: ${Object.keys(MODEL_REGISTRY).join(', ')}.`,
    );
  }
  this.def = def;
  // ...
}
```

This requires adding `MODEL_REGISTRY` to the existing import block (lines
23–27) — currently only `getModelDefinition`, `DEFAULT_MODEL`, and
`ModelDefinition` are imported. Update the JSDoc on the constructor (lines
38–43) to drop the "Falls back to DEFAULT_MODEL" line and reflect the new
contract.

The throw propagates through the worker's `error` message back to
`WorkerEmbeddingProxy.ensureReady()` — but **that's not enough on its own**.
See step 2b below for the matching surfacing fix.

### 2b. SiloManager — surface startup errors so they reach the UI

The throw introduced in step 2a is currently swallowed by two unguarded
layers:

- [silo-manager.ts:325–328](../src/backend/silo-manager.ts) —
  `doStart()` awaits `this.embeddingService.ensureReady()` *before* any
  `try/catch`; the reconciliation block (lines 385+) is wrapped, but the
  embedding-init and `storeProxy.open()` steps are not
- [lifecycle.ts:91–96](../src/main/lifecycle.ts) — `enqueueSiloStart`
  calls `manager.loadWaitingStatus()` (which sets `watcherState: 'waiting'`)
  and then `manager.start().catch((err) => console.error(...))`. The catch
  only logs; it does not flip the manager out of the `'waiting'` state, set
  an error message, or fire a state-change notification

Combined effect today: if an `ensureReady()` call were to throw (the new
unknown-model-ID path, but also any future startup failure — e.g.
`storeProxy.open` rejecting on a corrupt DB), the silo card would sit in
`'waiting'` state indefinitely with no `errorMessage`, and the only
indication would be a console log the user never sees.

**Fix:** wrap the synchronous prefix of `doStart()` (everything before the
indexing-queue `enqueue` call — i.e. `ensureReady` through `loadMtimes` /
`loadActivity`) in a `try` that, on `catch`:

1. sets `this.watcherState = 'error'` (use the existing setter on line
   98–100, which already triggers `notifySilosChanged` via the listener
   wired in [lifecycle.ts:78](../src/main/lifecycle.ts))
2. sets `this.errorMessage = err instanceof Error ? err.message : String(err)`
3. clears `this.reconcileProgress = undefined`
4. re-throws so existing callers (tests, `rebuild()`) still see the error

Sketch:

```ts
private async doStart(): Promise<void> {
  try {
    this.embeddingService = this.sharedEmbeddingService;
    await this.embeddingService.ensureReady();
    const dbPath = this.resolveDbPath();
    await storeProxy.open(this.siloId, dbPath, this.embeddingService.dimensions);
    this.dbOpen = true;
    // ...meta check, mtimes load, activity seed...
  } catch (err) {
    this.watcherState = 'error';
    this.errorMessage = err instanceof Error ? err.message : String(err);
    this.reconcileProgress = undefined;
    throw err;
  }

  // 5. Run startup reconciliation via the global IndexingQueue (existing code)
  if (this.stopped) return;
  await new Promise<void>((resolve) => {
    // ...unchanged...
  });
}
```

The reconciliation block already has its own per-file error handling
(line 449–450 sets `watcherState = 'error'` and `errorMessage`) — leave it
alone. This change only adds a guard around the previously unguarded
prefix.

> **Migration consequence:** any silo whose `model = "..."` in `config.toml`
> doesn't match a `MODEL_REGISTRY` key will move to `watcherState: 'error'`
> on the next startup with a clear message naming the bad ID and listing
> the valid ones. The user fixes it via the silo settings UI (which only
> offers registry keys) or by hand-editing `config.toml`. This is the
> intended outcome — silent fallback was a bug masked by the Ollama branch.

### 3. Backend config — drop ollama_url from schema

[src/backend/config.ts](../src/backend/config.ts):

- `EmbeddingsConfig` (lines 25–31): remove the `ollama_url: string` field and
  its JSDoc
- `DEFAULT_CONFIG` (line 83): remove `ollama_url: 'http://localhost:11434'`
- `loadConfig` parsing (lines 161–167): remove the `ollama_url` parsing branch
  so the returned `embeddings` only carries `model`
- Update the JSDoc on `EmbeddingsConfig.model` (lines 26–28) — drop "or an
  Ollama model name" since only registry keys (and the legacy `'built-in'`
  alias) are now meaningful

> **Migration note:** existing `config.toml` files with `[embeddings] ollama_url
> = "..."` are harmless. After the field is removed from `EmbeddingsConfig`,
> `loadConfig` simply doesn't read the key, and the next call to
> [`saveConfig`](../src/backend/config.ts) — which serialises the typed
> in-memory config — will rewrite the file without it. No separate cleanup pass
> needed. Same pattern as the D1-memory removal.

### 4. Main process — strip Ollama from context, status, and IPC

[src/main/context.ts](../src/main/context.ts):
- In `getOrCreateEmbeddingService` (lines 53–65), drop the `ollamaUrl: …` arg
  passed to `createEmbeddingService`. After the factory simplification (step 1)
  it accepts only `model` and `modelCacheDir`

[src/main/ipc-handlers.ts](../src/main/ipc-handlers.ts):
- Drop `import { checkOllamaConnection } from '../backend/embedding'` (line 18)
- In `server:status` handler (lines 538–571):
  - Remove the Ollama URL fetch and `ollamaResult` (lines 541–542)
  - Remove the `if (ollamaResult) models.push(...)` block (lines 554–556) — the
    model list now comes from `getBundledModelIds()` only
  - Remove `ollamaState` and `ollamaUrl` from the returned `ServerStatus`
    object (lines 564–565)
- Delete the entire `ollama:test` IPC handler (lines 573–582)

### 5. Preload + electron API surface

[src/preload.ts](../src/preload.ts):
- Delete the `testOllamaConnection` binding (line 81)

[src/shared/electron-api.d.ts](../src/shared/electron-api.d.ts):
- Delete `testOllamaConnection` from the `ElectronAPI` interface (line 94)

### 6. Shared types

[src/shared/types.ts](../src/shared/types.ts):
- Delete the `OllamaConnectionState` type (line 233)
- In `ServerStatus` (lines 235–244): drop `ollamaState` and `ollamaUrl` and
  their JSDoc
- The orphan `// ── Memory ───` / `// Server` headers at lines 230–231 are a
  leftover from the prior D1 removal. Replace with a single `// ── Server
  Status ───` heading

### 7. Renderer — Sidebar

[src/renderer/components/Sidebar.tsx](../src/renderer/components/Sidebar.tsx):
- Drop both Ollama status rows from the status panel:
  - Collapsed icon (lines 161–172)
  - Expanded label + state row (lines 182–193)
- The `Boxes` icon import (line 11) is used only by those rows — remove from
  the lucide import block. (Verify nothing else in this file references
  `Boxes` after the edit.)
- The `getServerStatus` poll on a 10 s interval stays — it's still feeding
  `totalIndexedFiles` and `uptimeSeconds`

### 8. Renderer — Settings

[src/renderer/views/SettingsView.tsx](../src/renderer/views/SettingsView.tsx):
- Delete state: `ollamaUrl`, `testing`, `testResult`
- Delete handler: `handleTestConnection`
- Delete the entire `<Section title="Ollama Connection">` block (lines 159–197)
- In the initial-load `useEffect` (lines 45–61): drop `setOllamaUrl(s.ollamaUrl)`
- In the `availableModels` builder (lines 138–152): drop the `testResult?.connected`
  branch that merges Ollama models into the dropdown — only `status.availableModels`
  feeds the list now
- Drop the now-unused **`Badge`** import on line 4 (`import { Badge } from
  '@/components/ui/badge'`) — it's only used to render the Ollama model
  badges. Keep `Loader2`, `XCircle`, and `CheckCircle2` from `lucide-react`:
  they're still used by the Claude Desktop section and the Reset dialog

### 9. Renderer — Onboarding

[src/renderer/views/OnboardingView.tsx](../src/renderer/views/OnboardingView.tsx):

This is the largest renderer-side change because the whole first step is Ollama-themed.

- Change `STEPS` from `['Ollama', 'Silo', 'Indexing']` to `['Silo', 'Indexing']`
  (line 18). The flow becomes 2 steps, not 3
- Delete state used only by Step 1: `ollamaChecking`, `ollamaConnected`,
  `ollamaModels` (lines 27–29). Keep `serverModels` and `defaultModel` —
  they're now populated unconditionally on mount instead of behind a "check
  Ollama" button
- Delete the `checkOllama` callback (lines 46–69). Replace the on-mount
  effect (lines 72–77) with a simpler version that just calls
  `getServerStatus()` and `getDefaults()` directly:
  ```ts
  useEffect(() => {
    window.electronAPI?.getServerStatus().then((s) => {
      if (!s) return;
      setServerModels(s.availableModels);
      setDefaultModel(s.defaultModel);
      setModel(s.defaultModel);
    });
    window.electronAPI?.getDefaults().then((d) => setExtensions(d.extensions));
  }, []);
  ```
- Delete the `case 'Ollama':` branch from `canAdvance()` (lines 121–122)
- Delete the entire `{step === 'Ollama' && (…)}` JSX block (lines 213–276) —
  the heading, the three status states, the "Download Ollama" button, the
  "Re-check" button, and the badge list
- Drop the `step === 'Ollama' && ollamaConnected === false` branch from the
  Continue button label (lines 420–423). The button text becomes either
  `"Continue"` or `"Go to Dashboard"`
- Tighten the imports — these change non-trivially:
  - **Remove** `useCallback` from the `react` import (line 1) — `checkOllama`
    was the only consumer
  - **Remove** `ExternalLink` from the lucide import (line 9) — it was only on
    the "Download Ollama" button
  - **Remove** the `Badge` component import (line 13:
    `import { Badge } from '@/components/ui/badge'`) — it was only used to
    render the Ollama model badges
  - **Keep** `XCircle` — it's still used by the Indexing-step error state
    (line 369)
  - **Keep** `Loader2` and `CheckCircle2` — both used by the Indexing step
    and the step indicator

### 10. Documentation

- [README.md](../README.md): no Ollama mention — nothing to change
- [AGENTS.md](../AGENTS.md): grep for any Ollama references; if present,
  remove them
- [CLAUDE.md](../CLAUDE.md): no Ollama mention in the current copy — no change
- User memory ([MEMORY.md](file:///C:/Users/james/.claude/projects/C--Users-james-Documents-lodestone/memory/MEMORY.md)
  is out of repo): the "Architecture Notes" entry mentions
  "Backend: ONNX embedding (Transformers.js), SQLite…" which is already
  Ollama-free. No update strictly needed, but worth a pass

### 11. package.json + package-lock.json — version bump

This is a feature-removal release. Bump the minor version (e.g.
1.2.0 → 1.3.0). The version string lives in **two** places that must move
together:

- [package.json](../package.json) line 4: `"version": "1.2.0"`
- [package-lock.json](../package-lock.json) lines 3 and 9: the top-level
  `"version"` and the root package entry under `"packages": { "": { ... } }`

Use `npm version minor --no-git-tag-version` (which updates both files
atomically) rather than hand-editing `package.json` and forgetting the lock.
No dependencies are pulled in solely by Ollama — it uses the built-in
`fetch`, so no `npm uninstall` step is needed.

### 12. Add a typecheck script

This change removes shared IPC, preload, and renderer-API fields. `npm run
lint` catches unused imports but does **not** catch type-level mismatches
(e.g. a renderer call site still reading a removed `ServerStatus` field).
Add a `typecheck` script to [package.json](../package.json) so the green bar
covers types:

```diff
   "scripts": {
+    "typecheck": "tsc --noEmit",
     "start": "electron-forge start",
```

Run it as part of every step's verification (see "execution order" below).

---

## Suggested execution order

Each step should end green so the work is bisectable. Define "green" as:

```
npm run typecheck && npm run lint && npm run test
```

Add the `typecheck` script as a one-line prelude (see step 12 above) — this
is non-negotiable for this change because the renderer references shared
fields that lint won't catch.

0. **Add the `typecheck` script** to `package.json` (step 12 above) so every
   subsequent step has the type bar to lean on.
1. **Strip the renderer-visible surface first** so the user-facing app is
   clean before backend churn:
   1. Sidebar Ollama rows
   2. SettingsView "Ollama Connection" section + state + `Badge` import
   3. OnboardingView Step 1 + `STEPS` collapse + button label + import
      cleanup (`useCallback`, `ExternalLink`, `Badge`)
2. **Drop the IPC + preload + types**:
   1. `testOllamaConnection` from preload + `electron-api.d.ts`
   2. `ollama:test` handler from `ipc-handlers.ts`
   3. `ollamaState` / `ollamaUrl` from `ServerStatus` (types.ts) and the
      `server:status` handler payload
   4. `OllamaConnectionState` type
3. **Simplify the embedding factory**:
   1. Delete `OllamaEmbeddingService` and `checkOllamaConnection` from
      `embedding.ts`
   2. Collapse `createEmbeddingService` to a single line
   3. Drop `EmbeddingServiceOptions.ollamaUrl`
   4. Update `context.ts` to stop passing `ollamaUrl`
4. **Harden the startup error path** — do these two together so the new
   error is actually visible:
   1. **Step 2b first**: wrap the prefix of `SiloManager.doStart()` in
      try/catch and set `watcherState = 'error'` + `errorMessage` +
      clear `reconcileProgress` on failure. Without this, step 2a's throw
      is swallowed and the silo sits silently in `'waiting'`.
   2. **Then step 2a**: make `BuiltInEmbeddingService` throw on unknown
      model IDs (add the `MODEL_REGISTRY` import) instead of falling back
      to `DEFAULT_MODEL`.
   Doing 2b before 2a means an intermediate green state where the
   surfacing exists but no new throws fire — easier to bisect.
5. **Tidy the model registry**: delete `isBuiltInModel`, update the JSDoc and
   header comment
6. **Prune the config schema**: drop `ollama_url` from `EmbeddingsConfig`,
   `DEFAULT_CONFIG`, and `loadConfig` parsing
7. **Tidy `types.ts` headers**: replace the orphan `// Memory` / `// Server`
   header pair with a single `// ── Server Status ───`
8. **Bump version** via `npm version minor --no-git-tag-version` so
   `package.json` and `package-lock.json` move together
9. **Smoke test**: `npm start`, walk a fresh user through onboarding (now 2
   steps), verify Settings has no Ollama section, verify the sidebar status
   panel has no Ollama row, verify a search runs end-to-end against an
   existing silo, **and** verify the unknown-model error path by
   hand-editing a silo's `model = "nomic-embed-text"` in `config.toml` and
   confirming the silo shows a clear error rather than silently rebuilding

---

## Risks & open questions

- **Existing user configs with `ollama_url`**: harmless, see migration note in
  step 3. The next `saveConfig` rewrites the file without the key. No data
  loss, no startup failure.
- **Existing silos configured with an Ollama-only model**: a user could
  have `[silos.foo] model = "nomic-embed-text"` (an Ollama model name) in
  their config. **Without steps 2a + 2b**, two layers conspire to hide the
  problem: the `?? getModelDefinition(DEFAULT_MODEL)!` fallback in
  [embedding-builtin.ts:48](../src/backend/embedding-builtin.ts) silently
  rewrites the model to the default *and* the unguarded `ensureReady()`
  call in [silo-manager.ts:328](../src/backend/silo-manager.ts) combined
  with the bare `console.error` catch in
  [lifecycle.ts:93](../src/main/lifecycle.ts) means even if it did throw,
  the silo would sit in `'waiting'` forever with no UI signal.
  **With both fixes in place**, the silo transitions to `watcherState:
  'error'` with a message naming the unknown model and listing valid
  registry keys, which is the recoverable outcome.
  Verify this end-to-end during the smoke test by hand-editing a
  `config.toml` to point a silo at `"nomic-embed-text"`, restarting the
  app, and confirming the error message appears on the silo card (not
  just in the console).
- **`getModelPathSafeId` fallback**: the sanitisation branch (line 138–139 of
  `model-registry.ts`) was written specifically to handle Ollama model names
  containing slashes and colons. Once Ollama is gone, all valid inputs come
  from `MODEL_REGISTRY` and have a `pathSafeId`. The fallback can stay as
  defensive code, or be tightened to a `throw new Error` on unknown model
  IDs. Recommendation: keep the fallback (cheap, defensive) and add a comment
  noting it now only triggers for malformed user-edited config values.
- **Onboarding flow visual**: the step indicator is currently sized for 3
  pills + 2 connecting lines. With 2 steps it'll have 2 pills + 1 line —
  worth eyeballing in the smoke test that the layout still feels balanced.

---

## Quick stats (rough lines deleted)

| Area | Approx LOC |
|---|---|
| `OllamaEmbeddingService` + `checkOllamaConnection` + factory branch | ~120 |
| `OnboardingView.tsx` Step 1 + state | ~100 |
| `SettingsView.tsx` Ollama section + state | ~50 |
| `Sidebar.tsx` status rows | ~40 |
| IPC handler + preload + types + config | ~50 |
| `isBuiltInModel` + comment cleanup | ~15 |
| **Total** | **~375 LOC removed** |

Plus one IPC channel, one preload binding, one config key, three `ServerStatus`
fields, and one onboarding step. No npm dependencies removed.
