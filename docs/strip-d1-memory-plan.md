# Strip D1 Cloud Memory — Removal Plan

**Goal:** Remove the entire D1-backed "cloud memories" subsystem (memory + tasks + projects, the
Cloudflare Worker, OAuth, Vectorize index, related GUI views). The result should be a focused
local-only file-search app: silos, search, activity, settings — nothing else.

**Why now:** Memory has moved into Claude Code's built-in memory system (`%APPDATA%\Lodestone\memory\`),
so the D1 service is redundant. Carrying it forward means maintaining two stacks for one feature,
plus heavy dependencies (Tiptap, dnd-kit, OAuth, Workers AI bindings) that the rest of the app does
not use.

---

## Scope boundaries

**Stays** (file-search core, untouched):
- Silos, watchers, embedding, reconciliation, FTS5 search, ONNX backend
- The local `lodestone-files` MCP server (over named-pipe via `mcp-wrapper.js`)
- Activity feed, Search view, Silos view, Onboarding, Settings (minus the cloud section)

**Goes** (everything D1 / cloud / tasks):
- The entire `worker/` directory and all Cloudflare-specific deploy machinery
- Renderer Tasks & Projects UI (and the Tiptap editor that powers task bodies)
- IPC handlers/preload bindings for tasks, projects, cloud URL, cloud auth token
- `MemoryConfig` block in `config.toml`
- Cloud connectivity status in the sidebar status panel
- Memory-puid (`m1`, `m2`…) handling in the local MCP server (memory was always remote)

---

## Inventory of changes

### 1. Cloudflare Worker — delete outright

Delete the whole `worker/` directory:

```
worker/
├── migrations/           — D1 schema migrations 0001…0006
├── src/
│   ├── d1/               — read.ts, write.ts, helpers.ts, inverted-index.ts
│   ├── tools/            — memory.ts, formatting.ts (MCP tool registrations)
│   ├── shared/           — memory-utils.ts, types.ts
│   ├── auth.ts, auth-handler.ts        — OAuth 2.1 flow + password auth
│   ├── d1-memory-service.ts            — main service (619 lines)
│   ├── memory-search.ts, embedding.ts  — BM25 + Workers AI Vectorize
│   ├── decaying-sum.ts, tokeniser.ts, date-parser.ts
│   └── index.ts                        — Worker entrypoint
├── wrangler.jsonc                      — D1, Vectorize, KV, AI bindings
├── package.json, package-lock.json, tsconfig.json
└── node_modules/
```

Also remove the matching scripts from root `package.json`:

```diff
-    "deploy:worker": "cd worker && npx wrangler deploy",
-    "deploy:worker:dev": "cd worker && npx wrangler deploy --env dev"
```

**External resources to clean up after merge** (manual, not in repo):
- D1 databases: `lodestone-memory` (id `e4120d3b-…`) and `lodestone-memory-dev` (id `31224b4e-…`)
- Vectorize indexes: `lodestone-memory-vectors`, `lodestone-memory-vectors-dev`
- KV namespace: `OAUTH_KV` (production + dev)
- Deployed Workers: `lodestone-mcp`, `lodestone-mcp-dev`

---

### 2. Renderer — delete Tasks/Projects/Tiptap

#### Views (delete files)
- [src/renderer/views/TasksView.tsx](src/renderer/views/TasksView.tsx) — 902 lines
- [src/renderer/views/TaskDetailView.tsx](src/renderer/views/TaskDetailView.tsx) — 292 lines

#### Components (delete files)
- [src/renderer/components/TaskRow.tsx](src/renderer/components/TaskRow.tsx)
- [src/renderer/components/TaskBodyEditor.tsx](src/renderer/components/TaskBodyEditor.tsx)
- [src/renderer/components/task-body-editor.scss](src/renderer/components/task-body-editor.scss)
- [src/renderer/components/DateRangeFilter.tsx](src/renderer/components/DateRangeFilter.tsx)
- [src/renderer/components/ProjectFilters.tsx](src/renderer/components/ProjectFilters.tsx)
- [src/renderer/components/ProjectsSubView.tsx](src/renderer/components/ProjectsSubView.tsx)

