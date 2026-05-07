# SiloManager — module map

Per-silo orchestrator. One instance per silo, owned by `main.ts` /
`mcp-server.ts` for the lifetime of the silo. Wires together a small set
of focused collaborators and exposes the public API consumed by the
renderer (via IPC) and the MCP server.

This doc reflects the post-refactor reality (Phases 1–7 of the
[silo-manager refactor plan](../silo-manager-refactor-plan.md), plus
Phase 8 trim candidate #1). It complements that plan; the plan covers
the *why* and the historical context, this doc covers the *current*
shape.

---

## The graph

```
                     ┌──────────────────────────┐
                     │       SiloManager        │
                     │   (coordinator, ~860LOC) │
                     └────┬───────────────┬─────┘
                          │               │
       ┌──────────────────┼───────────────┼─────────────────────┐
       ▼                  ▼               ▼                     ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐   ┌─────────────────┐
│ StoreFacade  │  │ SiloLifecycle│  │SiloConfigStore│  │ DirectoryExplorer│
│ (interface;  │  │ (FSM +       │  │ (config blob  │  │ (explore + path  │
│  proxy impl) │  │  cancel tok) │  │  + apply)     │  │  translation)    │
└──────┬───────┘  └──────┬───────┘  └───────────────┘  └──────────────────┘
       │                 │
       │  ┌──────────────┴──────────────┐
       │  ▼                             ▼
       │ ┌──────────────┐   ┌──────────────────────┐
       │ │  MtimeIndex  │   │  WatcherCoordinator  │
       │ │ (cache + DB) │   │ (live watcher,       │
       │ └──────┬───────┘   │  queue-dedup,        │
       │        │           │  event handler)      │
       │        │           └────────┬─────────────┘
       │        ▼                    │
       │  ┌──────────────┐           │
       └─▶│  ActivityLog │◀──────────┘
          │ (buffer + DB)│
          └──────────────┘
```

Arrows are "owns / uses" relationships. The store is the universal
back-end; the lifecycle's cancellation token is read by reconcile and
the watcher loop; the watcher coordinator is the only writer outside
the manager itself that calls into mtime + activity.

---

## Collaborators

| Module | File | Responsibility |
|---|---|---|
| `StoreFacade` | [`store-facade.ts`](../../src/backend/store-facade.ts) | 22-method interface around the store-worker proxy. `proxyStoreFacade` is the production impl; `LocalStoreFacade` is the in-memory/temp-dir test impl in [`test-helpers/local-store-facade.ts`](../../src/backend/test-helpers/local-store-facade.ts). Constructor-injected so tests can swap. |
| `SiloLifecycle` | [`silo/silo-lifecycle.ts`](../../src/backend/silo/silo-lifecycle.ts) | FSM with phases `created` / `starting` / `waiting` / `indexing` / `maintenance` / `ready` / `stopped` / `error`, plus an orthogonal `stopRequested` cancellation token. Maps internal phase → external `WatcherState` for IPC. |
| `SiloConfigStore` | [`silo/silo-config-store.ts`](../../src/backend/silo/silo-config-store.ts) | Owns the `ResolvedSiloConfig` blob, exposes a parametric `apply()` for partial updates, and persists to DB. Replaces the seven near-identical `update*` methods that used to live on the manager. |
| `MtimeIndex` | [`silo/mtime-index.ts`](../../src/backend/silo/mtime-index.ts) | In-memory `storedKey → mtimeMs` cache. Implements an `MtimeSink` write-side interface used by reconcile (sync `recordIndexed`/`recordDeleted` after a successful flush) and the watcher (async `indexed`/`deleted` for explicit DB writes). Single owner of the "in-memory mtime == DB mtime" invariant. |
| `ActivityLog` | [`silo/activity-log.ts`](../../src/backend/silo/activity-log.ts) | Bounded ring buffer of `WatcherEvent`s (cap 200) + listener fan-out + fire-and-forget DB persistence. Replaces the duplicated `activityLog.push(...) + slice + listener + storeProxy.logActivity` block that used to appear at every event site. |
| `WatcherCoordinator` | [`silo/watcher-coordinator.ts`](../../src/backend/silo/watcher-coordinator.ts) | Owns the live `SiloWatcher`, the `pendingWatcherEnqueue` / `cancelWatcherEnqueue` / `watcherIndexingDone` triple, the watcher-event handler (which delegates to `MtimeIndex` and `ActivityLog`), and `scheduleWatcherIndexing` queue dedup. |
| `DirectoryExplorer` | [`silo/directory-explorer.ts`](../../src/backend/silo/directory-explorer.ts) | `exploreDirectories` body: empty-query short-circuit (synthesise root results from `expandTree`), `startPath` translation between absolute paths and stored keys, recursive resolution of stored keys back to absolute paths in result trees. |

Each collaborator has its own test file alongside it. The store-mediated
ones (`MtimeIndex`, `ActivityLog`, `WatcherCoordinator`) use the
`LocalStoreFacade`; `DirectoryExplorer`'s tests use a recording stub
because its logic is path-translation, not store-shape.

---

## What stays in `SiloManager`

After the extractions, the manager is responsible for:

1. **Constructor wiring.** Build each collaborator and connect their
   listeners (e.g. lifecycle phase changes → `stateChangeListener` with
   the no-op-edge filter).
2. **Lifecycle sequencing.** `start()` → `doStart()` decomposes into
   six named phase methods (`initEmbedding`, `openDatabase`,
   `checkAndPersistMeta`, `loadInitialState`, `runStartupReconcile`,
   `runWalMaintenance`) plus the final `transition('ready')` and
   `watcherCoord.start()`. Cancellation is honoured at every yield
   point. `stop()` / `freeze()` / `wake()` / `rebuild()` likewise live
   here as short sequencers.
3. **Public read API.** `search`, `reindexFile`, `exploreDirectories`,
   `getStatus`, `getActivityFeed`, `hasModelMismatch`, `getConfig`,
   `getEmbeddingService`, plus the `update*` methods that delegate to
   `configStore.apply()` and either `persist()` or
   `reconcileAndRestartWatcher()`.
4. **Status caching.** `cachedFileCount` / `cachedChunkCount` /
   `cachedSizeBytes` — written from `runStartupReconcile` and `freeze`,
   read by `getStatus` when the silo is `stopped` / `waiting` / in
   `maintenance`. (Trim candidate #2 in the plan would extract this;
   not yet pursued — see "Outstanding work" below.)
5. **Two store-ops adapter factories**: `makeWatcherStoreOps()` and
   `makeReconcileStoreOps()`. Reconcile and the watcher consume narrow
   per-domain interfaces (declared in their respective modules); the
   manager builds those from the broader `StoreFacade`.
6. **Two reconcile callbacks**: `onReconcileProgress` and
   `onReconcileEvent`. They glue the lifecycle FSM, the activity log,
   and the `reconcileProgress` field. Deliberately not extracted —
   moving them would just thread three references back through.

---

## Load-bearing details (preserve through future changes)

These are the contracts the regression suite pins. Don't break them
without a deliberate, separately-justified change.

- **External `WatcherState` filter.** The constructor wires
  `lifecycle.onChange` through a filter that suppresses no-op edges
  between internal phases that map to the same wire value (e.g.
  `'indexing'` ↔ `'maintenance'`). Removing the filter would surface
  spurious state changes to the renderer.
- **FSM phase vs cancellation token are orthogonal.** A `stop()` while
  reconcile is mid-flush keeps phase `'indexing'` *and* sets
  `stopRequested = true`. Reconcile checks the token at every yield
  point and breaks cleanly. Compressing the two into one would either
  lie about the running state or fail to cancel.
- **Queue boundary spans reconcile + WAL maintenance.** In
  `runStartupReconcile`, a single `IndexingQueue` slot is held across
  *both* reconcile and the subsequent WAL checkpoint/VACUUM. This
  prevents inter-silo interleaving between the two halves. Don't split
  the slot.
- **Reconcile cancellation contract.** Reconcile and the watcher loop
  receive `() => lifecycle.stopRequested` as their cancellation
  callback. This is the single source of truth for "should I bail?".
- **`peekFileCount` deliberately bypasses the worker.** It opens its
  own `better-sqlite3` connection on the main thread for read-only
  access to stopped silos. Intentionally not on `StoreFacade`.
- **`siloId === config.name`, recomputed on access.** Pain point 7a in
  the refactor plan documents the rename hazard; the regression suite
  pins current behaviour. Don't change the identity model without a
  separate bugfix ticket.
- **Two-step status priming.** `loadWaitingStatus()` /
  `loadStoppedStatus()` are called *before* `start()` from
  `main/lifecycle.ts` so the UI paints a card synchronously. Folding
  them into `start()` would lose the synchronous paint.

---

## Test surface

| Suite | Backing | Covers |
|---|---|---|
| [`silo-manager-regression.test.ts`](../../src/backend/silo-manager-regression.test.ts) | TempDir | The Phase 1 behaviour-pinning net: lifecycle round-trips, status caching, watcher events, rename pinning, model mismatch, `rebuild()` post-state, plus three Phase 6 cancellation-yield-point tests. |
| [`silo-manager.test.ts`](../../src/backend/silo-manager.test.ts) | TempDir | Pre-refactor embedding-init failure path. Preserved end-to-end through every phase as the strongest behaviour-preservation signal. |
| [`silo/mtime-index.test.ts`](../../src/backend/silo/mtime-index.test.ts) | InMemory | Read surface, both write paths (sync `record*`, async `indexed`/`deleted`), bulk load, clear. |
| [`silo/activity-log.test.ts`](../../src/backend/silo/activity-log.test.ts) | InMemory | Cap enforcement, listener fan-out, fire-and-forget persistence. |
| [`silo/silo-config-store.test.ts`](../../src/backend/silo/silo-config-store.test.ts) | InMemory | `apply()` parametric updates, validation, persist. |
| [`silo/silo-lifecycle.test.ts`](../../src/backend/silo/silo-lifecycle.test.ts) | (no store) | Legal/illegal transitions, listener fan-out, `stopRequested` semantics, FSM-phase → `WatcherState` mapping. |
| [`silo/watcher-coordinator.test.ts`](../../src/backend/silo/watcher-coordinator.test.ts) | InMemory + FakeSiloWatcher | Lifecycle, event handling, dedup, in-flight awaiting, callback fan-out, `stopRequested` suppression. |
| [`silo/directory-explorer.test.ts`](../../src/backend/silo/directory-explorer.test.ts) | recording stub | Empty-query short-circuit, `startPath` translation branches, stored-key → absolute-path resolution. |

`LocalStoreFacade` (in-memory or temp-dir) lives in
[`test-helpers/`](../../src/backend/test-helpers/) and shares the real
schema and SQL paths with production — no second worker thread.

---

## Outstanding work

- **Phase 8 trim candidate #2 (`StatusReporter`/`StatusCache`).** Would
  move `cachedFileCount` / `cachedChunkCount` / `cachedSizeBytes`,
  `getStatus`'s cache gating, and `readFileSizeFromDisk` into a small
  status collaborator. Modest yield (~50–70 lines), needs care around
  the cache-fill ordering between `runStartupReconcile` and the
  `'maintenance'` transition (the gating contract). Not yet pursued.
- **Mid-reconcile error overwrite.** When reconcile throws inside
  `doStart`'s queue task, the catch transitions to `'error'`, but
  `doStart` proceeds and unconditionally transitions to `'ready'`,
  overwriting the error. Renderer-error-surfacing follow-up.
- **Identity rename hazard** (pain point 7a). The regression suite pins
  current behaviour; a real bug surfacing here is its own
  rename-through-worker-close+reopen vs immutable-id ticket.
- **Reconcile event-loop starvation.** Move `walkDirectory` / reconcile
  to a worker thread. Separate ticket.
