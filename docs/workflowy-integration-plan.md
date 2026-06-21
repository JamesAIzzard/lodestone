# Workflowy Integration Plan

Status: draft · Branch: `develop` · Last updated: 2026-06-20

## Goal

Let Lodestone treat a Workflowy account as a searchable, editable source — surfaced in
the UI as a silo, but backed by custom code rather than the filesystem indexing pipeline.
AI tools get **semantic** search over the outline (which Workflowy itself does not offer)
plus the ability to read and mutate the node tree.

## Key decisions (settled)

- **Backbone: official REST API** (`https://workflowy.com/api/v1`, Bearer token from
  workflowy.com/api-key). Simple auth, sanctioned for integrations.
- **Search is local.** Workflowy has no search endpoint; we embed nodes with Lodestone's
  existing 384-dim model and search the local vector index. This is the differentiator —
  every other Workflowy tool does substring/regex matching.
- **UI = silo shell, backend = custom.** A Workflowy source is presented like a silo
  (status, node count, accent colour) but does not use the file watcher / reconcile /
  mtime pipeline. Nodes feed straight into a dedicated SQLite schema.
- **Sync = on-demand, TTL-gated.** No background polling. On a search/read request, if the
  local index is older than the TTL, do a full export + diff first; otherwise serve from
  the index. Edits made *through* Lodestone are written to the API and re-embedded
  immediately (write-through), so they never trigger a pull.

## Why not the alternatives

- **Extension API (`window.WF`)**: official and richer (live `WFEventListener` change feed,
  unthrottled local export, native search), but it's client-side only — requires hosting an
  authenticated Workflowy webview in Electron. Kept as a future option if metered-bandwidth /
  large-tree / heavy-mobile-editing usage makes full re-export painful.
- **Mirror-to-disk / per-node files**: 100k loose files would wreck the filesystem and the
  chokidar watcher; loses node identity on write-back. Instead we use a dedicated SQLite schema.

## REST API surface used

- `GET /nodes-export` — full tree, flat list (the only bulk read). **Rate-limited 1/min.**
  No delta/since parameter — a refresh is always the whole tree, diffed locally.
- `POST /nodes` (create), `POST /nodes/:id` (update name/note), `POST /nodes/:id/move`,
  `POST /nodes/:id/complete` + `/uncomplete`, `DELETE /nodes/:id`.
- Node fields: `id`, `parent_id`, `name` (markdown/inline HTML), `note`, `priority`,
  `createdAt`/`modifiedAt`/`completedAt` (top-level), and **`data.layoutMode`** (nested under
  `data`, *not* top-level — read it as `node.data?.layoutMode` on import).
- **Verify on first build:** does `nodes-export` send `ETag`/`Last-Modified`? If so,
  conditional requests make "nothing changed" refreshes near-free `304`s.

## Data model

One SQLite DB per Workflowy silo, reusing the existing `better-sqlite3` + `sqlite-vec`
stack (see `src/backend/store/schema.ts`). Vectors are `int8` → 384 bytes each. The shape
mirrors the file pipeline's **files → chunks → vec_chunks**: `wf_nodes` carries the tree
(where `files` carries a path), `wf_chunks` carries embeddable units, `wf_vec` the vectors.

