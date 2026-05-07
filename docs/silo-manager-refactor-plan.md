# SiloManager Refactor — Crystallising Interfaces, Adding High-Value Tests

**Goal:** Decompose the 1084-line `SiloManager` god class into a thin coordinator
that wires together a small number of focused, independently-testable
collaborators with explicit interfaces. Land high-value tests against those
interfaces — not tests for tests' sake, but tests that pin down the parts of the
system that actually misbehave (state transitions, mtime consistency, status
caching, watcher dedup).

**Why this target:** the SiloManager is the central orchestrator of every other
backend subsystem (embedding, store, watcher, indexing queue, reconcile,
pipeline). Five of the project's most-touched files all flow through it. A
clean interface here has compounding clarity benefits — the seams it opens up
also let us start testing the subsystems it wires together.

**Why now:** the file currently has effectively one test
([`silo-manager.test.ts`](../src/backend/silo-manager.test.ts), 59 lines, one
case). Lifecycle, config updates, watcher coordination, status caching, and
reconciliation orchestration are all untested. Past sessions have already
introduced subtle bugs in the boolean state tangle (the comments at
[`silo-manager.ts:413`](../src/backend/silo-manager.ts) and
[`silo-manager.ts:450`](../src/backend/silo-manager.ts) about
`maintenanceInProgress` reset paths point straight at it).

**Non-goal:** changing observable behaviour. Every phase below is
behaviour-preserving refactoring + new tests pinning the existing behaviour.
Anything that *fixes* a behavioural issue is split into its own follow-up
ticket, not bundled into the refactor.

---

## Table of contents

