# Phase 1: Silo Policies

Status: ready · Depends on: nothing · Unblocks: phase 6

## Goal

Give silos four generic properties that the mail module will rely on, and enforce them on every
route that can mutate or read a silo. Nothing in this phase mentions email. After it merges, a
user could hand-write a `[silos.x]` entry with `read_only = true` and Lodestone would refuse to
edit anything under it from any client.

## Properties

| Property | Where it lives | Meaning |
|---|---|---|
| `read_only` | config (`SiloTomlConfig`) | No write route may touch the silo root, its descendants, or an ancestor of it. |
| `managed_by` | config (`SiloTomlConfig`), string | The silo is owned by a module (`"mail:<account_hash>"`). Directory, `read_only` and removal are not editable through silo settings or IPC. |
| `supports_path_search` | config (`SiloTomlConfig`), default `true` | When `false`, the filepath signal is not run for this silo and `filepath` mode excludes it. |
| `available` | runtime (`SiloManager`), default `true` | When `false`, search, explore and read exclude the silo, including reads by absolute path or existing PUID. |

Plus one derived status field, `indexCaughtUp`: true when the watcher is `ready`, no reconcile
is in progress, and no debounced file events are pending. Phase 6 waits on it after a selection
change before restoring `available`.

## Touch points

`src/backend/config.ts`
- Add `read_only?: boolean`, `managed_by?: string`, `supports_path_search?: boolean` to
  `SiloTomlConfig`; parse them in `parseSiloTomlConfig`; carry them into `ResolvedSiloConfig` as
  `readOnly`, `managedBy`, `supportsPathSearch` (default `true`).
- `saveLodestoneConfig` must round-trip them.

`src/shared/types.ts`
- Add the three config fields to `SiloConfig`, and `available: boolean` and
  `indexCaughtUp: boolean` to `SiloStatus`. Both status fields are populated by `SiloManager`.

`src/backend/silo-manager.ts`
- Hold `available` (setter `setAvailable(boolean)`), default true.
- Compute `indexCaughtUp` in `getStatus()`. Check `src/backend/silo/watcher-coordinator.ts` for
  the debounce queue; if pending events are not observable today, expose a count and use it.
- `search()`: when `supportsPathSearch` is false, drop the filepath signal from the mode's
  signal list (see `MODE_SIGNALS` in `src/backend/search.ts`; pass a per-silo signal list or a
  flag through `SearchParams` rather than mutating the shared table) and return `[]` for
  `filepath` mode.

`src/backend/search-merge.ts`, `src/main/internal-api.ts`, `src/main/ipc-handlers.ts`
- `dispatchSearch` and `dispatchExplore` skip managers with `available === false`. Do this at the
  collection sites (`handleSearch`, `handleExplore`, and the IPC equivalents) so a named silo that
  is unavailable returns a clear error rather than being silently dropped.

`src/main/internal-api.ts` `handleEdit`
- This is the enforcement point. Build a `WritePolicy` from `this.ctx.siloManagers` (canonical
  read-only roots) and pass it to `executeEdit`. Do not derive it from `params.siloDirectories`,
  which the bridge process supplies; that list remains the existing boundary check only.

`src/backend/edit.ts`
- Add `WritePolicy { readOnlyRoots: string[] }` (already canonicalised) to `executeEdit`'s
  signature. Add `isProtected(path, policy)` that canonicalises the input with
  `fs.realpathSync.native` when it exists, otherwise its nearest existing ancestor plus the
  remaining segments, lower-cases and normalises separators, and returns true if the path equals
  a root, is under a root, or is an ancestor of a root. Call it on: the target of every text
  edit; `create.directory`; `mkdir.directory`; `rename.target` and the computed new path; both
  `move.target` and `finalDestination`; `delete.target`. Reject with a single message:
  `This path is inside a read-only silo and cannot be modified.` Protection is checked before
  the existing boundary check so overlapping writable silos cannot unlock it.

`src/backend/mcp/tools-search.ts` (`lodestone_read`) and `src/backend/mcp/puid-manager.ts`
- Before reading a file by PUID or absolute path, check it is not under an unavailable silo root.
  The bridge learns roots and `available` from `deps.silo.status()`. Return
  `Silo "<name>" is temporarily unavailable.` This is the only read gate needed; unavailable
  silos are already excluded from search and explore upstream.

IPC silo settings (`src/main/ipc-handlers.ts`, `src/backend/silo/silo-config-store.ts`)
- Reject changing `indexed_directories`, clearing `read_only`, or removing a silo whose
  `managed_by` is set. Return an error naming the owner.

`src/renderer/components/SiloCard.tsx`
- Show a **Read-only** badge when `readOnly`, hide the remove and directory-edit actions when
  `managedBy` is set. No other UI work in this phase.

## Tests

- `edit.test.ts` (new, next to `edit.ts`): a temp tree with a read-only root; assert every
  operation is rejected for the root, a descendant, and an ancestor; assert both ends of `move`
  are checked; assert a junction pointing into the root is rejected (create one with
  `fs.symlinkSync(..., 'junction')` on Windows, skip on other platforms); assert an overlapping
  writable silo does not unlock it.
- `search.test.ts`: with `supportsPathSearch: false`, the `filepath` signal is absent from
  `signals` in every result and `filepath` mode returns nothing.
- `silo-manager.test.ts`: `setAvailable(false)` removes the silo from `dispatchSearch` and
  `dispatchExplore` results; `indexCaughtUp` is false during reconcile and while events are
  pending, true afterwards.
- `config.test.ts`: the three new keys round-trip through load and save, and are absent from
  saved output when unset.

## Done when

- All tests above pass.
- A hand-written `[silos.ro]` with `read_only = true` cannot be edited from `lodestone_edit`
  through either the installed MCP or the dev MCP, and the error is the one message above.
- `lodestone_status` output includes `available` and `indexCaughtUp` for every silo.
- Existing silos behave exactly as before when the new keys are absent.

## Out of scope

Anything mail-specific. Config for `[mail_accounts.*]` is phase 6.
