# Follow-ups from the SiloManager refactor

Stuff noticed during the audit and refactor (Phases 1–8 of
[`silo-manager-refactor-plan.md`](silo-manager-refactor-plan.md)) that
was deliberately *not* bundled into the refactor itself. Some are real
tickets; some are opportunistic one-liners; some are
"considered and rejected" notes for the next person who's tempted.

Use this as the working list. The plan body has the full reasoning;
links into it are inline below.

---

## 1. SiloManager trim candidates

The line-target component of the Definition-of-Done (≤300 lines) was
not met — `silo-manager.ts` is 857 lines after Phase 8. Two candidates
remain.

### #2 — `StatusReporter` / `StatusCache` extraction

**Status:** open, modest risk.
**Yield:** ~50–70 lines off `silo-manager.ts`.

Move `cachedFileCount` / `cachedChunkCount` / `cachedSizeBytes`
(written across `freeze`, `rebuild`, and `runStartupReconcile`'s
closure), `getStatus`'s cache-gating, and the `readFileSizeFromDisk`
helper into a small `silo/status-reporter.ts` (or `status-cache.ts`)
collaborator alongside the others.

**Load-bearing constraint — preserve through the extraction:** the
cache-fill in `runStartupReconcile` happens *before* the
`'maintenance'` transition, and `getStatus`'s cache gate reads
`phase === 'maintenance'`. If the extraction reorders these, the gate
reads stale (zero) values during the maintenance window. The Phase 1
regression suite has a test pinning the cached-counts behaviour
through `freeze` + `wake`; that's the canary.

How to start: model the collaborator on `MtimeIndex` (in-memory fields
+ a few async writes through `StoreFacade`). The `phase` read in
`getStatus` should move with the gate. See the architecture doc's
[load-bearing details
section](architecture/silo-manager.md#load-bearing-details-preserve-through-future-changes)
for the full invariant list.

### #3 — `runReconcileInQueue` private helper

**Status:** considered & deferred.
**Yield:** ~12 lines of de-duplication.

`runStartupReconcile` and `reconcileAndRestartWatcher` share an
`IndexingQueue` enqueue + reconcile + change-log skeleton; their
closure bodies diverge in the middle (one runs WAL maintenance, the
other restarts the watcher). A continuation-passing helper could
factor the skeleton.

Phases 6 and 7 each audited this and concluded the abstraction
overhead exceeds the savings. Revisit only if #2 lands and the manager
is within sight of the line target.

---

## 2. Behaviour issues (real, not yet bugs)

These are hazards or smells noticed during the audit. Each warrants
its own ticket *if* it surfaces in the wild — bundling them into the
refactor would have conflated behaviour change with structural change.

### Mid-reconcile error overwrite

When reconcile throws inside `doStart`'s queue task, the catch
transitions the lifecycle to `'error'`, but `doStart` then proceeds
and unconditionally transitions to `'ready'`, overwriting the error.
The renderer never sees the failure surfaced.

**File a renderer-error-surfacing ticket if this is observed in the
wild.** Likely fix: `doStart` checks the lifecycle phase before the
final `transition('ready')` and bails if it's `'error'`. Add a
regression test that throws from the reconcile-in-queue path and
asserts the final phase is `'error'`.

### Identity rename hazard (pain point 7a)

`siloId === config.name`, recomputed on every access. `updateName()`
mutates `config.name`; the store-worker has the silo open under the
*old* slug. The Phase 1 regression test
([`silo-manager-regression.test.ts`](../src/backend/silo-manager-regression.test.ts))
captures the current rename behaviour as the baseline.

If a real user-visible bug surfaces, file a follow-up with its own
design decision: **rename-through-worker-close+reopen** vs.
**immutable `siloId` independent of `config.name`** vs. something
else. The Phase 3 "Identity constraint" note in the plan body has
the full options analysis.

### Reconcile event-loop starvation

Long reconciles block the main thread (noted in `MEMORY.md`). The
fix is to move `walkDirectory` / reconcile to a worker thread. Out of
scope for the SiloManager refactor — this is a parallel concern that
touches `reconcile.ts`, the worker boundary, and the cancellation
contract.

---

## 3. Adjacent code (noticed during audit)

### MCP `registerEditTool` discriminated-union schema

[`src/backend/mcp/tools-edit.ts`](../src/backend/mcp/tools-edit.ts)
currently has a wide schema for the edit tool. A discriminated-union
schema (per-mode) would be higher-fidelity validation and better DX
for tool callers. **High value, low risk, smaller scope** — would
make a clean standalone ticket.

### `detectLineEnding` leak

[`src/backend/mcp/tools-search.ts:12`](../src/backend/mcp/tools-search.ts)
imports `detectLineEnding` from `../edit`, where it's an internal
helper of the edit machinery. Trivial one-line fix: extract
`detectLineEnding` into a shared util module, or move it to a
neutral location. **Fix opportunistically next time
`tools-search.ts` is touched.** Doesn't deserve its own session.

### `MODE_SIGNALS` registry — *considered and rejected*

The audit looked at making the `MODE_SIGNALS` map in
[`src/backend/search.ts`](../src/backend/search.ts) an injected
registry rather than a static const. Verdict: already well-factored;
adding a registry would be ceremony without tangible benefit. Tests
covering the modes are higher value than restructuring. **Don't
pursue unless a concrete need (per-silo modes, runtime
configuration, etc.) appears.**

---

## 4. Documentation

### Top-level backend `architecture.md`

Phase 8 produced a SiloManager-scoped module map at
[`docs/architecture/silo-manager.md`](architecture/silo-manager.md).
A wider top-level backend architecture doc — covering the
main-process / worker-process split, the embedding service, the
indexing pipeline, IPC contract — would be useful but is its own
piece of work. **Open.**

---

## Quick reference

| Item | Type | Effort | Risk | Priority |
|---|---|---|---|---|
| `StatusReporter` extraction | Trim | Small | Modest | Optional — only if pushing line target |
| `runReconcileInQueue` helper | Trim | Tiny | Low | Deferred (audited, not worth it now) |
| Mid-reconcile error overwrite | Bugfix | Small | Low | When/if it surfaces |
| Identity rename hazard | Bugfix | Medium | Medium | When/if it surfaces |
| Reconcile event-loop starvation | Perf | Large | Medium | Separate workstream |
| MCP edit-tool union schema | Refactor | Small | Low | Standalone ticket |
| `detectLineEnding` leak | Cleanup | Trivial | None | Opportunistic |
| `MODE_SIGNALS` registry | — | — | — | Rejected |
| Top-level backend doc | Doc | Medium | None | Open |