#### Components (delete partially — `TaskCells.tsx` is shared)
[src/renderer/components/TaskCells.tsx](src/renderer/components/TaskCells.tsx) exports `CellDropdown`
and `InlineDropdown`, which are imported by `SearchView` and `ActivityView`. Two options:

- **Preferred**: extract `CellDropdown` + `InlineDropdown` (and the small `useClickOutside`
  helper they rely on) into `src/renderer/components/Dropdown.tsx`, switch the two callers, then
  delete `TaskCells.tsx` entirely.
- Alternative: rewrite the two callers to use the existing Radix dropdown shadcn primitive — but
  that pulls in `@radix-ui/react-dropdown-menu` which we are otherwise removing, so don't.

#### Tiptap tree (delete entire subtrees — used only by TaskBodyEditor)
- `src/renderer/components/tiptap-extension/`
- `src/renderer/components/tiptap-icons/`
- `src/renderer/components/tiptap-node/`
- `src/renderer/components/tiptap-templates/`
- `src/renderer/components/tiptap-ui/`
- `src/renderer/components/tiptap-ui-primitive/`

#### Tiptap-only hooks/lib (delete)
- [src/renderer/hooks/use-tiptap-editor.ts](src/renderer/hooks/use-tiptap-editor.ts)
- [src/renderer/hooks/use-cursor-visibility.ts](src/renderer/hooks/use-cursor-visibility.ts)
- [src/renderer/hooks/use-menu-navigation.ts](src/renderer/hooks/use-menu-navigation.ts)
- [src/renderer/hooks/use-composed-ref.ts](src/renderer/hooks/use-composed-ref.ts)
- [src/renderer/hooks/use-element-rect.ts](src/renderer/hooks/use-element-rect.ts)
- [src/renderer/hooks/use-is-breakpoint.ts](src/renderer/hooks/use-is-breakpoint.ts)
- [src/renderer/hooks/use-throttled-callback.ts](src/renderer/hooks/use-throttled-callback.ts)
- [src/renderer/hooks/use-unmount.ts](src/renderer/hooks/use-unmount.ts)
- [src/renderer/hooks/use-window-size.ts](src/renderer/hooks/use-window-size.ts)
- [src/renderer/lib/tiptap-utils.ts](src/renderer/lib/tiptap-utils.ts)

> Verify each hook is Tiptap-only with grep before deleting. The Tiptap simple-editor template is
> the only consumer in the current code.

#### Routing
[src/renderer/App.tsx](src/renderer/App.tsx) — drop the Tasks routes:

```diff
-                  <Route path="/tasks" element={<TasksView />} />
-                  <Route path="/tasks/:id" element={<TaskDetailView />} />
```

…and the imports.

---

### 3. Sidebar — drop Tasks nav + Cloud status row

[src/renderer/components/Sidebar.tsx](src/renderer/components/Sidebar.tsx):

- Remove `CheckSquare` and `BrainCircuit` from imports
- Remove the Tasks entry from `navItems`
- Remove the `cloud-url-changed` event listener (`useEffect` lines 41–51)
- Remove both the collapsed and expanded "Cloud memories" status rows from the status panel

---

### 4. Settings — drop Cloud Memories section

[src/renderer/views/SettingsView.tsx](src/renderer/views/SettingsView.tsx:286-342):

- Delete state: `cloudUrl`, `cloudSaved`, `cloudAuthToken`, `cloudAuthTokenSaved`
- Delete handlers: `handleSaveCloudUrl`, `handleSaveCloudAuthToken`
- Delete the `<Section title="Cloud Memories">` block
- Remove `setCloudUrl`/`setCloudAuthToken` calls in the initial-load `useEffect`

---

### 5. Main process / IPC

[src/main/ipc-handlers.ts](src/main/ipc-handlers.ts):

