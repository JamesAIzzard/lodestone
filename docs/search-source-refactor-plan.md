# SearchSource Refactor Plan

Status: draft · Branch: `develop` · Last updated: 2026-06-20

## Goal

Decouple search dispatch from the concrete `SiloManager` so additional search sources can
participate in unified (all-silo) search. A **behaviour-preserving** refactor: no functional
change, no new feature — just an interface seam where today there's a hard type.

Pulled out of the [Workflowy integration plan](workflowy-integration-plan.md) so it lands as an
isolated, easily-reviewed change. That feature's first non-`SiloManager` search source then
simply *implements the interface* rather than carrying this refactor in its diff.

## Motivation

The search dispatch path is hard-typed to `SiloManager` in four places, so nothing that isn't a
`SiloManager` can join unified search:

- `AppContext.siloManagers: Map<string, SiloManager>` — `src/main/context.ts:21`
- `dispatchSearch(params, managers: Iterable<[string, SiloManager]>, …)` — `src/backend/search-merge.ts:34`
- call sites build `searchable` from `siloManagers` filtered on `m.getEmbeddingService()` —
  `src/main/internal-api.ts:253`, `src/main/ipc-handlers.ts:160`

## Scope

Introduce the **minimal** surface `dispatchSearch` actually uses:

```ts
// src/backend/search-source.ts
export interface SearchSource {
  // matches + optional per-search notices (e.g. "results may be stale")
  search(queryVector: number[], params: SearchParams): Promise<{ results: FileResult[]; warnings?: string[] }>;
  getEmbeddingService(): EmbeddingService | null;   // null → filtered out for embed modes
  readonly currentState: WatcherState;              // readiness + "indexing" warnings
}
```

The `warnings` channel is part of the boundary on purpose: today the "indexing" notices are
assembled *outside* managers in `internal-api.ts` while `SiloManager.search()` returns bare
results, so a source has no way to flag (e.g.) stale data. Baking it into the contract now means
the first added source (Workflowy) can surface notices without re-cutting the dispatch path.

Then:
- `SiloManager` already has `getEmbeddingService`/`currentState` (`silo-manager.ts:665/553`); its
  `search` (`silo-manager.ts:558`) returns a bare `FileResult[]`, so wrap it to return
  `{ results, warnings: [] }` — a one-line change — and declare `implements SearchSource`.
- Re-type `dispatchSearch`'s `managers` param to `Iterable<[string, SearchSource]>`, and have it
  **aggregate per-source `warnings`** alongside results, returning `{ results, warnings }`.
- The two call sites pass `siloManagers` unchanged and merge the dispatcher's `warnings` into the
  `warnings[]` they already assemble (today's silo "indexing" notices). No-op in practice —
  `SiloManager` emits none — so behaviour is identical.

## Deliberately out of scope

- **`AppContext.siloManagers` stays `Map<string, SiloManager>`.** Only the *dispatch* typing
  changes. Watcher / explore / status code keeps its concrete type.
- **No result-*element* generalization.** The `warnings` channel is added (above), but the
  result element stays file-shaped — `FileResult`/`SiloSearchResult`/`mergeSearchResults`
  untouched. Generalizing results to carry a source `kind` is a consumer concern, deferred to
  the feature that needs it (Workflowy Phase 1).
- **No explore changes.** `SearchSource` omits explore; `dispatchExplore` stays
  `SiloManager`-typed (directory exploration has no general analog).
- **No new search source.** This refactor adds the seam only.

## Acceptance

- `npm run typecheck` clean.
- Full `vitest` suite green with no test changes — the bar is *zero behaviour change*.
- Diff is essentially: one new interface file, the `implements` annotation, a one-line `search`
  wrap to the `{ results, warnings }` envelope, the dispatcher aggregating + returning warnings,
  and the two call sites merging them. Outputs unchanged.

## Risk

Low — almost entirely typing; the one runtime addition is threading a (for silos, empty)
`warnings` array through dispatch. The judgement call is keeping the interface minimal (three
members + the warnings envelope) rather than over-abstracting; resist adding anything
`dispatchSearch` doesn't call.
