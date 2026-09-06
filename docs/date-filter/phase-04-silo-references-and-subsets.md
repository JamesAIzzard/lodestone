# Phase 4: Silo References and Subsets

Status: ready · Depends on: phase 3 · Unblocks: phase 5

## Goal

A client can address silos the way it addresses files and directories, and can search or
explore a chosen subset of them in one call. `lodestone_status` labels each silo with a session
reference `s1`, `s2`, and so on, every result line shows the silo's reference next to its name,
and the `silo` parameter on `lodestone_search` and `lodestone_explore` accepts a name or a
reference, or an array of them. Silo selection moves into one helper in the main process so the
two copies that exist today, and the two that phase 5 adds, share it.

Today the parameter is one name or nothing. Covering three of ten silos takes three calls and
three separately truncated result lists. Mail silo names such as `Mail: someone@example.com` are
also awkward to pass, and `s2` is not.

## Semantics

- `s` references are session-scoped and never reset, like `r` and `d`. A silo gets the next
  number the first time its name appears in any tool output: a status heading, a search or
  explore result line, or a phase 5 listing. Calling `lodestone_status` first numbers the silos
  in status order.
- References resolve to names in the MCP process, before the pipe. Everything behind the pipe
  sees names only.
- `silo` accepts a string or a non-empty array of strings. Each entry is an `s` reference or a
  name. A known reference wins over a name that happens to look like one. Entries are
  deduplicated in order.
- An unknown reference is an error before any call:
  `Unknown silo reference "s9". Use lodestone_status to obtain a fresh reference.`
- An unknown, stopped or unavailable name anywhere in the array fails the whole call with the
  existing message for that condition. There are no partial subsets.
- A reference to a silo that has since been removed or renamed resolves to its old name and
  fails as not found. A fresh status call gives the renamed silo a new reference.
- Results from a subset merge and truncate exactly as an unrestricted search does.

## Changes

`src/backend/mcp/puid-manager.ts`
- Third counter `sCounter`, with `siloNameToPuid` and `siloPuidToName` maps. Update the header
  comment that lists the counters.
- `assignSiloPuid(name): string`, idempotent per name.
- `resolveSiloPuid(id): string | undefined`.
- `static isSiloPuid(id)`: `/^s\d+$/`.

`src/backend/mcp/response-helpers.ts`
- `resolveSiloRefs(silo: string | string[] | undefined, puid): string[] | undefined | CallToolResult`.
  Undefined stays undefined. Otherwise normalise to an array, replace each `s` reference with
  its name, return the unknown-reference error for one that does not resolve, and dedupe
  preserving order. The shape mirrors `resolveDirPuid`.

`src/backend/mcp/tools-search.ts`
- Search and explore schemas:
  `silo: z.union([z.string(), z.array(z.string()).min(1)]).optional()`, described as
  `Restrict to one or more silos, by name or by s-reference from lodestone_status (omit to use all).`
- Both handlers call `resolveSiloRefs` first and return its error if it gives one, then pass the
  resolved array as `silo`. `notifyActivity` gets the single name when exactly one silo is
  selected and no name otherwise, which shimmers every card as an unrestricted search does
  today.
- `registerStatusTool(server, deps, puid)`: the heading becomes `## s1: notes`. Update the call
  in `src/backend/mcp/index.ts`.

`src/backend/mcp/types.ts` and `src/main/mcp-bridge.ts`
- `silo?: string[]` on `search` and `explore`. The bridge passes it through.

`src/backend/mcp/formatting.ts`
- `formatSearchResults` and `formatExploreResults`: the silo line becomes
  `Silo: notes (s1) | Score: …`, assigning through `puid.assignSiloPuid`. Both already take
  `puid`.
- `SEARCH_DESCRIPTION` and `EXPLORE_DESCRIPTION`: the closing status sentence becomes
  `Use lodestone_status to see available silos, their s-references and their current state. silo accepts names or references, singly or as an array.`

`src/backend/mcp/resources.ts`
- Startup guide, after the tools list:
  `lodestone_status labels each silo with an s reference. silo on search and explore takes a name or a reference, or an array of them.`