```sql
CREATE TABLE wf_nodes (                 -- the tree, one row per node
  rowid         INTEGER PRIMARY KEY,
  node_id       TEXT UNIQUE NOT NULL,   -- Workflowy id
  parent_id     TEXT,                   -- tree edge (NULL = root)
  name          TEXT NOT NULL,
  note          TEXT,
  priority      INTEGER NOT NULL,       -- sibling order
  completed_at  INTEGER,                -- NULL = not completed
  last_modified INTEGER,                -- Workflowy modifiedAt
  layout_mode   TEXT,                   -- from node.data.layoutMode (nested, NOT top-level)
  data          TEXT NOT NULL DEFAULT '{}', -- raw node.data JSON (forward-compat; cf. files.file_metadata)
  content_hash  BLOB NOT NULL           -- hash(raw name+note) → node-level diff trigger
);
CREATE INDEX idx_wf_parent ON wf_nodes(parent_id);

CREATE TABLE wf_chunks (                -- 1+ per node (usually exactly 1)
  id           INTEGER PRIMARY KEY,
  node_rowid   INTEGER NOT NULL REFERENCES wf_nodes(rowid),
  chunk_index  INTEGER NOT NULL,
  text         BLOB NOT NULL,
  content_hash BLOB NOT NULL            -- per-chunk (plaintext) hash → skip unchanged chunks
);
CREATE INDEX idx_wf_chunks_node ON wf_chunks(node_rowid);

CREATE VIRTUAL TABLE wf_vec USING vec0(embedding int8[384] distance_metric=cosine);
-- wf_vec rowid ↔ wf_chunks.id ; lastFullPullAt/version → existing meta(key, value) table
```

