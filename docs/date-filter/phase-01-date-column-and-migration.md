# Phase 1: Date Column and Migration

Status: ready · Depends on: nothing · Unblocks: phase 2

## Goal

Every file row carries `date_ms`, populated by the rule in [design.md](design.md#what-the-date-is)
on every path that writes `mtime_ms`. The schema version becomes 6. A Python script migrates an
existing version 5 database in place so no silo has to rebuild. Nothing reads the column yet.

After this phase merges, starting the app from source against an unmigrated Dev profile rebuilds
every dev silo once; running the script first avoids that. The installed build is unaffected
until phase 3 ships.

## Changes

`src/backend/store/date.ts` (new)
- `deriveDateMs(fileMetadata: Record<string, unknown> | undefined, mtimeMs: number | null | undefined): number | null`.
  Returns `Date.parse(received_at)` when `received_at` is a string and the result is finite,
  otherwise `mtimeMs ?? null`. No other keys are consulted. Export it from `store/index.ts`.

`src/backend/store/types.ts`
- `SCHEMA_VERSION = 6`.

`src/backend/store/schema.ts`
- Add `date_ms REAL` to the `files` create statement after `mtime_ms`.
- Add `CREATE INDEX IF NOT EXISTS idx_files_date_ms ON files(date_ms);`.
- Nothing else. The comment at the top of the file about rebuilding instead of migrating stays
  true for the app; the external script is the exception and is documented in this folder.

`src/backend/store/operations.ts`
- `flushPreparedFiles`: the `upsertFile` statement inserts `date_ms` and updates it on
  conflict. Compute it per upsert as `deriveDateMs(up.fileMetadata, up.mtimeMs ?? null)`
  before calling the statement. `FlushUpsert` does not change.
- `setMtime`: select the row's `file_metadata`, parse it, and write
  `mtime_ms = ?, date_ms = ?` with `deriveDateMs(parsed, mtimeMs)`. This path is hit by the
  watcher coordinator after every indexed event, so it must not let `date_ms` drift from
  `mtime_ms` on filesystem files.
- `deleteMtime`: set both columns to `NULL`.

`scripts/migrate-schema-6.py` (new)
- Python 3.11 or later for `tomllib`. Refuse to start if `sqlite3.sqlite_version_info` is
  below `(3, 42, 0)`, which is when `unixepoch(..., 'subsec')` arrived. The machine has 3.50.
- Arguments: zero or more profile directories; default to `%APPDATA%\Lodestone` and
  `%APPDATA%\Lodestone-Dev`. `--dry-run` reports what would happen without writing.
- For each profile: read `config.toml`, collect every `[silos.<name>].index_db_path`, resolve
  relative paths against the profile directory, skip paths that do not exist with a warning.
- For each database: open with `isolation_level=None`, run `BEGIN IMMEDIATE`; on
  `OperationalError` "database is locked" print
  `<path> is in use. Close Lodestone and run again.` and continue to the next file. Read
  `meta.version`. If `'6'`, audit every row against the derivation expression. In dry-run mode,
  report how many dates differ without writing; otherwise repair only those rows, or roll back
  without writing when all dates are consistent. If the version is neither `'5'` nor `'6'`,
  report it and roll back. For version 5, if `PRAGMA table_info(files)` already lists `date_ms`,
  treat it as migrated. Otherwise run the four statements from [design.md](design.md#migration),
  commit, and print the file count and how many rows took the `received_at` branch versus the
  `mtime_ms` branch, which is a useful sanity check on a mail index (all rows) versus a filesystem
  index (none, except fixtures).
- Never touch `vec_chunks`, `chunks`, `postings` or `terms`. The script does not load sqlite-vec
  and must not need to.
- Exit non-zero if any database was in use or at an unexpected version.

## Tests

`src/backend/store/date.test.ts` (new)
- `received_at` as an ISO string with milliseconds and `Z`, as produced by the writer, returns
  the exact epoch.
- `received_at` absent, `null`, non-string, or unparseable falls back to `mtimeMs`.
- Both absent returns `null`.
- Equivalence with the migration SQL: open a throwaway database with the app's own
  `better-sqlite3`, insert rows covering the cases above into a scratch table with
  `file_metadata` and `mtime_ms` columns, run the `COALESCE(unixepoch(json_extract(...),
  'subsec') * 1000, mtime_ms)` expression, and assert each row equals `deriveDateMs` on the
  same inputs. This is the test that keeps the script honest; keep the SQL string in one
  exported constant in `date.ts` so the test and the script's docstring cite the same text.
  The app's better-sqlite3 bundles SQLite 3.51.2, so `unixepoch(..., 'subsec')` is available
  in the test.

`src/backend/store.test.ts`
- After a flush, `date_ms` equals `mtime_ms` for a file with no `received_at` and equals the
  parsed `received_at` for one that has it.
- `setMtime` on a filesystem file updates `date_ms`; on a mail-dated file it leaves `date_ms`
  alone.
- `deleteMtime` nulls `date_ms`.
- A freshly created database reports version 6 through `loadMeta`, and `peekIndexState` on it
  is `usable`.

`scripts/test_migrate_schema_6.py`
- A version 5 mail row migrates to the exact `received_at` epoch.
- A version 6 dry-run reports a mismatched row without changing it.
- A version 6 repair updates only inconsistent rows, ensures the date index exists, and a repeat
  run reports every date as consistent.
- Also verify by hand on a copy of one Dev mail index and one filesystem index: run with
  `--dry-run`, run for real, run again and see it report all dates as consistent, open the result
  with `peekIndexState` from a one-line `vitest` scratch and confirm `usable`, and spot check three
  rows against their frontmatter. Record the commands in the phase 3 acceptance note.

## Done when

- All tests above pass and `npm run typecheck` is clean.
- Starting from source against a migrated Dev profile opens every silo without a rebuild, and
  `lodestone_status` shows the pre-migration file counts.
- Starting from source against an unmigrated copy rebuilds it and the result also reports
  version 6.

## Out of scope

Reading `date_ms` anywhere. Search, results and the UI are phases 2 and 3.
