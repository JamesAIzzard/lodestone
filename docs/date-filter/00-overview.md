# Date Filter: Implementation Overview

Status: ready to implement · Branch: `develop` · Last updated: 2026-09-06

## What this feature is

Let a search be restricted to a date window. Every indexed file gets one date: for a file in an
ordinary silo it is the time the file was last touched on disk, and for a mirrored email it is
the time the message was received. `lodestone_search` and the app's search view accept `since`
and `until` bounds, and the window is applied before candidate selection, so a narrow window over
a large silo still returns the best matches inside that window rather than nothing.

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

```mermaid
flowchart LR
  P1[1 Column and migration] --> P2[2 Filtered search] --> P3[3 Surfaces and acceptance]
```

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
- Sorting results by date is out of scope. It is a cheap follow-on once the column and the
  per-result date exist, and is noted as such in the design.
