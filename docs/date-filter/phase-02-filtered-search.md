# Phase 2: Filtered Search

Status: ready · Depends on: phase 1 · Unblocks: phase 3

## Goal

`SearchParams` accepts `dateFromMs` and `dateToMs`, every signal honours them before candidate
selection, and every result carries `dateMs`. The window is expressed in epoch milliseconds
only; string parsing is phase 3. After this phase the IPC path from the renderer already works
if the renderer sends the fields, because `silos:search` passes `SearchParams` straight through,
but no client sends them yet.

## Changes

`src/shared/types.ts`
- `SearchParams`: add `dateFromMs?: number` and `dateToMs?: number`, both inclusive.
- `SearchResult`: add `dateMs: number | null`.

`src/backend/search.ts`
- `FileResult`: add `dateMs: number | null`.
- Copy the two bounds into `SignalContext`.
- After sort and truncation, run one query
  `SELECT stored_key, date_ms FROM files WHERE stored_key IN (...)` for the surviving keys and
  fill `dateMs`. Use a temp table or a placeholder list; the count is at most `maxResults`,
  which the tool caps at 50.

`src/backend/scorers/signal.ts`
- `SignalContext`: add `dateFromMs?: number` and `dateToMs?: number`.
- Add `passesFileFilters(ctx, storedKey, dateMs: number | null): boolean`. It returns false
  when `startPath` is set and the key does not start with it, when `filePatternRe` is set and
  does not match the relative path, or when either bound is set and `dateMs` is null or outside
  the window. Every signal calls this and nothing else for filtering.

`src/backend/store/types.ts` and `src/backend/store/operations.ts`
- `ChunkMeta`: add `date_ms: number | null`. `fetchChunkMeta` selects `f.date_ms`.

`src/backend/scorers/semantic-signal.ts`
- When either bound is set, use the KNN statement from [design.md](design.md#selection) with the
  `rowid IN (subquery)` constraint, binding the missing bound to `-Infinity` or `+Infinity`
  equivalents (`-1e18`, `1e18`) rather than building two statement variants. When neither is
  set, keep today's statement exactly.
- Replace the two inline filter lines with `passesFileFilters(ctx, meta.stored_key, meta.date_ms)`.
  Path and pattern still post-filter; the date is already applied by the query, and the
  predicate re-checking it is harmless.

`src/backend/scorers/bm25-signal.ts`, `filepath-signal.ts`, `regex-signal.ts`
- Replace the inline filter lines with `passesFileFilters`. The filepath and regex full scans
  select `date_ms` alongside `stored_key`; the regex chunk scan selects `f.date_ms` in its join.

`src/backend/silo-manager.ts`
- `search()`: copy `dateMs` from each `FileResult` onto the `SearchResult` it builds, next to
  `filePath` and `siloName`. Bounds pass through untouched, as `filePattern` does.

## Tests

`src/backend/scorers/signal.test.ts` (new)
- `passesFileFilters` truth table: each filter alone, combined, null date with and without
  bounds, bounds equal to the date (inclusive on both ends).

`src/backend/store.test.ts` or a new `src/backend/search-date.test.ts` using a real database
- Build a silo with twenty single-chunk files whose embeddings are arranged so that one file,
  `in-window.md`, has the lowest similarity to a fixed query vector, and give only that file a
  `date_ms` inside the window. Search in `semantic` mode with `limit: 1` and the window set.
  The result must be `in-window.md`. This is the starvation test; it fails against a post-filter
  because `k = 5` never reaches the twentieth chunk.
- The same silo, same query, no bounds: the result set and order equal a snapshot taken before
  the semantic signal was touched. Repeat for `hybrid` mode with a query that hits BM25.
- `bm25` mode with a window returns only in-window files and the same scores those files had
  without the window.
- `filepath` and `regex` modes with a window exclude out-of-window files.
- A file with `date_ms` null is excluded when any bound is set and included when none is.
- Every result has `dateMs` equal to the row's `date_ms`.
- `dateFromMs` alone and `dateToMs` alone each behave as half-open windows.

`src/backend/search.test.ts`
- The existing mocked-signal tests still pass. Add one asserting that bounds on `SearchParams`
  reach `SignalContext`.

## Done when

- All tests above pass and `npm run typecheck` is clean.
- The starvation test passes using the `rowid IN` constraint. If it cannot be made to pass on
  the bundled sqlite-vec, stop, record what the extension returned in this doc, and implement
  the widening-`k` fallback described in the design before continuing.
- Running the app from source and searching without bounds behaves as before.

## Out of scope

String parsing of bounds, the MCP tool, the guide text, and anything in the renderer.
