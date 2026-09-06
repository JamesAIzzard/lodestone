# Date Filter: Implementation Overview

Status: phases 1 to 3 merged, phases 4 and 5 ready to implement · Branch: `develop` · Last updated: 2026-09-06

## What this feature is

Let a search be restricted to a date window. Every indexed file gets one date: for a file in an
ordinary silo it is the time the file was last touched on disk, and for a mirrored email it is
the time the message was received. `lodestone_search` and the app's search view accept `since`
and `until` bounds, and the window is applied before candidate selection, so a narrow window over
a large silo still returns the best matches inside that window rather than nothing. A search with
no query and a window lists everything in the window newest first, with the total count, so a
client can answer "what arrived on Tuesday" without inventing a query. On the way there, silos
gain session references (`s1`, `s2`) alongside the existing `r` and `d` ones, and the `silo`
parameter accepts a subset of silos rather than one or all.

The date is a promoted column on the `files` table, populated at index time from data the index
already holds. Nothing new is read from disk or from mail servers. Because the column changes the
schema, the schema version moves from 5 to 6. Rather than let every silo rebuild, a one-off
Python script adds the column to the existing databases while the app is closed.

The full design is in [design.md](design.md). Read it once before starting any phase; each phase
doc assumes it and only repeats the parts it needs.

## Phases

Each phase is independently mergeable and leaves the app working.

| Phase | Doc | Delivers | Depends on |
|---|---|---|---|
| 1 | [phase-01-date-column-and-migration.md](phase-01-date-column-and-migration.md) | `files.date_ms`, schema version 6, the derivation rule, population on every write path, the migration script | none |
| 2 | [phase-02-filtered-search.md](phase-02-filtered-search.md) | `dateFromMs`/`dateToMs` on `SearchParams`, one shared file predicate for all signals, KNN pre-filter, date on every result | 1 |
| 3 | [phase-03-surfaces-and-acceptance.md](phase-03-surfaces-and-acceptance.md) | `since`/`until` on the MCP tool, bound parsing, guide and description text, date in tool output, date inputs and date display in the search view, acceptance pass | 2 |
| 4 | [phase-04-silo-references-and-subsets.md](phase-04-silo-references-and-subsets.md) | `s` references for silos in status and result output, `silo` as a name, reference or array on search and explore, one shared silo-selection helper in the main process | 3 |
| 5 | [phase-05-listing-without-a-query.md](phase-05-listing-without-a-query.md) | Optional `query` on the MCP tool, a date-ordered listing path with a total count and `offset` paging, listing in the search view, guide text | 4 |

```mermaid
flowchart LR
  P1[1 Column and migration] --> P2[2 Filtered search] --> P3[3 Surfaces and acceptance] --> P4[4 Silo references and subsets] --> P5[5 Listing without a query]
```

Phase 4 is not about dates. It sits here because the listing in phase 5 needs a third copy of
the silo-selection block otherwise, and because the subset request came out of the same
"find all the mail in this window" conversation.

## Conventions for every phase

- Branch from `develop`, one branch per phase, merge back when the phase's done criteria pass.
- Tests are `vitest`, colocated as `*.test.ts`. Store and signal tests open a real
  `createSiloDatabase` in a temp directory, as `src/backend/store.test.ts` does, so sqlite-vec
  behaviour is exercised for real rather than mocked.
- The store worker is the only process that opens a silo database for writing. No phase adds a
  second writer inside the app.
- No phase reads anything new from disk or from a mail server. The date comes from `mtime_ms`
  and `file_metadata`, both of which the index already stores.
- Existing searches with no date bounds must return exactly what they return today. Phase 2
  guards this with tests that run the same query with and without bounds.

## Install sequence

The installed app has `SCHEMA_VERSION = 5` compiled in and treats any other version as
unusable, so the stable profile must not be migrated while the old build is still in use. The
sequence that gives one installer build and no silo rebuilds:

1. While developing, run the migration script against `Lodestone-Dev` the first time the new
   code is started from source. The source build uses that profile.
2. When phase 3 is done, build the installer once. Package with Node 22; the Electron build fails
   silently on Node 24.
3. Close the installed app. Run the script against both profiles. Install and launch. The Dev
   pass is a no-op by then because the script is guarded on the stored version.

Launching the new build before running the script does no harm beyond a rebuild of every silo,
which is the outcome the script exists to avoid.

Phases 4 and 5 change no schema. Install them as normal builds, with no script step.

## Decisions taken while splitting the design into phases

- The column is populated inside `flushPreparedFiles` from the metadata and mtime already on
  the upsert, not by the pipeline. This keeps `FlushUpsert` unchanged and keeps the rule in one
  place next to the only other write of `mtime_ms`.
- The derivation rule has a single TypeScript implementation, `deriveDateMs`, and the migration
  script restates it in SQL. Phase 1 pins the two to each other with a test that runs the SQL
  expression against fixture rows and compares it with the TypeScript result.
- Bounds are parsed to epoch milliseconds at the client edge, in the MCP tool handler and in the
  renderer, using one shared parser under `src/shared/portable/`. Everything from
  `SearchParams` inward sees numbers only.
- The date shown on results and used for filtering are the same column. There is no separate
  display date.
- Silo references resolve to names in the MCP process, so nothing behind the pipe learns about
  `s` numbers. An unknown name anywhere in a subset fails the whole call; a partial subset would
  be a silent wrong answer.
- Ranked results are never sorted by date. The only date-ordered output is the query-less
  listing in phase 5, which bypasses the signal pipeline rather than adding a date signal to it,
  so a blank query cannot change what a ranked search returns.
- The listing reports a total and pages with `offset` rather than a date cursor. Result dates
  print at minute resolution, so a cursor built from the last date shown would skip files within
  that minute; an offset over a stable order has no such gap.