- Delete `getCloudHeaders` (lines 27–32) and `cloudRequest` (lines 34–55)
- Delete `registerCloudTaskHandlers` (lines 517–568) entirely
- Delete `registerCloudProjectHandlers` (lines 570–609) entirely
- Remove their calls from `registerIpcHandlers` at the bottom
- In `server:status` handler (lines 611–662):
  - Drop the cloud `/health` fetch (lines 636–648)
  - Drop `cloudUrl`, `cloudConnected`, `cloudAuthToken` from the returned object
- Delete the `cloud:setUrl` and `cloud:setAuthToken` handlers (lines 684–697)

[src/preload.ts](src/preload.ts) — drop the matching exposed API entries:
- `setCloudUrl`, `setCloudAuthToken`
- All Tasks IPC: `listTasks`, `searchTasks`, `reviseTask`, `skipTask`, `createTask`, `deleteTask`, `updateDayOrder`, `deleteDayOrder`
- All Projects IPC: `listProjects`, `createProject`, `updateProject`, `deleteProject`, `mergeProjects`, `archiveProject`, `unarchiveProject`

---

### 6. Shared types

[src/shared/electron-api.d.ts](src/shared/electron-api.d.ts):
- Remove imports of `MemoryRecord`, `MemoryStatusValue`, `PriorityLevel`, `ProjectWithCounts`
- Remove the Cloud, Tasks, and Projects sections (lines 93–122)

[src/shared/types.ts](src/shared/types.ts):
- Remove memory/task/project types (lines 224–286): `MemoryStatusValue`, `PriorityLevel`,
  `MemoryRecord`, `ProjectRecord`, `ProjectWithCounts`, `MemorySearchResult`,
  `RelatedMemoryResult`, `MemoryStatus`
- From `ServerStatus` (lines 292–307): drop `cloudUrl`, `cloudConnected`, `cloudAuthToken` and
  their JSDoc

---

### 7. Config schema

[src/backend/config.ts](src/backend/config.ts):
- Delete `MemoryConfig` interface (lines 64–69)
- Delete `memory: MemoryConfig` from `LodestoneConfig` (line 76)
- Drop `memory: {}` from `DEFAULT_CONFIG` (line 105)
- Drop the `memory` parsing block from `loadConfig` (lines 122 + 167–170)

> **Migration note:** existing user configs with `[memory] cloud_url = …` are harmless. Once
> `MemoryConfig` is removed from `LodestoneConfig`, `loadConfig` simply doesn't read those keys,
> and the next call to [`saveConfig`](src/backend/config.ts:179) — which serialises the in-memory
> typed config — will rewrite the TOML without the `[memory]` block. No separate cleanup pass
> needed.

---

### 8. Local MCP server — drop memory-puid handling

The local `lodestone-files` MCP server has dead code that exists only to redirect the LLM to the
(now-removed) memory server.

[src/backend/mcp/puid-manager.ts](src/backend/mcp/puid-manager.ts:162-176):
- Delete `isMemoryPuid`, `parseMemoryId`, `resolveMemoryIdParam`

[src/backend/mcp/tools-search.ts](src/backend/mcp/tools-search.ts:97-104):
- Delete the `if (PuidManager.isMemoryPuid(id))` branch in `lodestone_read`

[src/backend/mcp/tools-edit.ts](src/backend/mcp/tools-edit.ts):
- Delete the three `// Memory references are handled by the cloud Worker` branches at lines 423,
  480, 551

[src/backend/mcp/index.ts](src/backend/mcp/index.ts:44):
- The `patchWithDatetimeFooter` wrapper appends `💡 Save learnings with lodestone_remember
  (on lodestone-memory)` to every tool result. Drop the lodestone_remember line — keep just the
  `🕐 ${buildDatetime()}` line, or remove the patch entirely if a minute-resolution timestamp on
  every response is no longer wanted.

[src/backend/mcp/formatting.ts](src/backend/mcp/formatting.ts) — has dead surface once memory
types go:
- Drop `MemoryStatusValue, PriorityLevel` from the import on line 6
- Delete the memory-only exports (none are used outside this file once the worker is gone):
  `MEMORY_PREVIEW_CHARS`, `truncateMemoryBody`, `memoryBodyWarning`, `priorityLabel`,
  `statusLabel`, `buildDateContext`