- [Pain points in the current code](#pain-points-in-the-current-code)
- [Target architecture](#target-architecture)
- [Phased plan](#phased-plan)
- [Test strategy](#test-strategy)
- [Risks and mitigations](#risks-and-mitigations)
- [Definition of done](#definition-of-done)

---

## Pain points in the current code

Concrete observations grounded in the file. Cited in `file:line` form.

### 1. One class, five concerns

[`src/backend/silo-manager.ts`](../src/backend/silo-manager.ts) (1084 lines)
contains:

| Concern | Lines | Notes |
|---|---|---|
| State bag | `:67–134` | 16 private fields including a 3-field watcher-dedup tuple |
| Config hot-swap | `:197–314` | 7 nearly-identical update methods |
| Lifecycle orchestration | `:316–595` | `doStart` is 148 lines with an inlined IndexingQueue closure |
| Query / public API | `:611–767` | `search`, `reindexFile`, `exploreDirectories`, `getStatus` |
| Watcher coordination | `:832–1068` | `startWatcher`, `handleWatcherEvent`, `scheduleWatcherIndexing` |

### 2. Boolean state tangle

The "what state is this silo in?" answer is spread across:

- `_watcherState: WatcherState` ([`:74`](../src/backend/silo-manager.ts))
- `stopped: boolean` ([`:114`](../src/backend/silo-manager.ts))
- `maintenanceInProgress: boolean` ([`:94`](../src/backend/silo-manager.ts))
- `pendingWatcherEnqueue: boolean` ([`:122`](../src/backend/silo-manager.ts))
- `cancelWatcherEnqueue: (() => void) | null` ([`:124`](../src/backend/silo-manager.ts))
- `watcherIndexingDone: Promise<void> | null` ([`:126`](../src/backend/silo-manager.ts))
- `dbOpen: boolean` ([`:70`](../src/backend/silo-manager.ts))
- `startPromise: Promise<void> | null` ([`:116`](../src/backend/silo-manager.ts))

`getStatus()` at [`:770`](../src/backend/silo-manager.ts) reads three of these
to decide between cached and live paths. `maintenanceInProgress` is reset
twice in `doStart` ([`:450`](../src/backend/silo-manager.ts) and
[`:460`](../src/backend/silo-manager.ts)) which guarantees it's reset on the
happy path but obscures the actual invariant.

### 3. Repeated config-update boilerplate

Seven methods at [`:197–296`](../src/backend/silo-manager.ts) follow the same
pattern:

```ts
this.config = { ...this.config, <field>: validate(value) };
await this.persistConfigBlob();          // — or —
await this.reconcileAndRestartWatcher(reason);
```

`updateModel`, `updateDescription`, `updateName`, `updateColor`, `updateIcon`
take the persist path; `updateIgnorePatterns`, `updateExtensions`, `rescan`
take the reconcile path. There's no shared helper despite the structural
identity.

### 4. `doStart` is too big

[`:333–480`](../src/backend/silo-manager.ts) sequences eight numbered steps,
including a 70-line inline IndexingQueue closure at
[`:388–464`](../src/backend/silo-manager.ts). The closure captures `this`
implicitly and reads/writes six different `this.*` fields, making it
impossible to extract without threading state explicitly.

### 5. Mtime mutation lives in four places — and not all use the same pattern

Sites that mutate the in-memory `this.mtimes` Map:

- [`silo-manager.ts:360`](../src/backend/silo-manager.ts) — `doStart`
  bulk-load via `storeProxy.loadMtimes`
- [`silo-manager.ts:672`](../src/backend/silo-manager.ts) — `reindexFile`
  after an in-app edit
- [`silo-manager.ts:963/971`](../src/backend/silo-manager.ts) —
  `handleWatcherEvent` for indexed/deleted
- [`reconcile.ts:218/258`](../src/backend/reconcile.ts) — receives the Map
  by reference and mutates it in place during reconciliation

The DB-side persistence pattern *also* varies between sites:

- `handleWatcherEvent` calls `storeProxy.setMtime` / `deleteMtime`
  explicitly after mutating the Map.
- `reindexFile` relies on `storeProxy.flush(..., upsert.mtimeMs)` to
  persist mtime via the upsert — no separate `setMtime` call.
- `reconcile.ts` accumulates `deleteEntries` and lets a flush write
  through.

The DB ends up consistent in each case, but the *pattern* differs at
every site. There is no single owner of the invariant "in-memory mtime
== DB mtime", and adding a new mutation site (e.g. for an MCP edit
operation) means picking which pattern to copy.

### 6. Activity log mutation lives in two places

`activityLog.push(...)` + 200-cap slice + `eventListener?.()` +
fire-and-forget `storeProxy.logActivity(...)` appears at:

- [`silo-manager.ts:910–929`](../src/backend/silo-manager.ts) (`onReconcileEvent`)
- [`silo-manager.ts:933–955`](../src/backend/silo-manager.ts) (`handleWatcherEvent`)

Two near-identical blocks. Drift risk.

### 7a. Store identity is mutable with `config.name`

The `siloId` used as the store-worker key is computed on every access
as `this.config.name`
([silo-manager.ts:136–138](../src/backend/silo-manager.ts)). The store
worker keys silos by string in `silos: Map<string, SiloState>`
([store-worker.ts:37](../src/backend/store-worker.ts)) and *throws*
`"Silo \"${siloId}\" is not open"` when an unknown id arrives
([store-worker.ts:91](../src/backend/store-worker.ts)).

`updateName()` at [silo-manager.ts:183](../src/backend/silo-manager.ts)
mutates `this.config.name` and then calls `persistConfigBlob()` —
which sends `saveConfigBlob(newSlug, …)` against the worker. The
worker has the silo open under the *old* slug.

The IPC rename handler at
[ipc-handlers.ts:469](../src/main/ipc-handlers.ts) does *not*
close-and-reopen the store between the old and new slugs, and there is
no `renameSilo` method on `storeProxy`. So either the rename path has
a latent issue here, or there's a code path that handles it that
isn't obvious from the static read. Worth pinning behaviour with a
test, regardless of which.

This isn't a refactor target — it's a constraint the refactor must not
break. See the Phase 1 test list for the regression-pinning step, and
the Phase 3 note for how `SiloConfigStore` should handle identity.

### 7b. Store coupling is direct, not interface-mediated

[`silo-manager.ts:19`](../src/backend/silo-manager.ts):

```ts
import * as storeProxy from './store-proxy';
```

20+ direct `storeProxy.*` calls in the file. There is no interface that
captures *which* operations the manager actually uses, so nothing can be
mocked or substituted. Combined with the module-level singletons in
[`store-proxy.ts:36–44`](../src/backend/store-proxy.ts), this kills test
isolation.

### 8. The single existing test demonstrates the problem

[`silo-manager.test.ts`](../src/backend/silo-manager.test.ts) tests only the
embedding-init failure path. It can't test anything else because:

- The store-proxy singleton can't be swapped
- `IndexingQueue` is real but inert (no enqueued task can run before the test
  asserts, because the test never lets `start()` resolve)
- Watcher and reconcile cross too many boundaries to fake

---

## Target architecture

A `SiloManager` that's a 200–300-line *coordinator* over five focused
collaborators, each with a single responsibility and an explicit interface.

```
SiloManager (coordinator, ~250 lines)
   │
   ├─ store: StoreFacade          ← interface; today implemented by store-proxy
   ├─ stateMachine: SiloLifecycleState  ← explicit FSM
   ├─ config:  SiloConfigStore    ← persistence + typed updates
   ├─ mtimes:  MtimeIndex         ← in-memory cache + DB sync
   ├─ activity: ActivityLog       ← bounded buffer + DB persistence
   └─ watcherCoord: WatcherCoordinator  ← dedup + queue scheduling
```

### Sketch of each collaborator

> Names and signatures below are for orientation, not contracts. The exact
> shape will firm up during Phase 1 prototyping. Treat as illustrative.

#### `StoreFacade` (interface — implementation is store-proxy)

The interface enumerates *exactly* the methods `SiloManager` (and the ops
adapters it builds) currently call on `storeProxy`. Generated from a grep
of `storeProxy\.\w+` against
[`silo-manager.ts`](../src/backend/silo-manager.ts):

```ts
interface StoreFacade {
  // Lifecycle
  open(siloId: string, dbPath: string, dims: number): Promise<void>;
  close(siloId: string): Promise<void>;

  // Bulk write
  flush(siloId: string, upserts: FlushUpsert[], deletes: FlushDelete[]): Promise<FlushResult>;

  // Meta
  loadMeta(siloId: string): Promise<SiloMeta | null>;
  saveMeta(siloId: string, model: string, dims: number): Promise<void>;

  // Mtimes (used today directly; will move behind MtimeIndex in Phase 2)
  loadMtimes(siloId: string): Promise<Map<string, number>>;
  setMtime(siloId: string, storedKey: string, mtimeMs: number): Promise<void>;
  deleteMtime(siloId: string, storedKey: string): Promise<void>;

  // Activity
  loadActivity(siloId: string, limit: number): Promise<ActivityRow[]>;
  logActivity(
    siloId: string, timestamp: string, eventType: string,
    filePath: string, errorMessage: string | null, maxRows: number,
  ): Promise<void>;

  // Config blob
  saveConfigBlob(siloId: string, blob: StoredSiloConfig): Promise<void>;

  // Stats / maintenance
  getChunkCount(siloId: string): Promise<number>;
  checkpoint(siloId: string, mode?: string): Promise<void>;       // 'PASSIVE' | 'TRUNCATE' | undefined
  vacuum(siloId: string): Promise<void>;

  // Search
  search(siloId: string, queryVector: number[], params: SearchParams): Promise<FileResult[]>;
  directorySearch(
    siloId: string, params: DirectorySearchParams,
  ): Promise<SiloDirectorySearchResult[]>;                        // NB: Silo… result, not Raw…
  expandTree(
    siloId: string, rootPath: string, rootDepth: number,
    maxDepth: number, fullContents?: boolean,
  ): Promise<DirectoryTreeNode[]>;
  getFilesInDirectory(
    siloId: string, dirStoredKey: string,
  ): Promise<Array<{ filePath: string; fileName: string }>>;       // never undefined; empty array if none

  // Directory entries (used by watcher/reconcile store-ops adapters)
  insertDirEntry(siloId: string, dirPath: string): Promise<boolean>;          // true if newly inserted
  deleteDirEntry(siloId: string, dirPath: string): Promise<number | null>;    // rows deleted, or null
  syncDirectoriesWithDisk(siloId: string, diskDirPaths: DirEntry[]): Promise<string[]>; // removed dirs
  recomputeDirectoryCounts(siloId: string): Promise<void>;
}
```

That is **22 methods**, the full list. Phase 1 must not omit any —
adding them later means revisiting every test fake.

**Signatures verified against [`store-proxy.ts`](../src/backend/store-proxy.ts).**
A few non-obvious return types matter to consumers:

- `insertDirEntry → boolean` — `true` when the directory row was
  newly inserted (`changes > 0` from `INSERT OR IGNORE`), `false` if
  it already existed. The watcher uses this to decide whether to emit
  a `'dir-added'` activity event (see
  [`shared/types.ts:205`](../src/shared/types.ts) for the event-type
  union and [`watcher.ts:294`](../src/backend/watcher.ts) for the
  emission site). A test facade that returns `void` or always `true`
  silently breaks that signal.
- `deleteDirEntry → number | null` — returns the **deleted directory's
  internal row id** (the `id` column of the `directories` table), or
  `null` if no matching row existed. Not an affected-row count — it's
  the id of the thing that was just removed. Callers today only check
  for `null` (no-op delete); facades must preserve the same null-vs-
  number distinction.
- `syncDirectoriesWithDisk(diskDirPaths: DirEntry[]) → string[]` — input
  is a `DirEntry[]` where each entry is `{ dirPath, dirName, depth }`
  (see [`store/types.ts:95`](../src/backend/store/types.ts)), **not** a
  `Set<string>`. Output is the list of removed directory paths, used by
  reconcile to fire activity events.
- `directorySearch → SiloDirectorySearchResult[]`. **Watch the
  naming — it's misleading**: despite the `Silo` prefix,
  `SiloDirectorySearchResult` is the *lower-level* per-silo result
  with no silo name attached
  ([directory-search.ts:37](../src/backend/directory-search.ts)).
  `RawDirectoryResult` (in
  [search-merge.ts:107](../src/backend/search-merge.ts)) is the
  *higher-level* type that `extends SiloDirectorySearchResult` and
  adds `siloName`. The cross-silo `dispatchExplore` is what wraps each
  per-silo result with its silo name to produce `RawDirectoryResult[]`.
  The store-proxy / facade level returns the bare per-silo type.

  **Paths in the result are still stored keys** (e.g. `"0:src/backend/"`),
  not absolute paths — `SiloManager.exploreDirectories` at
  [silo-manager.ts:702](../src/backend/silo-manager.ts) calls
  `resolveDirectoryPaths()` to map them back. A test facade that
  returns absolute paths here would silently skip the manager's
  resolution step from the regression coverage. Test facades **must**
  return stored-key paths, exactly like the production worker does.
- `getFilesInDirectory → Array<{filePath, fileName}>` (not undefined —
  empty array when none).

These shapes carry behavioural information. Documenting them wrong in
the test facades would silently elide directory-event firing and other
downstream effects. When implementing the test facades, copy the
`store-proxy.ts` signatures verbatim, then run `tsc --noEmit` — TS
will catch any drift.

The default implementation just wraps the existing `store-proxy.ts`
functions. We don't change the proxy. We just give callers an interface to
hold instead of bare module imports.

**`peekFileCount` is intentionally *not* on the facade.** It's imported
directly from [`store/peek`](../src/backend/store/peek.ts) at
[silo-manager.ts:21](../src/backend/silo-manager.ts) and opens its own
read-only `better-sqlite3` connection on the main thread, bypassing the
worker entirely (used in `loadOfflineStatus` for stopped silos). Keep
that import as-is. The "facade" is the *worker-mediated* surface; the
peek helper is a deliberate side channel and shouldn't be hidden behind
an abstraction that would require routing through the worker.

#### `SiloLifecycle` (FSM)

```ts
// Note: NOT named `SiloState` — that name is already taken in
// `store-worker.ts:32` for the `{ db, termCache }` struct. Naming the
// internal FSM type `SiloLifecyclePhase` (or similar) avoids collision.
type SiloLifecyclePhase =
  | 'created'       // constructed, not started
  | 'starting'      // doStart in progress
  | 'waiting'       // queued in IndexingQueue, not yet running
  | 'indexing'      // reconcile or watcher catch-up running
  | 'maintenance'   // checkpoint / VACUUM running
  | 'ready'         // watcher live, no indexing
  | 'stopped'       // freeze() / explicit stop
  | 'error';        // start failed; errorMessage populated
```

Transitions are explicit and validated. A method like `transition('start →
waiting')` either succeeds or throws. Consumers register listeners; the
manager fires UI events from one place. Replaces the
`stopped` / `maintenanceInProgress` / `_watcherState` triple.

The current `WatcherState` type ([`shared/types.ts`](../src/shared/types.ts))
is the *external* shape — the renderer consumes that. The FSM internal
states map onto it, but we get richer internal state without breaking the
IPC contract.

#### `SiloConfigStore`

Owns the config blob's persistence + the seven update methods:

```ts
class SiloConfigStore {
  constructor(private siloId: string, private store: StoreFacade) {}
  current(): ResolvedSiloConfig;
  async update<K extends keyof Updatable>(field: K, value: Updatable[K]): Promise<void>;
  async persist(): Promise<void>;
}
```

Seven near-identical methods collapse into one parametric `update()`. The
two paths (persist-only vs reconcile-and-restart) become a flag on the
update descriptor or two methods on the manager that consume the result.

#### `MtimeIndex` and `MtimeSink`

The current contract is "reconcile mutates the Map by reference, plus
calls `setMtime`/`deleteMtime` on flush success". We can't replace it with
a return-value patch that only carries upserts — reconcile both adds and
removes mtimes, and the in-memory mutation has to happen *only after* the
flush actually succeeds (otherwise a flush failure would leave the index
diverged from the DB).

The right shape is two pieces:

```ts
/**
 * Narrow write-side interface that reconcile (and the watcher) call into
 * after a successful flush. Each call updates both the in-memory map and
 * the DB; failures are swallowed (DB is the source of truth on next load).
 */
interface MtimeSink {
  indexed(storedKey: string, mtimeMs: number): Promise<void>;
  deleted(storedKey: string): Promise<void>;
  bulkIndexed(entries: Iterable<readonly [string, number]>): Promise<void>;
  bulkDeleted(storedKeys: Iterable<string>): Promise<void>;
}

/**
 * Owner of the in-memory mtime cache. Implements MtimeSink for writers
 * and exposes a read-only view for callers that want size/lookup.
 */
class MtimeIndex implements MtimeSink {
  constructor(private siloId: string, private store: StoreFacade) {}
  async loadFromStore(): Promise<void>;
  get(key: string): number | undefined;
  size(): number;
  asMap(): ReadonlyMap<string, number>;
  /** Convenience for the watcher path: resolve abs path → key, stat, then indexed(). */
  async fromWatcherIndexed(absPath: string, dirs: string[]): Promise<void>;
  async fromWatcherDeleted(absPath: string, dirs: string[]): Promise<void>;
  // MtimeSink methods — store-mediated writes
  indexed(storedKey: string, mtimeMs: number): Promise<void>;
  deleted(storedKey: string): Promise<void>;
  bulkIndexed(entries: Iterable<readonly [string, number]>): Promise<void>;
  bulkDeleted(storedKeys: Iterable<string>): Promise<void>;
}
```

This eliminates the four-pattern smell from pain point #5: every site
goes through `MtimeSink`, ordered after flush success.

`reconcile.ts` is updated to take an `MtimeSink` parameter and call
`sink.indexed(key, mtime)` / `sink.deleted(key)` *only after* the
corresponding batch flush resolves successfully. It no longer accepts —
or mutates — a `Map<string, number>` by reference.

The `reindexFile` path (currently relying on `flush(..., {mtimeMs})` to
update mtime via the upsert) gets an explicit `mtimes.indexed(key,
mtime)` call after `flush` resolves, normalising it with the watcher
path. `flush` continues to accept `mtimeMs` on the upsert (the DB-side
behaviour doesn't change), but the in-memory cache is now updated by a
single canonical call site.

#### `ActivityLog`

```ts
class ActivityLog {
  constructor(private siloId: string, private store: StoreFacade,
              private cap = 200, private logLimit: number) {}
  async loadFromStore(): Promise<void>;
  recent(limit: number): ReadonlyArray<WatcherEvent>;
  append(event: WatcherEvent): void;
  onAppend(listener: (e: WatcherEvent) => void): void;
  // fire-and-forget DB persistence happens inside append()
}
```

Replaces the duplicated 20-line block in `onReconcileEvent` and
`handleWatcherEvent`.

#### `WatcherCoordinator`

```ts
class WatcherCoordinator {
  constructor(deps: {
    config: ResolvedSiloConfig,
    embedding: EmbeddingService,
    storeOps: WatcherStoreOps,
    queue: IndexingQueue,
    state: SiloLifecycleState,
    onProgress: (p: IndexLoopProgress) => void,
    onEvent: (e: WatcherEvent) => void,
  }) {}
  start(): void;
  stop(): Promise<void>;
  /** Cancels any pending queue slot and returns when in-flight indexing is done. */
  drain(): Promise<void>;
}
```

Owns the `pendingWatcherEnqueue` / `cancelWatcherEnqueue` /
`watcherIndexingDone` triple. Owns `scheduleWatcherIndexing`,
`handleWatcherEvent`'s mtime-and-activity side of things (which it delegates
to `MtimeIndex` and `ActivityLog`).

### Caller contract: preserve the 2-step init

[`main/lifecycle.ts:91`](../src/main/lifecycle.ts) currently does:

```ts
manager.loadWaitingStatus();
manager.start().catch(...);
```

This 2-step pattern (mark `'waiting'` synchronously so the UI shows a card
immediately, then kick off async `start()`) is consumed in two places —
`registerManager` and `wake()` itself at
[`silo-manager.ts:549–550`](../src/backend/silo-manager.ts). Don't fold
this into `start()` as part of the refactor: it would be a behaviour
change visible to the renderer (the brief synchronous `'waiting'` paint
would disappear). The new `SiloManager` keeps `loadWaitingStatus()` and
`loadStoppedStatus()` as explicit pre-start status priming methods.

**FSM transitions for the priming methods — both call sites matter.**
`loadWaitingStatus()` is called in *two* situations:

1. From `registerManager` at app boot, on a freshly-constructed
   manager (phase: `'created'`) — transition `created → waiting`.
2. From `wake()` at
   [`silo-manager.ts:549`](../src/backend/silo-manager.ts) on a
   *frozen* (already stopped) manager — transition `stopped →
   waiting`.

Both must be legal in the FSM's transition graph, otherwise waking a
frozen silo throws under validation. Same for `loadStoppedStatus()`,
which is called from `registerManager` (phase: `'created'`) on silos
that were persisted as stopped — transition `created → stopped`.

So the legal entry points into `'waiting'` are: `created → waiting` and
`stopped → waiting`. Into `'stopped'`: `created → stopped` (initial
priming for stopped-on-disk silos) and `<any-running-phase> → stopped`
(via `freeze()`/`stop()` at the end of teardown).

If we ever want to clean up that 2-step contract, file a separate ticket
once the refactor lands and the FSM is in place.

### What stays in `SiloManager` itself

After all collaborators are extracted, the manager's responsibilities are:

1. **Wire the collaborators together** in the constructor.
2. **Sequence `start()` / `stop()` / `freeze()` / `wake()` / `rebuild()`** as
   short methods that call into collaborators in the right order. `doStart`
   becomes 5–7 named phase methods, each ~10–20 lines.
3. **Expose the public API** consumed by `main.ts` and `mcp-server.ts`
   (search, getStatus, getActivityFeed, getConfig, getEmbeddingService,
   exploreDirectories, reindexFile, hasModelMismatch, the update methods).
   Most are one- or two-line delegations to a collaborator.
4. **Surface lifecycle events** to its single registered listener.

Estimate: 200–300 lines.

---

## Phased plan

Each phase is one PR's worth of work. Each phase is **behaviour-preserving**
unless explicitly noted. Each phase ends with passing `npm run typecheck` and
`npm test`.

### Phase 1 — Test harness foundation *(prerequisite, ~1 session)*

Before any restructuring, set up the seam that makes everything else
testable.

1. **Define the `StoreFacade` interface** in a new file
   `src/backend/store-facade.ts`, containing exactly the methods SiloManager
   currently calls on `storeProxy`. Re-export it from `store-proxy.ts` as the
   shape, and provide a default implementation that just delegates to the
   existing `storeProxy.*` functions. No call-site changes yet.

2. **Inject `StoreFacade` into `SiloManager`'s constructor.** Default
   parameter falls back to the proxy implementation, so callers in
   `main.ts` don't need to change. Replace every `storeProxy.X(this.siloId,
   ...)` inside `silo-manager.ts` with `this.store.X(this.siloId, ...)`.
   Pure mechanical rename, no logic change.

3. **Build two `StoreFacade` test implementations**, picked according to
   what the test needs to assert:

   - **`InMemoryStoreFacade`** — backed by
     `createSiloDatabase(':memory:', dims)`. Fast, no disk, ideal for
     isolated collaborator tests (Phase 2 onward) and store-level
     assertions where on-disk size doesn't matter. Lives in
     `src/backend/test-helpers/in-memory-store.ts`.
   - **`TempDirStoreFacade`** — backed by `createSiloDatabase(realPath,
     dims)` against a `mkdtempSync` directory. Required for SiloManager
     **lifecycle** tests because:
     - `freeze()` reads `peekFileCount()` which opens its own
       `better-sqlite3` connection on disk (bypassing the worker)
     - `rebuild()` calls `fs.unlinkSync` on `dbPath`, `dbPath + '-wal'`,
       and `dbPath + '-shm'`
     - `getStatus()` calls `readFileSizeFromDisk()`
     - The cached-file-count behaviour after stop+restart depends on
       reopening the same on-disk DB
     None of those work against `:memory:` — either the assertion is
     impossible or the behaviour is silently absent. Lives in
     `src/backend/test-helpers/tempdir-store.ts`.

   The default production implementation remains the worker-backed
   `store-proxy`. The test facades implement the same `StoreFacade`
   interface synchronously-over-Promise on top of the operations layer —
   no second worker thread.

4. **Add tests for the existing SiloManager behaviour** that we want to
   pin before refactoring. These are written against the *current* manager
   API. **Picking the test backing:**

   | Test | Backing |
   |---|---|
   | `start()` opens DB, writes meta on first run, runs reconcile, ends in `'ready'` | TempDir |
   | `start()` with model mismatch sets `hasModelMismatch()` and `getStatus().modelMismatch` | TempDir |
   | `freeze()` + `wake()` round-trip preserves `cachedFileCount` / `cachedChunkCount` / `cachedSizeBytes` | **TempDir** (uses peekFileCount + on-disk size) |
   | `rebuild()` produces a fresh empty index after returning | **TempDir** (assertion below) |
   | `updateIgnorePatterns()` triggers reconcile and ends in `'ready'` | TempDir |
   | `updateColor()` / `updateIcon()` persist without triggering reconcile | InMemory or TempDir |
   | `getStatus()` returns cached data during `'stopped'` / `'waiting'` / `maintenanceInProgress`, live data otherwise | TempDir |
   | An `'indexed'` watcher event updates mtime and writes activity; `'deleted'` removes mtime | see note ↓ |
   | `updateName(newSlug)` after a successful `start()` — pin current behaviour exactly | TempDir, see note ↓ |

   **Rebuild assertion shape.** `rebuild()` calls `stop()`, deletes the
   DB files, and then `start()` — and `start()` recreates them before
   the promise resolves. So "the DB file is gone" is *not* true at the
   point `rebuild()` returns; asserting it would fail against the
   current behaviour. The regression test instead asserts the
   *post-rebuild* state, which is what users actually care about:

   - `getStatus().chunkCount === 0`
   - `getStatus().indexedFileCount === 0` (mtimes empty for an empty silo)
   - `hasModelMismatch() === false`
   - `getStatus().watcherState` ends in `'ready'`
   - The `meta` row is freshly written (model + dimensions match the
     current config — re-read via the test facade)

   If we ever need to assert the *delete step itself* fired (e.g. to
   pin behaviour against a reordering bug), we add a spy on
   `fs.unlinkSync` for the rebuild case only — but that's a separate
   targeted test, not the high-level regression.

   **Rename behaviour pinning (pain point 7a).** Before any refactor
   touches `updateName()` or `siloId`, write a test that calls
   `manager.updateName(newSlug)` against a started silo and records
   exactly what happens — does the next `getStatus()` succeed? Does the
   `saveConfigBlob` call resolve, throw, or silently fail? Does a
   subsequent watcher event still flush correctly? Whatever the
   *current* outcome is, that's the regression baseline. Phase 3 must
   not change it without a follow-up bugfix ticket. The test should
   tag the assertion with a comment explaining the captured behaviour
   so a future change reviewer understands what they're either
   preserving or deliberately changing.

   **Watcher-event test routing.** `handleWatcherEvent` is private. We
   don't pierce that boundary in the test. Instead, drive the test
   through a controlled `SiloWatcher` test double: construct the
   `SiloManager` with a fake `SiloWatcher` factory (Phase 1 adds a
   constructor seam for this — one extra optional arg) and have the
   fake emit synthetic `WatcherEvent`s into the registered listener.
   This exercises the real `handleWatcherEvent` indirectly via the
   listener `this.watcher.on(...)` registration at
   [silo-manager.ts:864](../src/backend/silo-manager.ts), without
   reaching into private methods.

   Tests use a tiny silo (1–3 files) on a `mkdtempSync` directory, a
   real `IndexingQueue`, and an `EmbeddingService` stub returning
   deterministic constant vectors.

   **Acceptance for Phase 1:** every test above passes against the
   *current* (un-refactored) `SiloManager`. We now have a regression net.

### Phase 2 — Extract `MtimeIndex` and `ActivityLog` *(low risk)*

Pure value classes, no orchestration. Easiest extractions.

1. Create `src/backend/silo/mtime-index.ts` and
   `src/backend/silo/activity-log.ts`.
2. Move all `mtimes`-touching code into `MtimeIndex`. The manager holds a
   `MtimeIndex` field; every previous direct `this.mtimes.set(...)`
   becomes `this.mtimes.indexed(...)`.
3. Update `reconcile()` signature: instead of accepting `mtimes:
   Map<...>` and mutating it by reference, accept an `MtimeSink`
   parameter and call `sink.indexed(key, mtime)` / `sink.deleted(key)`
   *only after* the corresponding flush resolves successfully. A return
   value of `Map<string, number>` would only carry upserts and would
   discard the ordering constraint (mutation must follow flush success);
   the sink models both correctly. The reconcile result type still
   returns `filesAdded` / `filesRemoved` / `filesUpdated` counts for
   logging.
4. Move all `activityLog`-touching code into `ActivityLog`. The duplicated
   blocks in `onReconcileEvent` and `handleWatcherEvent` collapse to
   `this.activity.append(event)`.
5. **Add tests** for both classes in isolation:
   - `mtime-index.test.ts`: load round-trip, indexed/deleted/bulkApply,
     vanished-file (statSync throws) is harmless.
   - `activity-log.test.ts`: cap enforcement, listener fires, DB
     persistence is fire-and-forget (test that an exception inside the
     store doesn't break `append`).

   These are unit tests with the in-memory facade — fast, focused.

**Lines moved:** ~80 from `silo-manager.ts` → ~150 in two new files
(includes JSDoc + tests).

### Phase 3 — Extract `SiloConfigStore` *(low risk)*

1. Create `src/backend/silo/silo-config-store.ts`.
2. Collapse the seven update methods into a parametric `update()`. The
   variants that trigger reconcile return a discriminated value; the
   manager dispatches on it.
3. Move `persistConfigBlob` into the config store.
4. **Add tests:** updates round-trip through the store, validation errors
   are surfaced (e.g. invalid colour rejected), persistence is awaited
   before `update()` resolves.

**Identity constraint (must not regress — see pain point 7a).** The
store-worker keys silos by `siloId` string. Today `siloId === config.name`,
recomputed on every access. There are two viable models for the
extraction:

- **(A) Preserve current behaviour exactly.** `SiloConfigStore` exposes
  `current().name` and the manager keeps recomputing `siloId` from the
  current config. Identity continues to mutate during `updateName()`.
  Whatever the rename Phase 1 regression test pinned (success, throw,
  silent miss) stays pinned. Any fix is a separate ticket.
- **(B) Make `siloId` immutable.** Capture the slug at manager
  construction as a `readonly siloId: string`. `config.name` becomes a
  pure display label, and the store always sees the same key. This is
  arguably the right design but it's a *behaviour change* — it would
  silently fix or change the rename path. Out of scope for this
  refactor.

**Default this refactor to (A).** Pick (B) only as a follow-up bugfix
ticket once the Phase 1 rename test has captured the current behaviour
and we can decide what the right fix is.

**Lines moved:** ~100 → smaller because of de-duplication.

### Phase 4 — Introduce `SiloLifecycle` FSM *(medium risk)*

This phase changes more code paths than 2 or 3, so it needs the full
regression net from Phase 1.

**Critical scoping note.** The current `stopped: boolean` field is doing
*two* jobs: it's both an FSM phase ("the silo is stopped") *and* a
cancellation token ("a stop has been requested; bail at the next yield
point"). The FSM cannot subsume both, because while a `stop()` is
pending, the silo can simultaneously be in phase `'indexing'` *and* have
cancellation requested — the running reconcile has to keep flushing
through to a clean break, which takes a full embedding batch. Compressing
these into one phase would either lose the "indexing happening right now"
information (so `getStatus` would lie) or lose the "stop has been
requested" information (so reconcile wouldn't break out).

Keep the two concerns orthogonal:

```ts
class SiloLifecycle {
  phase(): SiloLifecyclePhase;            // FSM: created | starting | …
  transition(...): void;                  // validated state changes
  onChange(listener): void;
  // Cancellation is separate
  requestStop(): void;
  readonly stopRequested: boolean;        // checked at every yield point
}
```

`reconcile()` and the watcher loop continue to receive a `() =>
boolean` cancellation signal (today it's `() => this.stopped`; after
the refactor, `() => lifecycle.stopRequested`). The Phase 6 pseudocode
still reading `this.stopped` is preserved as
`this.lifecycle.stopRequested`.

When a real `stop()` completes, the FSM transitions to phase
`'stopped'`. Cancellation is the *request*; the phase is the *result*.

Concrete steps:

1. Create `src/backend/silo/silo-lifecycle.ts` containing both the FSM
   and the cancellation token (one class — they share a listener
   callback when stop is requested mid-indexing, so the renderer can
   render a "stopping…" hint via the existing event channel).
2. Define the phase graph (`'created' | 'starting' | 'waiting' |
   'indexing' | 'maintenance' | 'ready' | 'stopped' | 'error'`) and the
   allowed transitions.
3. Replace `_watcherState` and `maintenanceInProgress` with FSM reads
   and `transition()` calls.
4. Replace direct `this.stopped` reads with `this.lifecycle.stopRequested`;
   replace `this.stopped = true` writes with
   `this.lifecycle.requestStop()`.
5. Map FSM phase → external `WatcherState` for IPC. The renderer keeps
   seeing the same shape it does today.
6. **Add tests:** every legal transition succeeds; illegal transitions
   throw; listeners fire exactly once per transition; the
   FSM-phase-to-`WatcherState` mapping is exhaustive; `requestStop()` is
   visible to a `() => stopRequested` callback immediately and survives
   subsequent transitions.

This is the biggest *internal* change but its surface area is contained
because the public `getStatus()` shape doesn't change.

**Caveat:** while doing this we will encounter the question "should `start`
during `'rebuilding'` throw or queue?". The answer should be the *current*
behaviour (whatever the existing code does today). If we discover a real
bug during the audit, file it as a separate ticket and document the
existing behaviour the FSM preserves.

### Phase 5 — Extract `WatcherCoordinator` *(medium risk)*

1. Create `src/backend/silo/watcher-coordinator.ts`.
2. Move `startWatcher`, `handleWatcherEvent`,
   `scheduleWatcherIndexing`, and the
   `pendingWatcherEnqueue`/`cancelWatcherEnqueue`/`watcherIndexingDone`
   triple into the new class.
3. The coordinator is constructed with deps and wired to the FSM — when it
   wants to indicate `'waiting'` or `'indexing'` it calls
   `state.transition(...)`.
4. The manager's `stop()` now calls `watcher.drain()` instead of poking at
   the three coordination fields.
5. **Add tests:** dedup works (two rapid `scheduleWatcherIndexing()` calls
   produce one queue slot); cancel-before-run releases the slot;
   in-flight tasks are awaited by `drain()`; mtime updates happen exactly
   once per indexed event.

This is the most subtle phase because the queue dedup is timing-sensitive.
Use synthetic IndexingQueue, fake watcher, and explicit Promise control to
keep tests deterministic.

### Phase 6 — Refactor `doStart` into named phases *(low risk after 2–5)*

Once collaborators exist, the 148-line `doStart` becomes:

```ts
private async doStart() {
  await this.initEmbedding();         // step 1
  await this.openDatabase();          // step 2
  await this.checkAndPersistMeta();   // step 3
  await this.loadInitialState();      // step 4 (mtimes, activity)
  if (this.stopped) return;
  await this.runStartupReconcile();   // step 5 (was the 70-line closure)
  await this.runWalMaintenance();     // step 5b (checkpoint + optional vacuum)
  await this.config.persist();        // step 6
  if (this.stopped) return;
  this.state.transition('ready');     // step 7
  this.watcherCoord.start();          // step 8
}
```

Each named phase is 10–20 lines and individually testable. The IndexingQueue
closure is gone — `runStartupReconcile` *is* the closure, lifted to a
method.

**Add tests:** the `'stopped'` short-circuit at every yield point honours
the cancellation. (Today this is one of the most subtle behaviours and is
completely untested.)

### Phase 7 — Final pass: trim `SiloManager` to a coordinator *(low risk)*

1. Remove now-redundant private fields and helpers.
2. The remaining public methods are mostly one-line delegations.
3. Update [`silo-manager.test.ts`](../src/backend/silo-manager.test.ts) to
   the post-refactor API. The single existing test still passes (its
   behaviour — embedding-init failure → `'error'` state — is preserved end
   to end).

**Final size estimate:** `silo-manager.ts` 1084 → ~250 lines.

### Phase 8 — Documentation pass

Update CLAUDE.md / project memory if any of the architecture notes have
shifted. (The MEMORY.md note about event-loop starvation during reconcile
is still valid — we haven't moved reconcile to a worker thread, that's a
separate ticket.) Add a one-page module map under `docs/architecture/` (new
folder) describing the SiloManager + collaborators graph.

---

## Test strategy

### What to write tests *for* (high value)

1. **State transitions.** Every legal transition; every illegal transition
   throws. Listeners fire once per change.
2. **Mtime invariants.** After indexed/deleted events, both the in-memory
   index and the DB agree. Crash-and-reload round-trip preserves the
   index.
3. **Status caching correctness.** When the worker is busy
   (`'maintenance'`, `'waiting'`), `getStatus()` returns immediately
   with cached numbers — *and* those numbers came from somewhere
   sensible (not zero, not stale by more than X).
4. **Watcher dedup.** Burst of N file changes during ongoing index
   produces exactly one queued slot. Cancellation works at every yield
   point.
5. **Lifecycle round-trips.** start → stop → start works. freeze → wake
   works. rebuild → start works. Each preserves the appropriate state.
6. **Config update side-effects.** Updates that should trigger reconcile
   do; updates that shouldn't, don't. Persistence is awaited.
7. **Error surfacing.** Embedding init failure / DB open failure / mid-
   reconcile failure all end in `'error'` state with the right message.

### What *not* to test

- Reconcile internals (already covered by the operations tests; testing
  through the manager would just be slow integration noise).
- Search ranking (separate concern, and `store.test.ts` already exercises
  the ranking through SQL).
- Embedding numerical correctness (covered by
  [`embedding-builtin.test.ts`](../src/backend/embedding-builtin.test.ts)).
- File system behaviours of `chokidar` itself.

### Test infrastructure

Reuse the existing
[`store.test.ts`](../src/backend/store.test.ts) style — real schema,
real SQL, no mocked store. Two backings, picked by what the test
asserts:

- **`InMemoryStoreFacade`** — `createSiloDatabase(':memory:', dims)`.
  Use for:
  - Isolated collaborator tests (`MtimeIndex`, `ActivityLog`,
    `SiloConfigStore`, FSM)
  - `SiloManager` tests where on-disk file behaviour is irrelevant
- **`TempDirStoreFacade`** — `mkdtempSync` + on-disk DB. Use for:
  - `freeze()` / `wake()` (touches `peekFileCount`)
  - `rebuild()` (the rebuild path closes and reopens the on-disk DB
    between the unlink and the fresh `start()`; `:memory:` would
    survive the unlink and break the test). Assertion shape is the
    post-rebuild state — empty index, fresh meta — see the Phase 1
    rebuild note.
  - `getStatus()` size assertions (touches `readFileSizeFromDisk`)
  - Any test that closes and reopens the same DB

Other infrastructure:

- Real `IndexingQueue` (it's tiny, deterministic, has no I/O)
- Stub `EmbeddingService` returning constant vectors of `dims` length
- Fake `SiloWatcher` injected via constructor seam for watcher-event
  tests (see Phase 1 step 4)
- `vitest`'s fake timers for debouncing where applicable

**No mocking frameworks.** Seams are `StoreFacade` (interface),
`SiloWatcher` (constructor injection), and `EmbeddingService` (already
constructor-injected). Tests hand in real or stub implementations.

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Behaviour drift during phased extraction | Phase 1 builds the regression net first. No phase merges if those tests fail. |
| `IndexingQueue` test timing fragility | Use vitest fake timers + explicit Promise gates instead of real `setTimeout` |
| `store-proxy` singletons leaking between tests | `StoreFacade` is constructor-injected; the proxy is only used in the production path |
| Discovering a real bug mid-refactor | File a separate ticket. Refactor preserves *current* behaviour, fix lands as its own change with its own test |
| Slowing down feature work for several sessions | Phases are sized to one PR each. Halt between phases if a feature lands; pick up where we left off |
| Renderer/IPC contract changes | The external `WatcherState` and `SiloManagerStatus` shapes don't change. Phase 4's FSM maps to the existing wire format |
| Native deps (better-sqlite3) in `:memory:` | Already proven by `store.test.ts`. Tests run via `npm test` after `npm run native:node` |

---

## Definition of done

For the whole refactor:

- `silo-manager.ts` ≤ 300 lines
- Five collaborators each ≤ 200 lines, each with its own test file
- `silo-manager.test.ts` covers all seven test categories above
- `npm run typecheck` clean
- `npm test` passes
- Manual smoke: open the app, add a silo, watch indexing, freeze/wake,
  rebuild — all behave identically to today
- No new lint warnings; existing eslint config unchanged
- The Phase 1 regression suite still passes against the final code
  (the strongest behaviour-preservation guarantee)

For each individual phase:

- Phase passes the regression suite from Phase 1
- Phase adds its own targeted tests (listed in each phase above)
- Phase ships as a single, reviewable PR
- The phase's commit message links back to this plan

---

---

## Phase 1 — Implementation handover

**Status:** complete. `npm run typecheck` clean. `npm test` shows 7 test
files, 79 tests, all passing — including 11 new regression tests pinning
SiloManager behaviour. No production code path changed observably.

### Files added

| Path | Purpose |
|---|---|
| [`src/backend/store-facade.ts`](../src/backend/store-facade.ts) | `StoreFacade` interface (22 methods, signatures verified by `tsc` against `store-proxy`). Exports `proxyStoreFacade` — the production default that delegates to the existing proxy. |
| [`src/backend/test-helpers/local-store-facade.ts`](../src/backend/test-helpers/local-store-facade.ts) | `LocalStoreFacade` class implementing the interface in-process (mirrors the `store-worker` dispatch synchronously). Exports `createInMemoryStoreFacade()` (forces `:memory:`) and `createTempDirStoreFacade()` (respects the dbPath given). |
| [`src/backend/test-helpers/fake-watcher.ts`](../src/backend/test-helpers/fake-watcher.ts) | `FakeSiloWatcher` implementing `SiloWatcherLike`. Captures the registered handler so tests can `emit(...)` synthetic events into `handleWatcherEvent` (private) without piercing the boundary. |
| [`src/backend/test-helpers/stub-embedding.ts`](../src/backend/test-helpers/stub-embedding.ts) | `createStubEmbedding({dimensions})` — deterministic L2-normalised unit vectors. |
| [`src/backend/silo-manager-regression.test.ts`](../src/backend/silo-manager-regression.test.ts) | 11 regression tests pinning current behaviour. New file alongside the existing `silo-manager.test.ts` (which is preserved unchanged). |

### Files changed

| Path | Change |
|---|---|
| [`src/backend/watcher.ts`](../src/backend/watcher.ts) | Added `SiloWatcherLike` interface, `SiloWatcherFactory` type, `defaultSiloWatcherFactory` constant. `SiloWatcher` now declares `implements SiloWatcherLike`. |
| [`src/backend/silo-manager.ts`](../src/backend/silo-manager.ts) | Two new optional constructor params with production defaults: `store: StoreFacade = proxyStoreFacade` and `watcherFactory: SiloWatcherFactory = defaultSiloWatcherFactory`. The `watcher` field is now `SiloWatcherLike \| null`. All 27 `storeProxy.*` call sites mechanically swapped to `this.store.*`. The single `new SiloWatcher(...)` swapped to `this.watcherFactory(...)`. No callers in `main/lifecycle.ts` or `main/ipc-handlers.ts` were updated — they pick up the production defaults. |

### One small deviation from the plan

The plan named two separate files `in-memory-store.ts` and
`tempdir-store.ts`. In practice, the dispatch logic for all 22 methods
is identical — only `open()` differs in how it picks the path. I
merged into one `local-store-facade.ts` with two factory exports
(`createInMemoryStoreFacade` / `createTempDirStoreFacade`). The
`LocalStoreFacade` constructor takes an optional `dbPathOverride` —
when set, `open()` ignores the path the caller passed. Saves ~150
lines of pure duplication. Naming and intent match the plan.

### Surprises encoded in the regression tests

Two things came up while writing the tests that are worth knowing about:

1. **`setMtime` requires a pre-existing file row.** It's
   `UPDATE files SET mtime_ms = ? WHERE stored_key = ?`
   ([store/operations.ts:288](../src/backend/store/operations.ts)) —
   no `INSERT OR UPDATE`. The watcher's `'indexed'` event in
   production fires *after* `indexFileLoop → flush` has inserted the
   row. The "indexed event refreshes mtime" test had to be set up
   with a file present from start (so reconcile creates the row),
   then `fs.utimesSync` to bump the on-disk mtime, then emit. A
   future `MtimeIndex` (Phase 2) needs to either always go through a
   path that ensures the row exists, or change `setMtime` to upsert.
   Pin behaviour, decide later.

2. **Icon validation silently falls back.** `validateSiloIcon`
   ([silo-appearance.ts:80](../src/shared/silo-appearance.ts))
   returns the default `'database'` for unknown values rather than
   throwing. The first cut of `updateIcon('book')` test failed
   because `'book'` isn't a valid icon name (it's `'book-open'`).
   `SiloConfigStore` extraction (Phase 3) should preserve this
   silent-fallback behaviour or surface the validation as an error
   — separate decision.

### `updateName` rename baseline — confirmed

The test at the bottom of the regression suite confirms that
`updateName(newSlug)` **rejects with the "is not open" error** today.
The store keys silos by slug; the manager mutates `config.name` and
then sends `saveConfigBlob` against the new slug; the store throws
because it has the silo open under the old slug.

This is now a pinned regression. Phase 3 must default to "preserve
this behaviour" (option A in the Identity constraint section). Any
fix is a separate ticket as noted in the out-of-scope list.

### How to pick up Phase 2

The harness is the foundation; Phase 2 is the first real extraction.

1. Read [`src/backend/silo-manager-regression.test.ts`](../src/backend/silo-manager-regression.test.ts) end to end (~10 min). It tells you what behaviour you must not break.
2. Run `npm test` once before changing anything. All 79 tests must pass on a clean checkout.
3. Start with `MtimeIndex`:
   - Create `src/backend/silo/mtime-index.ts` (new folder)
   - Define `MtimeSink` and `MtimeIndex` per the plan's "MtimeIndex and MtimeSink" section
   - Move `silo-manager.ts` mtime-touching code into `MtimeIndex`. The four sites are: `:360` (bulk load), `:672` (reindexFile), `:963/971` (handleWatcherEvent indexed/deleted), and the implicit one in `reconcile.ts:218,251,258` (which gets a new `MtimeSink` parameter).
   - The reconcile signature change is the only cross-cutting bit. Keep it minimal: `reconcile(... mtimes: MtimeSink ...)` instead of `Map<string, number>`.
4. Add unit tests for `MtimeIndex` in isolation (`mtime-index.test.ts`). Use `createInMemoryStoreFacade()` — no on-disk behaviour needed for this collaborator. Cover load round-trip, indexed/deleted/bulk variants, vanished-file robustness.
5. Run the full suite. All 79 existing tests + new MtimeIndex tests must pass. **If a regression test starts failing during Phase 2, that's a flag the change is leaking outside the extraction — pause and reconsider.**
6. Then do `ActivityLog` the same way.

The signs that Phase 2 is going well:
- The regression tests don't need to change
- `silo-manager.ts` shrinks
- Each new collaborator file has its own focused test file
- `tsc` enforces `MtimeSink` as a contract on `reconcile`

The signs that Phase 2 is going badly:
- Regression tests need updating (the change leaked)
- Ad-hoc `if (this.dbOpen)` guards multiplying inside the new collaborators (pull the lifecycle awareness into the manager, not down)
- `MtimeIndex` accumulating fields beyond the index itself (it's a value class — anything else belongs in WatcherCoordinator or SiloManager)

---

---

## Phase 2a — MtimeIndex extraction handover

**Status:** complete. `npm run typecheck` clean. `npm test` shows 8 test
files, 89 tests, all passing — 79 carried forward from Phase 1 plus 10
new for `MtimeIndex` in isolation. The Phase 1 regression suite did not
need a single change, which is the strongest signal that the
extraction is behaviour-preserving.

### Files added

| Path | Purpose |
|---|---|
| [`src/backend/silo/mtime-index.ts`](../src/backend/silo/mtime-index.ts) | `MtimeReader`, `MtimeSink`, `MtimeView` interfaces and the `MtimeIndex` class. Single owner of the in-memory mtime cache + DB write-through. |
| [`src/backend/silo/mtime-index.test.ts`](../src/backend/silo/mtime-index.test.ts) | 10 unit tests for the class in isolation, using the in-memory `LocalStoreFacade`. |

New folder `src/backend/silo/` introduced. Future collaborators
(`activity-log.ts`, `silo-config-store.ts`, `silo-lifecycle.ts`,
`watcher-coordinator.ts`) live here too.

### Files changed

| Path | Change |
|---|---|
| [`src/backend/reconcile.ts`](../src/backend/reconcile.ts) | Signature change: `mtimes: Map<string, number>` → `mtimes: MtimeView`. Two write sites updated: `mtimes.set(...)` → `mtimes.recordIndexed(...)` (after each batch flush in `onBatchFlushed`); `mtimes.delete(...)` → `mtimes.recordDeleted(...)` (after the bulk-delete flush). Reads (`keys()`, `get()`, `has()`) unchanged — `MtimeView` exposes the same Map-like surface. JSDoc updated. |
| [`src/backend/silo-manager.ts`](../src/backend/silo-manager.ts) | `private mtimes = new Map<...>()` → `private readonly mtimes: MtimeIndex` initialised in the constructor body. Bulk load `this.mtimes = await this.store.loadMtimes(...)` → `await this.mtimes.loadFromStore()`. `reindexFile`'s post-flush mtime sync uses `recordIndexed` (in-memory only — flush wrote DB). `handleWatcherEvent` collapses two-step "in-memory + fire-and-forget DB" into single fire-and-forget calls to `mtimes.indexed(...)` / `mtimes.deleted(...)`. Reads (`size`, `clear()`) unchanged. |

### Deviation from the plan

The plan I wrote during Phase 1's review rounds described the sink as
"Each call updates both the in-memory map and the DB". That formulation
turned out to be incompatible with the existing pipeline boundary:
[`pipeline.ts:onBatchFlushed`](../src/backend/pipeline.ts) is a *sync*
callback. Making it async would ripple into every consumer of the
indexing pipeline.

So `MtimeIndex` exposes **two write paths**:

1. **Sync `recordIndexed` / `recordDeleted`** (the `MtimeSink`
   interface) — in-memory only. Used where the caller has already
   arranged for the DB write — reconcile's `onBatchFlushed` callback
   (the flush already persisted via the upsert) and `reindexFile`
   (same).
2. **Async `indexed` / `deleted`** — in-memory + DB write-through.
   Used by `handleWatcherEvent`, which has no flush in flight and
   needs the DB call to happen.

The existing call-site behaviour is preserved exactly: every site
that *was* doing "in-memory + flush-already-wrote-DB" now uses
`record*`, and every site that *was* doing "in-memory + own
`setMtime`/`deleteMtime`" now uses the async pair.

Net effect: the four-pattern smell from pain point #5 collapses to two
patterns, distinguished by whether the caller has already arranged a
DB write. That distinction is now in the type system (sync vs async)
rather than ad-hoc per-site copy-paste.

### What was *not* changed in Phase 2a

- **`updateName` rename baseline.** Still throws "is not open" on the
  next store call after rename — the regression test confirms the
  baseline holds. `MtimeIndex` captures `siloId` at construction; if
  `updateName` is ever fixed to actually rename through the store,
  `MtimeIndex` will need a follow-up.
- **`reconcile`'s `walkDirectory` is still synchronous.** The
  event-loop stall noted in `MEMORY.md` is unchanged. Out of scope.
- **`pipeline.ts:onBatchFlushed` sync contract.** The deviation note
  above documents why this stays sync in Phase 2a. Could be
  re-evaluated in a later phase if multiple callers need async
  flush-completion hooks.

### How to pick up Phase 2b — ActivityLog

Same shape as 2a but smaller. The duplicated 20-line activity-log
blocks are at:

- [`silo-manager.ts:910–929`](../src/backend/silo-manager.ts) inside
  `onReconcileEvent`
- [`silo-manager.ts:933–955`](../src/backend/silo-manager.ts) inside
  `handleWatcherEvent`

Both: push to `this.activityLog`, cap at 200, set `lastUpdated`, fire
`eventListener?.(...)`, fire-and-forget `this.store.logActivity(...)`.

Plan target shape:

```ts
class ActivityLog {
  constructor(private siloId: string, private store: StoreFacade,
              private cap: number, private logLimit: number) {}
  async loadFromStore(): Promise<void>;
  recent(limit: number): ReadonlyArray<WatcherEvent>;
  append(event: WatcherEvent): void;  // sync — does cap + listener + fire-and-forget DB
  setListener(fn: (e: WatcherEvent) => void): void;
}
```

Steps:

1. Create `src/backend/silo/activity-log.ts`. Mostly mechanical given
   the Phase 2a template.
2. Replace the two duplicated blocks in `silo-manager.ts` with single
   `this.activity.append(event)` calls.
3. Move the `loadActivity` bulk read from `doStart` into
   `activity.loadFromStore()`.
4. Add `mtime-index.test.ts`-style unit tests covering: cap
   enforcement, listener fires once per append, listener exception
   doesn't break append, store-write error is swallowed.
5. Run `npm test`. The 11 regression tests in
   `silo-manager-regression.test.ts` must stay green — they exercise
   the activity-feed surface end-to-end.

After Phase 2b lands, the next phase (3 — `SiloConfigStore`) is the
last extraction before the structural rewrites of `doStart` and the
watcher coordinator. By that point `silo-manager.ts` should be down by
roughly 200–300 lines from the starting 1084.

### Things to keep an eye on in Phase 3+

The Phase 2a deviation (sync vs async write paths) sets a precedent:
**collaborator interfaces should respect the existing async boundaries
of the call sites that consume them**, not the other way around. If a
future collaborator needs to fight the boundary, that's a flag the
boundary itself should be re-examined as its own change — not bundled
into the extraction.

---

## Phase 2b — ActivityLog extraction handover

**Status:** complete. `npm run typecheck` clean. `npm test` shows 9 test
files, 103 tests, all passing — 89 carried forward from Phase 2a plus 14
new for `ActivityLog` in isolation. The Phase 1 regression suite (11
tests) did not need a single change, same as Phase 2a — the strongest
signal that the extraction is behaviour-preserving.

`silo-manager.ts` is down from 1084 → 1047 lines. The deduction is
smaller than Phase 2a's because the duplicated activity-log blocks
collapsed into single-line `this.activity.append(...)` calls (the larger
gain shows up as eliminated *duplication*, not just shrinkage).

### Files added

| Path | Purpose |
|---|---|
| [`src/backend/silo/activity-log.ts`](../src/backend/silo/activity-log.ts) | `ActivityLog` class — single owner of the bounded buffer, the listener, `lastUpdated`, and the fire-and-forget DB write. |
| [`src/backend/silo/activity-log.test.ts`](../src/backend/silo/activity-log.test.ts) | 14 unit tests covering reader surface, append behaviour, listener registration + exception handling, store-error robustness, and `loadFromStore` round-trip. |

### Files changed

| Path | Change |
|---|---|
| [`src/backend/silo-manager.ts`](../src/backend/silo-manager.ts) | Three private fields removed (`activityLog: WatcherEvent[]`, `eventListener?`, `lastUpdated: Date \| null`) and replaced with a single `private readonly activity: ActivityLog` initialised in the constructor. `onEvent`, `getActivityFeed`, and the two `getStatus` `lastUpdated` reads delegate to `activity`. The two duplicated 20-line blocks in `onReconcileEvent` and `handleWatcherEvent` collapsed to single `this.activity.append(...)` calls. The `loadActivity` block in `doStart` step 4b shrank to one `await this.activity.loadFromStore()`. |

### One deliberate scope deviation: dropping the `dbOpen` gate

The pre-refactor code had `if (this.dbOpen) { store.logActivity(...) }`
inside both duplicated blocks. The plan flagged a question — preserve
the gate (option A) or drop it (option B)?

**Investigation showed the gate is dead code under the current
teardown ordering.** The full call-graph trace:

- `onReconcileEvent` fires only inside `reconcile()`, which is awaited
  inline inside `doStart` after `dbOpen = true` at
  [`silo-manager.ts:356`](../src/backend/silo-manager.ts).
- `handleWatcherEvent` fires only when `SiloWatcher.runQueue()` calls
  `emit()`. `runQueue()` is invoked exclusively from the IndexingQueue
  task at [`silo-manager.ts:974`](../src/backend/silo-manager.ts),
  gated by `if (this.watcher && !this.stopped)` at
  [`:973`](../src/backend/silo-manager.ts).
- `stop()` sets `this.stopped = true` *first*
  ([`:488`](../src/backend/silo-manager.ts)), then awaits
  `startPromise` and `watcherIndexingDone` (drains in-flight reconcile
  / `runQueue`), then awaits `watcher.stop()` (chokidar close, no
  more native emissions), then sets `dbOpen = false`
  ([`:526`](../src/backend/silo-manager.ts)) *last*.

So between "any emitter could still reach this code" and "dbOpen
flips to false", every emitter is awaited. The gate cannot evaluate
to false in practice.

The new `ActivityLog` therefore has no lifecycle awareness — the
collaborator is a clean value class, no `dbOpen` knowledge needed. If
a future `stop()` reorder ever broke the invariant, the worker's
"is not open" rejection is swallowed by `.catch(() => undefined)` —
same observable outcome as the old gate (silent no-op).

This is a deliberate deviation from the plan's "preserve current
behaviour" discipline. Justified because the "behaviour" we'd be
preserving was not actually reachable.

### One small hardening: listener exceptions are caught

The plan's test list called for "listener exception doesn't break
append". The pre-refactor code did *not* catch listener throws — they
would have propagated up through `chokidar`'s emit or `reconcile`'s
event callback. The production listener
([`main/activity.ts:19`](../src/main/activity.ts), forwarding to the
renderer) doesn't throw, so this is observably a no-op in production.
But the new collaborator catches and logs them, hardening against any
future listener that might.

If you do want to investigate the rename baseline (pain point 7a) or
move toward (B) immutable-`siloId` later, the `ActivityLog`
implementation captures `siloId` at construction the same way
`MtimeIndex` does — the rename baseline still throws "is not open" on
the next store call, just as Phase 1 pinned it.

### Things to keep an eye on in Phase 3+

The Phase 2b deviation sets a precedent worth being explicit about:
**before defaulting to "preserve current behaviour", verify the
behaviour is reachable.** Refactor discipline is meant to prevent
silent change, not to enshrine dead code. When extracting a
collaborator, trace the call graph for any defensive guard the
previous code held — if the scenario can't occur, the new collaborator
should be cleaner without it. (If it *can* occur, then yes, preserve
and ticket — the original discipline applies.)

The same reasoning will likely come up in Phase 3 (`SiloConfigStore`)
around the seven update methods — check whether each `validate*`
fallback is reachable, whether each `persistConfigBlob` ordering
constraint can race, before propagating the existing patterns into
the new class.

### How to pick up Phase 3 — SiloConfigStore

Same shape as the previous extractions, but the surface is wider —
seven update methods plus `persistConfigBlob`. The plan's
"Identity constraint" note (default to option A — preserve mutable
`siloId === config.name`) still stands; the Phase 1 rename regression
test will keep it honest.

Steps:

1. Read the seven `update*` methods end to end —
   [`updateModel` at silo-manager.ts:175](../src/backend/silo-manager.ts)
   through `updateIcon` at `:312`, with `updateColor`/`updateIcon` at
   `:303–312` separated from the rest by the `persistConfigBlob`
   helper. Note the two paths: persist-only
   (`updateModel`/`updateDescription`/`updateName`/`updateColor`/
   `updateIcon`) vs reconcile-and-restart
   (`updateIgnorePatterns`/`updateExtensions`/`rescan`).
2. Create `src/backend/silo/silo-config-store.ts` with the parametric
   `update<K>(field, value)` method described in the plan. Two
   options for the persist-vs-reconcile branching:
   - Return a discriminated `UpdateResult` from `update()` and let
     the manager dispatch.
   - Have two methods on the store (`updateAndPersist`,
     `updateAndReconcile`) that the manager calls explicitly.
   The first is cleaner; the second is more explicit. Pick after
   sketching one.
3. Add unit tests for the config store in isolation — validation
   round-trips (preserve `validateSiloIcon` silent-fallback per the
   Phase 1 surprise), persistence is awaited, the rename baseline
   is *not* changed by the extraction.
4. Run the full suite. Phase 1 regression tests must stay green
   (especially the rename test, which exercises this exact code path).
   If a regression test starts failing, pause and reconsider — same
   discipline as Phase 2.

After Phase 3, `silo-manager.ts` should be roughly 800–900 lines —
more headroom than 2a/2b because seven methods collapse into a
parametric one. After that, Phase 4 (FSM) is the largest *internal*
shift and benefits from the regression net being maximally
populated.

---

---

## Phase 3 — SiloConfigStore extraction handover

**Status:** complete. `npm run typecheck` clean. `npm test` shows 10 test
files, 123 tests, all passing — 103 carried forward from Phase 2b plus
20 new for `SiloConfigStore` in isolation. The Phase 1 regression suite
(11 tests) did not need a single change, including the rename baseline,
which is the strongest signal that the extraction is behaviour-
preserving.

`silo-manager.ts` is down from 1047 → 1037 lines. The deduction is
modest because the persist-only `update*` methods kept their public
shape (and most of them are now 2-line stubs); the *real* win is
structural — every config mutation now flows through one collaborator
with a single, parametric `apply` surface, and the `persistConfigBlob`
blob-construction logic moved out of the manager entirely.

### Files added

| Path | Purpose |
|---|---|
| [`src/backend/silo/silo-config-store.ts`](../src/backend/silo/silo-config-store.ts) | `SiloConfigStore` class + `ConfigPatch` interface. Single owner of the live `ResolvedSiloConfig` and the per-silo config blob persistence. |
| [`src/backend/silo/silo-config-store.test.ts`](../src/backend/silo/silo-config-store.test.ts) | 20 unit tests covering reader surface, `apply` (validation + multi-field + auto-persist regression), `persist` (blob shape, empty-description coercion, canPersist gate, rename baseline), and store-error propagation. |

### Files changed

| Path | Change |
|---|---|
| [`src/backend/silo-manager.ts`](../src/backend/silo-manager.ts) | `private config: ResolvedSiloConfig` (parameter property) → `private readonly configStore: SiloConfigStore` initialised in the constructor body. `private get config()` getter delegates to `configStore.current`. `private get siloId()` delegates to `configStore.siloId`. The seven `update*` methods reduced to `apply` + `persist` / `apply` + `reconcileAndRestartWatcher` two-liners (or three-liners where pre/post logic stays — `updateModel`'s mismatch check). The 14-line `persistConfigBlob` private helper deleted; its three call sites swapped to `this.configStore.persist()`. Imports of `validateSiloColor` / `validateSiloIcon` / `StoredSiloConfig` removed (now consumed only by the collaborator). |

### Design decision: parametric `apply` over per-field setters

The plan offered two shapes for the persist-vs-reconcile branching:

  - (1) Discriminated `UpdateResult` returned from a single `update()`
    method, manager dispatches.
  - (2) Two methods on the store (`updateAndPersist`,
    `updateAndReconcile`) that the manager calls explicitly.

Sketching both showed a third option that fit better: a single
`apply(patch: ConfigPatch)` for *in-memory* mutation plus an explicit
`persist()`. The manager composes them per-method.

  - **Persist-only paths** (`updateModel` / `updateDescription` /
    `updateName` / `updateColor` / `updateIcon`): manager calls
    `configStore.apply({ ... })` then `await configStore.persist()`.
    `updateModel` keeps its meta-mismatch check between those two
    calls, where it lived before.
  - **Reconcile-required paths** (`updateIgnorePatterns` /
    `updateExtensions`): manager calls `configStore.apply({ ... })`
    then `await this.reconcileAndRestartWatcher(reason)`. The
    helper itself calls `configStore.persist()` once reconcile
    finishes — same ordering as before.

Validation lives inside `apply` (color/icon dispatch through
`validateSiloColor` / `validateSiloIcon`), so no caller has to remember
to validate. Other fields pass through verbatim. The unit tests pin
both behaviours.

This shape ended up the clear winner because it (a) preserves
`updateModel`'s pre/post-mutation orchestration without contortion,
(b) keeps validation in one place, and (c) leaves the manager's public
API identical, which kept the regression suite untouched.

### Behaviour notes pinned by the new tests

Three pre-refactor surprises that the `SiloConfigStore` tests now
explicitly preserve:

1. **Empty `description` becomes `undefined` in the persisted blob.**
   The pre-refactor code used `description: this.config.description ||
   undefined`, so the empty string never round-tripped through the
   stored JSON. Pinned in the persist test.

2. **`validateSiloColor` / `validateSiloIcon` silently fall back to
   the defaults** for unknown values rather than throwing. Pinned in
   the apply tests for both colour and icon. (This is the surprise
   that bit the Phase 1 regression suite when `'book'` was used
   instead of `'book-open'`.)

3. **`persist()` writes the blob against `current.name`, not against
   a captured-at-construction id.** The store still has the silo open
   under the *old* slug after `apply({ name: 'new' })`, so the next
   `persist()` triggers the "is not open" rejection that the Phase 1
   rename baseline pins. The unit-level test asserts the call shape
   (`saveConfigBlob('new-slug', ...)`) without needing a live store —
   the manager-level regression test exercises the actual rejection.

### What was *not* changed in Phase 3

- **The rename baseline** (pain point 7a). `siloId` continues to track
  `current.name` live; the regression test still confirms `updateName`
  rejects with "is not open" today. Option (B) — immutable `siloId`
  independent of `config.name` — remains out of scope per the plan.
- **`reconcileAndRestartWatcher` itself.** The helper was already
  invoking `persistConfigBlob` after reconcile; it now invokes
  `configStore.persist()` instead. Same ordering, same behaviour.
- **Public manager API.** Every external caller (`main/lifecycle.ts`,
  `main/ipc-handlers.ts`, `mcp-server.ts`) still sees the same
  `updateX(...)` method signatures. No call sites updated.

### How to pick up Phase 4 — SiloLifecycle FSM

Phase 4 is the biggest *internal* change of the refactor (the plan
flagged it as medium risk for that reason). The Phase 1 regression
suite + the three collaborator unit suites give the strongest
behaviour-preservation net the refactor will have until the FSM tests
themselves land.

Critical scoping reminder from the plan: **`stopped: boolean` is doing
two jobs** — phase indicator *and* cancellation token — and the FSM
cannot subsume both. Keep them orthogonal: `lifecycle.phase()` for the
FSM, `lifecycle.requestStop()` / `lifecycle.stopRequested` for the
cancellation signal. Reconcile and the watcher loop continue to take
`() => boolean` cancellation callbacks, just plumbed through the new
class.

Steps:

1. Re-read the plan's "Phase 4 — Introduce `SiloLifecycle` FSM"
   section end to end. The phase graph and the explicit transitions
   list (`created → waiting`, `stopped → waiting`, `created →
   stopped`, `<any-running-phase> → stopped`) are load-bearing — get
   them wrong and waking a frozen silo throws under transition
   validation.
2. Create `src/backend/silo/silo-lifecycle.ts`. One class containing
   both the FSM and the cancellation token (they share a listener
   path when stop is requested mid-indexing).
3. Replace `_watcherState` and `maintenanceInProgress` with FSM reads
   and `transition()` calls. Replace direct `this.stopped` reads with
   `this.lifecycle.stopRequested`; replace `this.stopped = true`
   writes with `this.lifecycle.requestStop()`.
4. Map FSM phase → external `WatcherState` for IPC. The renderer
   keeps seeing the same shape it does today.
5. Add unit tests covering: every legal transition succeeds; illegal
   transitions throw; listeners fire exactly once per transition;
   the FSM-phase-to-`WatcherState` mapping is exhaustive;
   `requestStop()` is visible to a `() => stopRequested` callback
   immediately and survives subsequent transitions.
6. Run the full suite. The 11 Phase 1 regression tests *and* the
   collaborator suites for `MtimeIndex`, `ActivityLog`, and
   `SiloConfigStore` must all stay green.

Signs Phase 4 is going well:
- Regression tests don't need to change.
- `silo-manager.ts` shrinks further as state-bag fields collapse into
  the FSM.
- The FSM unit tests catch any phase-graph mistakes before they reach
  the manager.

Signs Phase 4 is going badly:
- A regression test starts failing — the change is leaking outside the
  extraction. Pause and audit.
- Adding ad-hoc `if (this.lifecycle.phase() === 'X')` guards
  everywhere in the manager — that's the boolean tangle reasserting
  itself in a different syntax. Push the lifecycle awareness *into*
  the FSM (e.g. via `transition('foo')` validation) rather than
  spreading it back across the coordinator.

After Phase 4, the manager's state is finally explicit and testable
in isolation. Phases 5–7 (`WatcherCoordinator`, `doStart` named
phases, final trim) become smaller mechanical steps because the
state-machine seam removes most of the remaining tangle.

---

## Out of scope (named explicitly)

These came up during the audit but belong in their own work, not this
refactor:

- Moving `walkDirectory` / reconcile to a worker thread to fix the
  event-loop stall noted in `MEMORY.md`. Separate ticket.
- The discriminated-union schema for `registerEditTool` in
  [`mcp/tools-edit.ts`](../src/backend/mcp/tools-edit.ts). Separate ticket
  (high value, low risk, smaller scope).
- The `detectLineEnding` leak from `edit.ts` into
  [`mcp/tools-search.ts:13`](../src/backend/mcp/tools-search.ts). Trivial
  one-liner — fix opportunistically next time `tools-search.ts` is
  touched.
- The `MODE_SIGNALS` map in `search.ts` becoming an injected registry.
  Already well-factored; tests are higher value than restructuring there.
- Adding a top-level `architecture.md` for the whole backend. Phase 8
  produces a SiloManager-scoped doc; a wider one can follow if useful.
- Making `siloId` immutable (independent of `config.name`). See pain
  point 7a and the Phase 3 "Identity constraint" note. The Phase 1
  regression test captures current rename behaviour; if that test
  reveals a real bug, file a follow-up bugfix with its own design
  decision (rename through worker close+reopen, vs. immutable id, vs.
  something else). Bundling that into this refactor would conflate
  behaviour change with structural change.
