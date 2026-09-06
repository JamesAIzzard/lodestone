# Date Filter Design

Status: settled · Branch: `develop` · Last updated: 2026-09-06

This is the repository copy of the design. The phase docs in this folder implement it. Where a
phase doc and this document disagree, fix the disagreement rather than picking one.

## Summary

Give every indexed file one date, store it as a column on the `files` table, and let searches
restrict themselves to a window on it. The window is applied before candidate selection in every
signal, so results inside a narrow window are found rather than starved out by higher-scoring
results outside it. The same column is returned with every search result so clients can see when
a hit is from.

The feature touches the store schema, the search runner and its four signals, the MCP search
tool, and the app's search view. It does not touch the watcher, the reconciler, the chunker, the
embedder, the mail synchroniser or the mirror files. Mail mirror files already carry
`received_at` in their frontmatter, and the markdown extractor already lifts frontmatter into
`file_metadata`, so no extractor changes are needed.

Out of scope: sorting by date, a separate created-versus-modified distinction for filesystem
files, dates from frontmatter keys other than `received_at`, dates from PDF properties, relative
date expressions in the tool contract (clients compute those from `lodestone_get_datetime`), and
date filters on `lodestone_explore`.

## What the date is

One value per file, `files.date_ms`, epoch milliseconds, `REAL`, nullable.

| File | Date | Source |
|---|---|---|
| Mirrored email | Time the message was received by the server | `file_metadata.received_at`, written by the mail synchroniser from IMAP `INTERNALDATE` |
| Anything else | Time the file was last modified on disk | `files.mtime_ms`, which the reconciler and watcher already maintain |

`received_at` is preferred over the message's `Date` header because it is always present, comes
from the server rather than the sender, and is what the synchroniser's cutoff is measured
against. A message with no header date still has one.

The rule is a pure function:

```text
deriveDateMs(fileMetadata, mtimeMs):
  if fileMetadata.received_at is a string and Date.parse(it) is finite -> that value
  else -> mtimeMs, or null when mtimeMs is null
```

It is applied to every file regardless of silo type. A markdown note that happens to carry a
`received_at` key is treated as mail-dated; the only such files today are the mail fixtures
under `src/backend/mail/fixtures`, which the repository silo indexes, and that is acceptable.

The YAML parser turns an unquoted ISO timestamp into a `Date`, and `JSON.stringify` writes it
back as `2025-12-21T07:15:26.000Z`. Both `Date.parse` and SQLite's `unixepoch(..., 'subsec')`
read that form identically, which is what lets the migration script restate the rule in SQL.

## Schema

`SCHEMA_VERSION` becomes 6. The `files` table gains `date_ms REAL` after `mtime_ms`, and an
index `idx_files_date_ms ON files(date_ms)`. `peekIndexState` is unchanged: a database at any
other version is unusable and is rebuilt, exactly as today.

`date_ms` is written wherever `mtime_ms` is written:

- `flushPreparedFiles`: the upsert inserts it and updates it on conflict, computed from the
  upsert's `fileMetadata` and `mtimeMs`.
- `setMtime`: reads the row's `file_metadata`, recomputes with the new mtime, writes both.
- `deleteMtime`: nulls both.

## Migration

A one-off script, `scripts/migrate-schema-6.py`, brings an existing version 5 database to
version 6 without rebuilding it. Per database, in one transaction:

```sql
ALTER TABLE files ADD COLUMN date_ms REAL;
UPDATE files SET date_ms = COALESCE(
  unixepoch(json_extract(file_metadata, '$.received_at'), 'subsec') * 1000,
  mtime_ms);
CREATE INDEX IF NOT EXISTS idx_files_date_ms ON files(date_ms);
UPDATE meta SET value = '6' WHERE key = 'version';
```

The script finds databases by reading each profile's `config.toml` and visiting every
`[silos.*].index_db_path`, resolving relative paths against the profile directory. Mail silos
are listed there too. It is guarded on `meta.version = '5'` and on the column being absent, so
it is idempotent, and it refuses to run if it cannot take an immediate write lock, which is what
happens when the app is open.

The app never migrates in place. If the script is not run, the version check fails and the silo
rebuilds, which is the existing behaviour for any schema change.

## Filter semantics

`SearchParams` gains `dateFromMs?: number` and `dateToMs?: number`, both inclusive. A file
passes when `date_ms IS NOT NULL AND date_ms >= dateFromMs AND date_ms <= dateToMs`, with a
missing bound meaning unbounded on that side. A file with a null date never passes when either
bound is set.

Client-facing bounds are strings, parsed once at the edge by `parseDateBound(value, edge)` in
`src/shared/portable/date-bounds.ts`:

