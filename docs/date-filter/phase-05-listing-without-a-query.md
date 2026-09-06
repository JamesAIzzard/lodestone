# Phase 5: Listing Without a Query

Status: ready · Depends on: phase 4

## Goal

A search with no query and at least one of `since`/`until` returns every file in the window,
newest first, with the total count. A client can then answer "what mail arrived on Tuesday" or
"which files changed this week" without inventing a query to rank against. Ranked search is
untouched: a blank query never enters the signal pipeline, and a query never enters the listing
path.

The listing is a separate per-silo store call over the `files` table, ordered by the phase 1
index. It is not a fifth signal. It needs no embedding, so it works while a silo's model is still
loading, and it must report how many files matched, because a client asked for "all the mail in
August" will otherwise report the cap as the answer.

## Semantics

These restate [design.md](design.md#listing-without-a-query). Fix the design if they drift.

- Blank means undefined or whitespace only, in both clients.
- A blank query with no bound is an error:
  `Provide a query, or set since or until to list every file in a date window.`
- The window, `startPath` and `filePattern` filter exactly as they do for a search, through the
  same predicate. Files with a null date are excluded, as for any bounded search.
- Order is `date_ms` descending, ties broken by `stored_key` ascending. Across silos, `dateMs`
  descending, then silo name, then path.
- Each result carries `score: 1`, `scoreLabel: 'date'`, `signals: { date: 1 }`, `dateMs`, no
  hint and no chunks. `'date'` is a marker, not a score. Both formatters omit the score for it.
- `total` is the number of files passing the filters, before `maxResults` and `offset`.
- `offset` (integer, minimum 0, default 0) pages a listing. Passing it with a query is an error:
  `offset applies only when listing without a query.`
- `mode` and `regexFlags` are ignored for a listing. The tool description says so.
- `silo` takes the same names, `s` references and arrays as a search, resolved by the phase 4
  helper before the listing runs. A listing result line shows the silo reference as a search
  result does.

## Changes

`src/shared/types.ts`
- `ListingParams`: `startPath?`, `filePattern?`, `dateFromMs?`, `dateToMs?`, `limit?` (default
  10), `offset?` (default 0). No `query`, no `mode`.
- `SearchResult.scoreLabel` comment: add `'date'` for listing results.

`src/backend/scorers/signal.ts`
- `FileFilters = Pick<SignalContext, 'startPath' | 'filePatternRe' | 'dateFromMs' | 'dateToMs'>`
  and `passesFileFilters(filters: FileFilters, storedKey, dateMs)`. Existing callers pass `ctx`
  unchanged; structural typing covers them.

`src/backend/search-listing.ts` (new)
- `ListingResult { results: FileResult[]; total: number }`.
- `listByDate(db, params: ListingParams): ListingResult`. One statement:

  ```sql
  SELECT stored_key, date_ms FROM files
  WHERE date_ms IS NOT NULL AND date_ms >= ? AND date_ms <= ?
  ORDER BY date_ms DESC, stored_key ASC
  ```

  Bind `-1e18` and `1e18` for a missing bound, as the semantic signal does. Iterate the rows,
  apply `passesFileFilters` for path and pattern with a `FileFilters` built from `params` and
  `globToRegex`, count every passing row into `total`, and keep the first `offset + limit` as
  results. Each result is `{ filePath: stored_key, dateMs, score: 1, scoreLabel: 'date',
  signals: { date: 1 } }`.
- Returning `offset + limit` rows rather than slicing here is deliberate. The slice happens
  after the cross-silo merge, and the global top `offset + limit` always lies inside the union
  of the per-silo tops.
- No bounds is allowed at this level and lists the whole silo. The gate is a client-contract
  rule and lives at the two edges.

`src/backend/store-worker.ts`, `src/backend/store-proxy.ts`, `src/backend/store-facade.ts`
- RPC method `listByDate(siloId, params)` next to `search`, returning `ListingResult`.

`src/backend/silo-manager.ts`
- `listByDate(params)`: the same availability guard and `startPath` to stored-key conversion as
  `search()`, then `store.listByDate`, then resolve stored keys to absolute paths.

`src/backend/search-merge.ts`
- `dispatchListing(params, managers): Promise<{ raw: SiloSearchResult[]; total: number }>`.
  No embedding-service parameter. Skips unavailable managers, logs and skips a silo that throws,
  sums the per-silo totals.
- `mergeListing(raw, offset, limit)`: sort by `dateMs` descending, then silo name, then path,
  and return `slice(offset, offset + limit)`.

`src/main/ipc-handlers.ts`, `src/preload.ts`, `src/shared/electron-api.d.ts`
- `silos:listByDate`, exposed as
  `listByDate(params: ListingParams, siloName?) => Promise<{ results: SearchResult[]; total: number }>`.
  Silo selection through `selectSilos` from phase 4. Every ready silo is listable; there is no
  embedding-service filter.

`src/main/internal-api.ts`
- Pipe method `listByDate` and `handleListByDate(params)` returning
  `{ results, warnings, total }`. Silo selection through `selectSilos(…, toSiloNames(params.silo))`
  and warnings through `siloWarnings(ready, false)`, both from phase 4, so there is no
  "still initializing" warning and no embedding-service filter. Sends the `mcp:activity` event
  as `handleSearch` does. `handleSearch` is unchanged and still rejects a blank query.

`src/main/mcp-bridge.ts` and `src/backend/mcp/types.ts`
- `silo.listByDate(params: ListingParams & { silo?: string[] })` alongside `search`. The
  `query` on `search` stays required at this layer.

`src/backend/mcp/tools-search.ts`
- Schema: `query` becomes `z.string().optional()`, described as
  `The search query, in natural language or code. Omit it, with since and/or until set, to list every file in the window newest first.`
  Add `offset: z.number().int().min(0).optional()`, described as
  `Listing only: skip this many files before returning results. Use the "next page" hint from a listing response.`
- Handler, inside the existing `try`, after `parseDateWindow` and the phase 4 `resolveSiloRefs`
  call, which runs before the branch so both paths see resolved names:
  - `listing = !query?.trim()`.
  - Listing with neither bound: `errorResponse` with the gate message, before `notifyActivity`.
  - Not listing with `offset` defined: `errorResponse` with the offset message.
  - Listing: `deps.silo.listByDate({ silo, startPath, filePattern, dateFromMs, dateToMs, limit: maxResults ?? 10, offset: offset ?? 0 })`,
    then `formatListingHeader(...)`, a blank line, and `formatSearchResults(results, puid)`.
    Warnings prepend exactly as today.
  - Otherwise the existing path, untouched.

`src/backend/mcp/formatting.ts`
- `formatSearchResults`: when `scoreLabel` is `'date'`, the silo line is
  `Silo: <name> | Date: 21 December 2025, 07:15` with no Score segment.
- `formatListingHeader(total, shown, offset, since?, until?)`. The window phrase uses the raw
  strings the client passed, so it echoes what the client asked for: `dated 2026-08-01 to
  2026-08-31`, `dated on or after 2026-08-01`, or `dated on or before 2026-08-31`. Then one of:
  - total 0: `No files dated 2026-08-01 to 2026-08-31.`
  - offset at or past total: `312 files dated 2026-08-01 to 2026-08-31; none at offset 400.`
  - everything shown: `12 files dated 2026-08-01 to 2026-08-31, newest first.`
  - otherwise: `312 files dated 2026-08-01 to 2026-08-31, showing 51–100, newest first. Pass offset: 100 for the next page.`
- `SEARCH_DESCRIPTION`: add two lines.
  `Omit query, with since and/or until, to list every file in the window newest first with the total count; offset pages a listing.`
  `mode is ignored for a listing.`

`src/backend/mcp/resources.ts`
- Startup tools sentence: append
  `Omit the query, keeping since or until, to list every file in the window newest first with a total count.`
- Mail paragraph, after the `since`/`until` sentence:
  `To see all mail on a day or in a window, search with since and until and no query.`

`src/renderer/views/SearchView.tsx`
- `runSearch`: a blank query with no date sets `searchError` to the gate message and makes no
  call. A blank query with a date calls
  `window.electronAPI.listByDate({ startPath, filePattern, ...dateWindow, limit: 50 }, silo)`,
  sets the results and a new `listingTotal` state. A non-blank query runs as today and clears
  `listingTotal`.
- `handleSearch`: the file-mode gate allows a blank query when `since` or `until` is set.
- Above the results, when `listingTotal` is not null:
  `312 files in this window, showing the newest 50.`, `12 files in this window, newest first.`
  or `No files in this window.`
- Result card: when `scoreLabel` is `'date'`, render neither the score bar nor the percentage.
  The date is already shown from phase 3.
- Empty-state text:
  `Enter a query and press Enter to search. Set a date and press Enter with no query to list files in that window, newest first.`
- No paging in the app in this phase.

`README.md`
- One sentence on the date paragraph: a search with no query and a date window lists everything
  in the window newest first, with the total.

## Tests

`src/backend/search-listing.test.ts` (new, real database, same helpers as
`src/backend/search-date.test.ts`)
- Six dated files and one with a null date, window covering three: those three come back newest
  first, `total` is 3, the null-dated file is absent.
- Two files with the same `date_ms` come back in `stored_key` order.
- `limit: 2` returns the two newest and `total` is still 3.
- `offset: 1, limit: 1` returns two rows, because the slice belongs to the merge.
- `startPath` and `filePattern` each reduce both the results and `total`.
- Every result has `score` 1, `scoreLabel` `'date'`, `signals` `{ date: 1 }`, `dateMs` equal to
  the row, and neither `hint` nor `chunks`.
- `dateFromMs` alone and `dateToMs` alone each behave as half-open windows.

`src/backend/search.test.ts` (mocked managers, as the existing dispatch tests)
- `dispatchListing` works with a null embedding service, skips unavailable managers, and sums
  totals.
- `mergeListing` orders by date descending, then silo name, then path, and honours `offset` and
  `limit`.

`src/backend/mcp/tools-search.test.ts`
- A blank query with `since` calls `deps.silo.listByDate` with the parsed bounds and
  `offset: 0`, and does not call `deps.silo.search`. A whitespace query does the same.
- A blank query with no bounds returns the gate message, calls neither dependency, and does not
  notify activity.
- A query with `offset` returns the offset message and calls neither dependency.
- A listing response starts with the header line, and a warning still prepends above it.
- A listing with `silo: ["s1", "notes"]` reaches `deps.silo.listByDate` with the resolved
  names, as the phase 4 search test does.

`src/backend/mcp/formatting.test.ts`
- The four header variants above, with the `dated` phrase for both bounds, `since` only, and
  `until` only.
- A `'date'` result prints `Silo: notes | Date: …` with no Score segment; a `'semantic'` result
  is unchanged.
- `SEARCH_DESCRIPTION` mentions omitting the query and `offset`.

`src/backend/mcp/resources.test.ts`
- The startup guide and the mail guide both mention listing without a query.

## Acceptance

No schema change, so this is a normal install: build with Node 22, close the app, install,
launch. Work through the listing bullets in [design.md](design.md#acceptance) from Claude Code
against the installed build and record them in this folder's acceptance note alongside the
phase 3 entries.

## Done when

- All tests above pass, `npm run typecheck` and `npm run lint` are clean.
- Every search with a query, with or without a window, returns what it returned before this
  phase. The phase 2 snapshot tests still guard this.
- The listing bullets in the acceptance note are marked pass, or carry a linked issue.

## Out of scope

- Paging in the app.
- Oldest-first ordering. Add an `order` parameter when a real need shows up.
- A listing on `startPath` or `filePattern` alone. `lodestone_explore` with `fullContents`
  already lists a directory, and the gate keeps an accidental blank query from dumping a silo.
- `offset` for ranked search.
- Date ordering of ranked results.