`src/main/silo-selection.ts` (new)
- `selectSilos(siloManagers, names: string[] | undefined): [string, SiloManager][]`. With
  names: look each up in order; unknown throws `Silo "x" not found`, stopped throws
  `Silo "x" is stopped`, unavailable throws `Silo "x" is temporarily unavailable.`; dedupe.
  Without names: every manager that is not stopped and is available. These are the messages
  the two handlers throw today, moved rather than reworded.
- `siloWarnings(ready, needsEmbedding): Promise<string[]>`: the readiness loop from
  `handleSearch`, producing the "still initializing" warning only when `needsEmbedding` and the
  indexing warning always.
- `toSiloNames(value: unknown): string[] | undefined`: accepts a string, an array of strings or
  undefined, for the two request edges.

`src/main/internal-api.ts`
- `handleSearch` and `handleExplore` replace their selection blocks with
  `selectSilos(this.ctx.siloManagers, toSiloNames(params.silo))` and their warning loops with
  `siloWarnings`. The `mcp:activity` event carries the single name when one silo is selected
  and none otherwise. The embedding-service filter in `handleSearch` stays where it is.

`src/main/ipc-handlers.ts`, `src/preload.ts`, `src/shared/electron-api.d.ts`, `src/shared/types.ts`
- `silos:search` takes `siloName?: string | string[]` and `ExploreParams.silo` becomes
  `string | string[]`. Both handlers use `selectSilos`. The renderer keeps sending one name and
  its silo dropdown is unchanged.

## Tests

`src/backend/mcp/puid-manager.test.ts` (new)
- Sequential assignment, idempotence per name, unknown reference resolves to undefined,
  `isSiloPuid` accepts `s12` and rejects `s`, `r1` and `s1x`.

`src/backend/mcp/response-helpers.test.ts` (new)
- A string, an array, a mix of names and references, duplicates in either form, and an unknown
  reference returning the error response.

`src/backend/mcp/tools-search.test.ts`
- After `puid.assignSiloPuid("alpha")`, `silo: ["s1", "notes"]` reaches `deps.silo.search` as
  `["alpha", "notes"]`. The fixture needs to expose its `PuidManager`.
- `silo: "s9"` returns the unknown-reference error and calls neither `search` nor
  `notifyActivity`.
- `notifyActivity` receives the name for one silo and no name for two.

`src/backend/mcp/formatting.test.ts`
- Search and explore silo lines carry `(s1)`, and the same silo gets the same reference across a
  search result and an explore result formatted with the same `PuidManager`.

`src/main/silo-selection.test.ts` (new, fake managers with `isStopped` and `isAvailable`)
- Undefined selects every running available silo; an array selects in order and dedupes;
  unknown, stopped and unavailable each throw with the existing message and nothing is
  returned.
- `siloWarnings` gives the initializing warning only when embedding is needed.

`src/backend/mcp/resources.test.ts`
- The startup guide mentions `s` references.

## Acceptance

Against the installed build after a normal install. No schema change.

- `lodestone_status` shows `s1` to `sN` headings. A search with `silo: ["s1", "s3"]` returns
  hits only from those two silos, and their result lines show `(s1)` and `(s3)`.
- The same with one name and one reference mixed.
- `silo: "s99"` returns the unknown-reference error. `silo: ["s1", "nope"]` returns
  `Silo "nope" not found` and no results.
- `lodestone_explore` with an array of two silos lists directories from both.
- Renaming a silo in the app, then searching with its old reference, fails as not found. A fresh
  status call shows it under a new reference.
- The app's silo dropdown behaves as before.

## Done when

- All tests above pass, `npm run typecheck` and `npm run lint` are clean.
- `handleSearch`, `handleExplore` and both IPC handlers contain no silo-selection loop of their
  own.
- The acceptance bullets are recorded in this folder's acceptance note.

## Out of scope

- Multi-select in the app's silo dropdown.
- References in warning text, which keeps names.
- `s` references on `lodestone_edit` or `lodestone_read`, which address files.
- Reassigning a reference after a rename.
