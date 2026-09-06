# Phase 3: Manifest and Synchroniser

Status: ready · Depends on: phase 2 · Unblocks: phases 4, 6

## Goal

The round-based synchronisation algorithm from [design.md](design.md#synchronisation), driven
entirely against an in-memory fake adapter, with the crash-safety properties proven by tests. No
real IMAP, no Electron, no scheduling. Phase 6 wires it to timers and the app; phase 4 supplies
the real adapter.

## Deliverables

All under `src/backend/mail/`.

`adapter.ts`
- The `MailAdapter` interface exactly as in the design:
  `listFolders()`, `listMessages(folder)`, `fetchMessage(messageKey)`, plus `close()`.
- `AdapterError` with a `kind` of `'auth' | 'transient' | 'not-found' | 'unsupported' | 'encrypted' | 'protocol'`.
  The synchroniser branches on `kind` only; never on message text.

`fake-adapter.ts` (test helper, but shipped in `src/` so phase 6 can use it for a dev mode)
- In-memory folders, messages, labels, `UIDVALIDITY` per folder.
- Mutators for tests: `addMessage`, `deleteMessage`, `moveMessage`, `setLabels`, `setFlags`,
  `bumpUidValidity`, `addFolder`, `removeFolder`.
- Fault injection: `failListingAfter(folderKey, n)`, `failFetch(messageKey, kind)`,
  `throttleNext(n)`.
- A command log (`string[]`) of the abstract operations invoked, so tests can assert the
  synchroniser never calls anything outside the interface.

`manifest.ts`
- `openManifest(path): Manifest` using `better-sqlite3` (already a dependency), WAL mode,
  `synchronous = FULL`. Schema per the design (`state`, `folder`, `message`, `membership`).
  Migrations via a `schema_version` key in `state`; version 1 now.
- Typed methods, no raw SQL outside this file: `getState`/`setState`, `upsertFolder`,
  `deleteMembershipForFolders(keys)`, `upsertMembership(...)`, `markListingComplete(folderKey, round)`,
  `deleteUnseenMembership(folderKey, round)`, `messagesWithoutMembership()`, `insertMessage`,
  `updateMessageHash`, `deleteMessage`, `selectedFolders()`, `folderUidValidity(key)`.
- Every method that the synchroniser calls after a file operation runs in its own transaction.

`mirror-files.ts`
- `MirrorDirs { mirror: string; tmp: string }` and `ensureDirs`.
- `writeMirrorFile(dirs, fileName, content): Promise<void>`: write to
  `tmp/<fileName>.<random>`, `fsync`, `rename` into `mirror/`. On Windows, `rename` over an
  existing file requires the destination to be unlocked; retry twice with a short delay on
  `EPERM`/`EBUSY` before failing.
- `deleteMirrorFile(dirs, fileName)`: idempotent.
- `cleanTmp(dirs)`: remove everything in `tmp/`. Called at construction.

`sync.ts`
- `class Synchroniser` constructed with `{ adapter, manifest, dirs, accountUid, selection, budgetMs, clock, log }`.
  `selection` is `{ receivedAfter: Date | null; mode: 'default' | 'explicit'; folderKeys: string[]; revision: number }`.
- `runRound(): Promise<RoundOutcome>` implementing steps 1 to 5 of the design. `RoundOutcome`
  is `'completed' | 'budget-exhausted' | 'auth-required' | 'failed'`.
- The round number is read from `state.current_round`; a `completed` outcome increments it.
  `budget-exhausted` leaves it unchanged so the next call resumes the same round.
- Budget is checked only between `fetchMessage` calls.
- File then row: `writeMirrorFile` resolves before `insertMessage`/`updateMessageHash`; on
  delete, `deleteMirrorFile` resolves before `deleteMessage`.
- Re-render decision: compare the rendered content hash against `message.content_hash`; rewrite
  only when different. This covers flag, folder and label changes in one rule.
- Gmail: `folders` for the file come from `entry.labels`; otherwise from the folder paths of
  the message's `membership` rows. Skip entries whose labels include `\Draft`.
- On `AdapterError.kind === 'auth'` return `'auth-required'` immediately. On `'transient'`
  return `'failed'`; backoff is the scheduler's job (phase 6), not this class's.
- Logging via the injected `log` with `account_hash` only.

`startup-repair.ts`
- `repairManifest(manifest, dirs)`: for each `message` row whose file is missing, delete the
  row (it will be refetched); for each file in `mirror/` with no row, delete the file (it will be
  rewritten if still selected). Run once before the first round after process start.

## Tests

`sync.test.ts` against `fake-adapter.ts` and a temp directory. Use a fixed clock.

- First round mirrors everything in the default selection; drafts, junk and trash absent.
- New message appears after the next round; deleted message's file is gone after the next
  complete round; a message moved between folders keeps one file and updates `folders`.
- Gmail mode: label-only change rewrites the file; `\Draft` entries never produce files; a
  message with two labels produces one file.
- Listing failure part way through a folder: nothing deleted, `listed_complete_in_round`
  unchanged, next round converges.
- Fetch failure with `kind: 'transient'` stops the round at that message; the folder's deletion
  step has not run; next round completes.
- Fetch failure with `kind: 'not-found'` removes the membership.
- Budget exhaustion after N fetches returns `'budget-exhausted'`; calling `runRound` again
  continues without re-fetching the first N; round number unchanged until completion.
- `UIDVALIDITY` change on one folder re-mirrors that folder and leaves other folders' files
  untouched throughout.
- Selection narrowed (folder deselected): its membership rows are gone after step 1 and its
  files are gone after step 5. Selection cutoff moved later: older messages removed.
- Crash injection: wrap `writeMirrorFile` and the manifest methods with a helper that throws at
  a chosen call index; for each of (after rename, before insert), (after insert, before
  `markListingComplete`), (after `deleteMirrorFile`, before `deleteMessage`), run the round to
  the throw, then run `repairManifest` and a fresh round, and assert the mirror directory and
  manifest equal the no-crash result byte for byte.
- Rendering is idempotent: two rounds with no server change perform zero writes (assert via a
  spy on `writeMirrorFile`).
- Command log from the fake contains only the interface's operations.

## Done when

- All tests above pass.
- `Synchroniser` has no dependency on `imapflow`, `electron`, timers, or `src/main/`.
- Running two rounds back to back with no changes writes nothing.