- Delete the m-prefixed ID notes inside the long tool description strings (lines 340–341 and
  408–409 — they refer to `lodestone_revise`/`lodestone_forget`/`lodestone-memory`)
- Keep `buildDatetime`, `MAX_READ_BYTES`, `PREVIEW_LINES`, `formatBytes`, `getParentDirPath`,
  `formatSearchResults`, `formatExploreResults`, and the four `*_DESCRIPTION` constants — all
  used by the local file tools

> Note: helpers like `textResult`, `withErrorHandling`, `resolveMemoryId`, `isActionOverdue`,
> `isDuePastDue`, `parseFlexibleDateField`, `buildMetaLines` live in
> `worker/src/tools/formatting.ts`, not here. They get deleted as part of the worker directory
> removal — no separate work needed.

[src/backend/mcp/resources.ts](src/backend/mcp/resources.ts):
- In `STARTUP_GUIDE` (lines 17–37): drop the "Memory Server" section and the mention of
  `lodestone_recall` from the bullet list
- In `NOTES_GUIDE` (line 47): drop the parenthetical "(on the lodestone-memory server)" so the
  local `lodestone_get_datetime` reference still makes sense — but note that
  `lodestone_get_datetime` was *only* registered on the worker. Either:
    1. Add a tiny `lodestone_get_datetime` tool to the local MCP server (one-liner using
       `buildDatetime()`), **or**
    2. Drop the datetime mention from the notes guide entirely.

### 8a. Dead shared/portable code

[src/shared/portable/date-parser.ts](src/shared/portable/date-parser.ts) was only used by the
worker (which copies it) and by [src/backend/date-parser.test.ts](src/backend/date-parser.test.ts).
After the worker is gone, both the source and the test are dead. Delete both.

The other two files in `src/shared/portable/` (`tokeniser.ts` and `decaying-sum.ts`) stay — they
are used throughout the local file-search pipeline (`store/operations.ts`, `search.ts`,
`scorers/`, `mcp/formatting.ts`).

---

### 9. package.json — prune dependencies

After tasks/Tiptap are gone, the following dependencies have zero remaining importers and should
be removed:

| Package | Used by |
|---|---|
| `@dnd-kit/core` | TasksView only |
| `@dnd-kit/sortable` | TasksView only |
| `@dnd-kit/utilities` | TasksView only |
| `@floating-ui/react` | tiptap-ui-primitive only |
| `@radix-ui/react-dropdown-menu` | tiptap-ui-primitive only |
| `@radix-ui/react-popover` | tiptap-ui-primitive only |
| `@tiptap/*` (all 25 entries) | TaskBodyEditor only |
| `tiptap-markdown` | TaskBodyEditor only |
| `y-protocols` | Tiptap collab |
| `yjs` | Tiptap collab |

**Keep** `@radix-ui/react-tooltip` — it's used by `components/ui/tooltip.tsx` → `SiloCard.tsx`.

**Keep** `pdfjs-dist`, `gray-matter`, `unified`, `remark-parse`, `mdast-util-to-string`, `diff` —
they're all in the file-indexing pipeline.

> Run `npm run lint && npm run test` after pruning to catch any missed imports. Then a `npm prune`
> + commit of the new lock file.

---

### 10. Documentation

- [CLAUDE.md](CLAUDE.md): drop the cloud-memory rows from the MCP identity map (the two UUID
  prefixes `e81c08be-…` and `61402c1d-…`). Mention only `mcp__lodestone-files__` and the dev
  variant. Drop the "Call lodestone_guide on each server" line — there's only one server now.
- [AGENTS.md](AGENTS.md): identical surgery — same UUID rows, same `lodestone_guide on each
  server` line. Leaving these in will keep Codex agents trying to reach the dead worker.
- `MEMORY.md` (user-level, not in repo but worth updating): the "MCP Server" architecture note
  about Claude Desktop integration is unchanged. The "Architecture Notes" entry mentioning
  Cloudflare Worker can come out if you keep that file in sync.

---

## Suggested execution order