**Chunking.** Reuse `chunkPlaintext` (`src/backend/chunkers/plaintext.ts`) on each node's
plaintext (HTML-stripped name+note). Short nodes (the vast majority) → exactly one chunk =
one vector; long notes (>512 tokens, the model's window) → split on paragraph/sentence
boundaries. No truncation, no bespoke logic, and the search pipeline's existing multi-chunk
result aggregation collapses several matching chunks of one node into a single hit for free.

**Tree navigation** = `parent_id` index + recursive CTEs:
- children: `WHERE parent_id = ? ORDER BY priority`
- subtree (read tool): `WITH RECURSIVE` downward
- breadcrumb (search results): `WITH RECURSIVE` up the `parent_id` chain

**Two-level hashing.** Two hashes at the natural levels, because read/write formatting is
asymmetric (see round-trip note in Open questions):
- `wf_nodes.content_hash` = hash of the **raw** name+note. Drives the *node* diff: *any*
  change — including formatting-only — refreshes the row, so stored HTML stays faithful for
  write-back, and triggers a re-chunk.
- `wf_chunks.content_hash` = hash of the chunk's **plaintext**. Gates *embedding*: on re-chunk,
  embed only chunks whose hash is new/changed; a chunk row without a `wf_vec` entry = pending
  embed (crash-safety). A formatting-only edit bumps the node hash but leaves chunk hashes
  unchanged → row refreshed, no re-embed. Mirrors the file pipeline's chunk dedup exactly.

**Hybrid search:** Lodestone files use vectors + a `terms`/`postings` lexical index.
Decided: mirror the hybrid approach for nodes, so node and file results rank consistently in
unified search.

## Sync logic

On any search/read MCP request:

```
if (now - lastFullPullAt > TTL) await refresh();
// then serve from the local index
```

`refresh()`:
1. `GET /nodes-export` (conditional via ETag if supported).
2. Load `(node_id, content_hash, parent_id, priority, completed_at)` for all node rows into a Map.
3. Walk the export:
   - new id → insert node + chunk + embed
   - `content_hash` changed → update node row, re-chunk; embed only chunks whose plaintext
     hash is new/changed, delete chunks (+ vectors) that no longer exist
   - only structural fields changed (parent/priority/completed) → update row, no re-chunk
   - local id absent from export → delete node + its chunks + vectors
4. Embed any chunks still pending (chunk row without a `wf_vec` entry) from an interrupted run.
5. Set `lastFullPullAt = now`.

**Write-through** (create/update/move/complete/delete via MCP): call the API, then apply
the same change to `wf_nodes`/`wf_chunks` (re-chunk + embed changed chunks if text changed)
immediately. No pull triggered.

**TTL** is the one tuning knob: default 10 min; stretch on metered connections (Electron can
detect metered networks); manual "refresh now" available. Optional later: serve-stale-while-
revalidating to hide the first-stale-query refresh latency.

## MCP tools (Workflowy-native)

File-shaped tools (byte-range read, line edit) don't fit a node tree. New tools:

- `workflowy_search(query, limit)` — semantic search; returns matching nodes **with
  breadcrumb path** so the AI knows where each hit lives.
- `workflowy_get_node(node_id, depth)` — a node + its subtree to depth N (the "read").
- `workflowy_create(parent_id, name, note?, position?)` — markdown supported. `position` is
  `'top' | 'bottom'` (default `'bottom'`), matching the documented API — **not** an arbitrary index.
- `workflowy_update(node_id, name?, note?)`.
- `workflowy_move(node_id, new_parent_id, position?)` — `position` is `'top' | 'bottom'` only.
- `workflowy_complete(node_id, completed)` / `workflowy_delete(node_id)`.

All writes go through the write-through path.

**Placement constraint.** The documented API only supports `'top'`/`'bottom'` placement on
create/move. `priority` is returned for *sorting* but is not documented as settable, so we do
**not** promise precise sibling insertion (e.g. "insert at index 5"). If exact positioning is
needed later, confirm an undocumented path first; otherwise it's a known limitation. We still
read `priority` to render siblings in the correct order locally.

## Unified search (no silo specified)

When `lodestone_search` is called without a `silo`, Workflowy hits are merged into the
all-silo results, attributed to the Workflowy silo.

**Free part — the scoring/merge math.** `dispatchSearch`/`mergeSearchResults`
(`src/backend/search-merge.ts`) already tag results with `siloName` and merge by **absolute
[0,1] score** with no calibration. Workflowy nodes use the same embedding model + `sqlite-vec`
cosine, so scores are directly comparable. The existing `silo` arg already covers both modes
(omit → included; name → restricted), so no new tool parameter.

**Not free — the plumbing.** Today the source collection is concretely `SiloManager`
(`AppContext.siloManagers`, `dispatchSearch`'s param, the two call sites), so a Workflowy source
has nowhere to plug in. This is resolved by the **prerequisite
[SearchSource refactor](resource-oriented-architecture-plan.md)** — a standalone, behaviour-preserving
change that introduces a `SearchSource` interface at the dispatch boundary (`SiloManager`
implements it; `dispatchSearch` re-typed). See that doc for the interface and touch points.

With the seam in place, Workflowy's own work here is small:
- The Workflowy source `implements SearchSource` (its read/write/tree surface is separate) and
  gets its own `AppContext` field.
- The two call sites build the combined `searchable` as `[...siloManagers, ...workflowySources]`
  — both already `SearchSource`.
- Generalize the result type to carry the source `kind` + display label (see **Result
  rendering** below), since a node hit has no `filePath`. (The refactor leaves the result type
  file-shaped; this generalization belongs to this feature, the first consumer that needs it.)

Note: `dispatchExplore` (directory exploration) has no Workflowy analog — the source isn't in
that collection. Status/UI surfacing as a silo is separate work (Phase 3).

**Second change — source-aware references.** `lodestone_read`
(`src/backend/mcp/tools-search.ts`) resolves a ref id to a *file path* and reads from disk;
a node has no file. Make `PuidRecord` (`src/backend/mcp/puid-manager.ts`) a discriminated
union — `{ kind: 'file', filepath, ... }` | `{ kind: 'workflowy', siloName, nodeId,
breadcrumb }` — keeping nodes in the same `r{n}` ref space. `lodestone_read` branches on
`record.kind`: `file` → existing `fs` path; `workflowy` → fetch node + subtree from
`wf_nodes` (the `workflowy_get_node` logic). Single search → single read, transparent to the
LLM across mixed sources.

*Phase 1 — assignment (required for mixed search).* `assignFilePuid` dedupes `r` refs via the
`filePathToPuid` map keyed by filesystem path (`puid-manager.ts:53/56`); a node has no path, so
a synthetic one risks collisions (two nodes → same fake path). Add
`assignWorkflowyPuid(siloName, nodeId, label)` that dedupes via a parallel
`nodeKeyToPuid` map keyed by `siloName + '\0' + nodeId`, sharing the same `r`-counter so node and
file refs coexist. The result formatter assigns it for `kind: 'workflowy'` hits (vs
`assignFilePuid` for files). Without this, node hits can't get a stable ref at all.

*Phase 2 — invalidation (deferrable).* Invalidating a node's ref when a sync deletes it is
`nodeId`-keyed (the existing invalidation is path-based). Until then a stale node ref just
errors gracefully via `resolvePuidRecord`, same as a moved/deleted file — so this can wait.

**Result rendering.** Heading currently shows `## {id}: {filePath}`; the `Silo:` line
already states the source. For a node, keep `Silo: Workflowy` as the source label and put the
node's **outline breadcrumb** in the heading slot (the analog of a file path), plus a child
count:
```
## r5: Projects ▸ Q3 ▸ Launch checklist
Silo: Workflowy | Score: 84% (semantic 84%)
Child Nodes: 12
```
`Child Nodes: N` = `SELECT COUNT(*) FROM wf_nodes WHERE parent_id = ?` (rides `idx_wf_parent`);
tells the LLM a read of this ref yields a subtree. Generalize the result type with a `kind`
discriminator + display label rather than overloading `filePath: string`.

**Stale results.** Serve stale + refresh in the background, and surface a notice such as
`> Workflowy results may be up to 10 min stale — refreshing in the background.` Note: today's
"indexing" warnings are assembled *outside* managers in `internal-api.ts`, and a bare
`search()` returns only results — so there's no per-source warning channel yet. The
[SearchSource refactor](resource-oriented-architecture-plan.md) adds one: `search()` returns
`{ results, warnings }` and `dispatchSearch` aggregates them. The Workflowy source emits its
stale notice through that envelope; it then flows into the same `warnings[]` → `> ...` block
the MCP tool already renders (`tools-search.ts`).

## Config

Workflowy sources live in their **own** config section, not under `[silos.*]`. The filesystem
silo schema (`indexed_directories`, `indexed_file_extensions`, ignore patterns,
`file_change_delay_seconds`, `edit_context_lines`, …) is almost entirely irrelevant to a
Workflowy source — reusing it would mean a pile of dead fields and a config that misrepresents
what the source is. Instead, a separate `[workflowy_sources.*]` table with a flat, purpose-built
schema:

- `token_ref` — handle to the `safeStorage`-encrypted Bearer token (never the raw token)
- `index_db_path` — SQLite DB location
- `ttl_seconds` — sync staleness window (default 600)
- presentation: `accent_color`, `icon_name`, `content_description`, `is_stopped`

Parsed independently — `parseSiloTomlConfig` (`src/backend/config.ts:172`, which hard-requires
`indexed_directories`) is left **untouched**, so existing filesystem silos and on-disk configs
are unaffected. At runtime, `AppContext` gathers filesystem silos and Workflowy sources from the
two sections into separate collections (consistent with the SearchSource split); the UI/status
merges them for display. The handful of duplicated presentation fields is a deliberate, smaller
cost than forcing two source kinds through one schema.

## Module layout (proposed)

- `src/backend/search-source.ts` — `SearchSource` interface (dispatch-boundary contract) +
  `SourceSearchResult` type. `SiloManager` declares `implements SearchSource` (no behaviour
  change); `dispatchSearch`/`AppContext` search collection re-typed to it.
- `src/backend/workflowy/client.ts` — REST client (auth, endpoints, ETag handling, rate-limit guard).
- `src/backend/workflowy/sync.ts` — export fetch + diff + re-embed; `lastFullPullAt`/TTL.
- `src/backend/workflowy/store.ts` — `wf_nodes`/`wf_chunks`/`wf_vec` DDL + queries (children, subtree, breadcrumb, chunk upsert/delete).
- `src/backend/workflowy/source.ts` — `implements SearchSource`; silo-shaped facade (status, search, read, write) the rest of the app talks to.
- `src/backend/mcp/tools-workflowy.ts` — the MCP tools above (registered in `src/backend/mcp/index.ts`).
- Config (`src/backend/config.ts`): add a separate `[workflowy_sources.*]` parser (see **Config**
  above) — `parseSiloTomlConfig` untouched; token stored via `safeStorage`, not plaintext TOML.
- UI: Workflowy option in `AddSiloModal`; reuse `SiloCard`/status for display.

## Phasing

**Prerequisite (separate task):** the [SearchSource refactor](resource-oriented-architecture-plan.md) —
a standalone, behaviour-preserving change that adds the `SearchSource` interface so a non-silo
source can join unified search. Lands and merges on its own; Workflowy then only *adds an
implementor*. Not part of this feature's diff.

1. **Read path** — *first task is the config seam*: add the `[workflowy_sources.*]` section + its
   runtime collection (see **Config**). Without it the app can't load a Workflowy source at all,
   so it's a startup blocker, not polish. Then client + export + schema + diff + embed +
   `workflowy_search`/`workflowy_get_node`. Token via a minimal provisioning path (manual entry /
   dev env, stored via `safeStorage`); the polished add-silo entry UI lands in Phase 3.
   Validates sizing, sync, and search quality end to end.
2. **Write path** — create/update/move/complete/delete tools + write-through.
3. **UI + config polish** — add-silo flow, token entry/storage, status surfacing, TTL/metered settings.

## Open questions

- ETag support on `nodes-export` — **non-blocking, resolved empirically.** Can't be known
  without real authenticated calls. The client handles it opportunistically: store any
  returned `ETag`, send `If-None-Match` on refresh, take `304` (keep cache) or `200` (new
  body + new tag). If the server never sends one, the header is harmless and we always fall
  back to the full export. No architectural decision; confirmed when the client is wired up
  in Phase 1 (or via a 30-sec `curl` check with a key).
- Token storage — **decided: Electron `safeStorage`** (DPAPI on Windows, Keychain on macOS,
  libsecret/kwallet on Linux). Encrypt the Bearer token, store the ciphertext blob; decrypt
  at runtime. Never plaintext in `config.toml`. Guard: check `isEncryptionAvailable()` before
  writing — if false (Linux without a keyring), refuse to store and surface an error rather
  than silently using weak encryption. On Windows (primary target) DPAPI makes this
  effectively always available.
- Hybrid vs vector-only for v1 search. Decided: hybrid. Mirror existing silo search.
- Markdown/HTML round-trip fidelity in `name`/`note` — **decided, with fidelity checks
  deferred to Phase 2 (write path).** The API is asymmetric: read (`nodes-export`) returns
  HTML markup (`<b><i><s><code><a>`); write parses markdown. Three layers:
  - **Storage** (`wf_nodes.name`/`note`): keep the raw exported form (HTML) — never lose
    untouched formatting.
  - **Embedding + `content_hash`**: derive plain text (tags stripped). Hashing plaintext also
    means formatting-only edits don't trigger a needless re-embed.
  - **LLM interchange**: markdown both directions — convert stored HTML → markdown when
    showing a node; accept markdown on write (API parses it). Tractable because the inline set
    is just bold/italic/strikethrough/code/link.
  - **Confirm with a real key (Phase 2):** does update accept markdown (and/or raw HTML)? is
    `HTML→markdown→HTML` lossless over those five tags? does updating a `note` preserve literal
    newlines (create has double-newline→child-node behavior)? Does not block Phase 1 (read).
- Node count of the real account — **non-blocking**; only tunes initial-index batching
  defaults. A ballpark from James helps, but a sensible default works without it.

## Packaging note

Build/package with Node 22, not 24 — Node 24 silently breaks the Electron installer build.
See memory `node24-breaks-electron-build`.