| Input | `edge = 'from'` | `edge = 'to'` |
|---|---|---|
| `YYYY-MM-DD` | local midnight starting that day | last millisecond of that day, local time |
| ISO 8601 with time and zone or `Z` | that instant | that instant |
| ISO 8601 with time and no zone | local time | local time |
| anything else | error | error |

Date-only values are local because the guide footer and `lodestone_get_datetime` report local
time, and that is what a client reasons in. `since` after `until` is an error. Errors are
returned to the client with the message
`Invalid <since|until>: expected YYYY-MM-DD or an ISO 8601 date-time.`

## Selection

Every signal applies one shared predicate, `passesFileFilters(ctx, storedKey, dateMs)`, which
combines the existing `startPath` and `filePattern` checks with the date window. This replaces
the two duplicated filter lines in each signal. To make the date available where the predicate
runs, `fetchChunkMeta` selects `f.date_ms` into `ChunkMeta`, and the full-table scans in the
filepath and regex signals select it alongside `stored_key`.

Whether the predicate runs before or after ranking differs by signal, and only one needs to
change:

| Signal | Today | With a date window |
|---|---|---|
| semantic | KNN top `maxResults × 5` chunks, then filter | Date window inside the KNN query as a `rowid IN (subquery)` constraint, then the shared predicate for path and pattern |
| bm25 | Scores every chunk containing any query term, then filter | Unchanged mechanism; post-filter is equivalent to pre-filter because nothing is cut before it |
| filepath | Full scan of `files`, then filter | Unchanged mechanism |
| regex | Full scan of `chunks` and `files`, then filter | Unchanged mechanism |

The semantic query with a window is:

```sql
SELECT v.rowid, v.distance
FROM vec_chunks v
WHERE v.embedding MATCH vec_int8(?)
  AND k = ?
  AND v.rowid IN (
    SELECT c.id FROM chunks c
    JOIN files f ON f.id = c.file_id
    WHERE f.date_ms >= ? AND f.date_ms <= ?)
ORDER BY v.distance
```

The bundled sqlite-vec (`0.1.7-alpha.10`) implements `rowid IN (...)` on vec0 KNN queries
through SQLite's virtual-table IN mechanism, which accepts a subquery, and allows one such
constraint per query. Phase 2 proves it with a test against a real database in which the only
in-window chunk is the least similar of many, and must be returned. If that test cannot be made
to pass on the bundled build, the fallback is to widen `k` in steps up to the chunk count until
enough in-window files are found; the design prefers the constraint and the fallback is
recorded here only so the decision is not re-derived.

Path and pattern filters stay where they are. Moving them into the subquery would fix their own
starvation on narrow paths, and is a reasonable follow-on, but is not part of this feature.

BM25's corpus statistics remain global. Inverse document frequency is computed over the whole
silo, not the window, which is the conventional choice and keeps scores comparable across
searches.

## Results

`FileResult` and the shared `SearchResult` gain `dateMs: number | null`. After the runner has
sorted and truncated, it fetches `date_ms` for the surviving stored keys in one query, at most
`maxResults` rows. The MCP formatter prints the date on the silo line of each result as a local
date and time, and the renderer shows it on the result card. This is the same column the filter
uses, so a client can confirm a window did what it asked.

## Tool contract

```text
lodestone_search({ query, since?: "2026-08-01", until?: "2026-08-31", ... })
```

- `since`, `until`: optional strings in either form above. Both inclusive.
- The description text explains what the date means for mail versus files and says that
  relative windows should be computed from `lodestone_get_datetime`.
- Everything else about the tool is unchanged.

## Acceptance

Run against the installed build from Claude Code, after the migration script and install
sequence in the overview.

- No silo rebuilt: `lodestone_status` file counts match the pre-install counts for every silo,
  and the activity feed shows no reindex storm.
- A search on a mail silo with a one-week `since`/`until` returns only messages whose
  `received_at` frontmatter lies in that week. Check three by reading them.
- A search on a filesystem silo with `since` set to yesterday returns only files whose disk
  modification time is later than that. Check two with the file's properties.
- A generic query in `semantic` mode with a one-day window on the largest mailbox returns
  results. The same query without the window returns different, higher-scoring results from
  outside the window.
- The same query with no bounds returns the same top results, in the same order, as before the
  feature.
- `since = "2026-13-01"` and `since` later than `until` each return the error text above.
- Every result line shows a date, and for a mail hit it equals the message's `received_at`
  rendered in local time.
- In the app, the two date inputs filter the results, persist across a view change within the
  session, and clear with their clear buttons.