Each step should end green so the work is bisectable. There is no `typecheck` script in
[package.json](package.json) today — define "green" as **`npm run lint && npm run test`**, plus
a `npm start` smoke check at the end of each major chunk. Optionally add a `"typecheck": "tsc
--noEmit"` script as a one-line prelude to step 1 to make the bar more rigorous.

1. **Decouple shared dropdowns** — extract `CellDropdown`/`InlineDropdown` from `TaskCells.tsx`
   into a new `Dropdown.tsx`; switch `SearchView` and `ActivityView` to it. No behavioural change.
2. **Remove the routes & sidebar entry** — `App.tsx` and `Sidebar.tsx`. The Tasks pages become
   unreachable but their files still compile.
3. **Delete Tasks/Projects view & component files** — TasksView, TaskDetailView, TaskRow,
   TaskCells, TaskBodyEditor + scss, DateRangeFilter, ProjectFilters, ProjectsSubView.
4. **Delete the Tiptap tree** — six `tiptap-*` directories under `components/`, the
   `use-tiptap-editor`/cursor/menu/composed-ref/element-rect/is-breakpoint/throttled/unmount/window-size
   hooks, `lib/tiptap-utils.ts`.
5. **Strip the IPC bridge** — `ipc-handlers.ts` cloud helpers + task/project handlers + cloud
   fields in `server:status` + cloud setters; `preload.ts` matching entries; `electron-api.d.ts`
   types; `types.ts` memory/task/project types and `ServerStatus` cloud fields.
6. **Drop Cloud Memories from Settings** — `SettingsView.tsx`.
7. **Prune the config schema** — `config.ts` `MemoryConfig` and parsing.
8. **Clean up the local MCP server** — remove memory-puid branches in `puid-manager.ts`,
   `tools-search.ts`, `tools-edit.ts`; strip the `lodestone_remember` line from the
   datetime-footer patch in `index.ts`; gut the memory helpers and m-prefixed ID notes from
   `formatting.ts`; trim guide content in `resources.ts`. Decide datetime-tool fate.
9. **Delete `src/shared/portable/date-parser.ts` and `src/backend/date-parser.test.ts`** — both
   are dead once the worker is gone.
10. **Delete the `worker/` directory** and the two `deploy:worker*` scripts.
11. **Prune `package.json` dependencies** and refresh the lockfile.
12. **Update CLAUDE.md and AGENTS.md** (MCP identity map, drop the two cloud-memory UUID rows,
    drop the "lodestone_guide on each server" line in both).
13. **Smoke test**: `npm start`, create a silo, run a search, watch activity, verify the sidebar
    no longer shows the cloud memories row, verify settings has no cloud section.
14. **Out of repo**: tear down Cloudflare D1 / Vectorize / KV / Workers (manual, after release).

---

## Risks & open questions

- **User data on D1**: any tasks/projects/memories the user has stored in production D1 will be
  unrecoverable from this codebase after the worker is deleted. If a final export is wanted, do it
  via wrangler **before step 10** (`wrangler d1 execute lodestone-memory --command "SELECT …"
  --json`).
- **Existing `config.toml` `[memory]` blocks**: harmless. After `MemoryConfig` is removed,
  `loadConfig` ignores those keys, and the next `saveConfig` call rewrites the file without them.
  No cleanup pass needed.
- **`lodestone_get_datetime` tool**: it was on the worker, not the local server. The notes guide
  references it. Decide: re-implement locally (~10 lines) or drop the reference.
- **MCP guide endpoint**: with one server there's no longer a "two servers" message in the
  startup guide. Tighten the wording.
- **App version bump**: this is a substantive feature removal — tag as a minor or major version
  jump in `package.json` and write a clear changelog/release note for users who relied on tasks.

---

## Quick stats (rough lines deleted)

| Area | Approx LOC |
|---|---|
| `worker/` | ~3,500 |
| Renderer Tasks/Projects + Tiptap | ~6,000 |
| IPC handlers + preload + types + Settings + Sidebar | ~400 |
| Local MCP server cleanup | ~80 |
| **Total** | **~10,000 LOC removed** |

Plus ~30 npm dependencies, the entire `worker/node_modules`, and four pieces of Cloudflare
infrastructure.
