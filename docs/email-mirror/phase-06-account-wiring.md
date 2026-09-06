# Phase 6: Account Wiring

Status: ready · Depends on: phases 1, 3, 4, 5 · Unblocks: phase 7

## Goal

Connect the backend pieces to the running application: configuration, an account registry in
`AppContext`, a scheduler that runs rounds, registration of the mirror directory as a managed
read-only silo, the selection-change and removal flows, and the IPC surface the phase 7 UI
will call. After this phase an account can be created by editing `config.toml` by hand and
running a one-off `saveCredential` from the dev console, and it will sync, index and search.

## Deliverables

`src/backend/config.ts`
- `MailAccountTomlConfig` and a `mail_accounts: Record<string, MailAccountTomlConfig>` section
  in `LodestoneConfig`, parsed by a new `parseMailAccountsConfig` that is independent of
  `parseSiloTomlConfig`. Fields per [design.md](design.md#configuration). Validation: `port`
  is an integer in 1 to 65535; `credential_kind` is one of the two values; `oauth_client_id`
  required when `oauth`; `silo_name` non-empty; `received_after` is RFC 3339 or `"unlimited"`;
  `selection_mode = "explicit"` requires a non-empty `selected_folders`.
- The key of each entry is the `account_hash`; reject an entry whose hash does not match
  `accountHash(accountUid(host, port, username))`.
- `mailDataDir(userData, hash)` helper returning `<userData>/mail/<hash>` and the `mirror`,
  `tmp`, `manifest.sqlite` and `credential.bin` paths under it.

`src/backend/mail/account.ts`
- `class MailAccount` owning: resolved config, `Manifest`, `MirrorDirs`, the adapter factory,
  the `Synchroniser`, and a `SyncScheduler`.
- `SyncScheduler`: startup trigger, interval timer, and `syncNow()`, coalesced into one queued
  run. Backoff on `'failed'`: 5 s doubling to 5 min with jitter, reset on `'completed'`. On
  `'budget-exhausted'` reschedule immediately after a 1 s yield. On `'auth-required'` set
  `syncState = 'reauthorisation-required'` and stop the timer until `reconnect()` is called.
- `status(): MailAccountStatus { accountHash; displayName; credentialKind; syncState; lastRoundCompletedAt; lastError; messageCount; selectionSummary }`.
- `applySelection(newSelection)`: bump `selection_revision`, set the silo unavailable, run a
  round to completion (looping on `'budget-exhausted'`), then wait until the silo's
  `indexCaughtUp` is true, then set it available. Expose progress through `status()`.
- `remove()`: set unavailable, cancel and await the running round, close the adapter, delete
  `mirror`, `tmp`, `manifest.sqlite`, `credential.bin`, then return so the caller can remove
  the silo and the config entry. Each step is retryable; record which step failed.

`src/main/context.ts`
- `mailAccounts: Map<string, MailAccount>` on `AppContext`, built after `siloManagers` so each
  account can find its silo by `silo_name`.

`src/main/lifecycle.ts`
- On startup: for each `[mail_accounts.*]` entry, ensure the silo entry exists with the three
  policy keys and `indexed_directories = [mirrorDir]` (create it if missing, since the config may
  have been hand-edited), construct the `MailAccount`, run `repairManifest`, and start its
  scheduler. On shutdown: stop schedulers and await in-flight rounds with a 10 s cap.
- Startup ordering: silos first so the mirror silo is watching before the first round writes
  files; otherwise the initial sync's files would only be picked up by the next reconcile.

`src/main/ipc-handlers.ts` (renderer-facing) and `src/main/internal-api.ts` (MCP-facing)
- IPC only; nothing new over the named pipe, since MCP clients see mail through ordinary silos.
- `mail:list` → `MailAccountStatus[]`.
- `mail:test-connection` `{ host, port, username, auth }` → `{ ok, folders?: Folder[], error? }`.
  Runs `listFolders` on a throwaway adapter and closes it. For `auth.kind === 'password'` the
  password arrives in the message; for `oauth` the renderer passes the pasted callback URL and
  the main process completes the pending authorisation it started in `mail:begin-oauth`.
- `mail:begin-oauth` `{ clientId, loginHint }` → `{ url }`. Stores the pending authorisation in
  memory keyed by a nonce, opens the URL with `shell.openExternal`.
- `mail:create` `{ config: MailAccountTomlConfig minus hash, credential }` → creates the data
  dir, saves the credential, writes the config entry and the silo entry, constructs and starts
  the account. Returns the hash.
- `mail:update-settings` `{ hash, patch }` for timer, silo name, selection, `received_after`;
  selection or cutoff changes go through `applySelection`.
- `mail:reconnect` `{ hash, credential }`: replaces the credential, resets `syncState`, restarts
  the scheduler.
- `mail:sync-now` `{ hash }`, `mail:remove` `{ hash }`, `mail:retry-remove` `{ hash }`.
- Renderer never receives a credential, refresh token or access token in any response.

`src/preload.ts`
- Expose the above under `window.lodestone.mail`.

Logging
- All log lines from `src/backend/mail/` go through a `MailLogger` that is given the
  `account_hash` at construction and refuses string arguments containing `@` (cheap guard
  against accidental address logging; fail the test suite if it fires).

## Tests

- `config.test.ts`: `[mail_accounts.*]` parses, validates and round-trips; a mismatched hash
  key is rejected; the silo entry linkage by `silo_name` resolves.
- `account.test.ts` with the fake adapter, in-memory credential store and a fake clock:
  scheduler coalesces overlapping triggers; backoff sequence on repeated `'failed'`;
  `'auth-required'` stops the timer and `reconnect()` restarts it; `applySelection` sets the
  silo unavailable, runs to completion, waits for a stubbed `indexCaughtUp`, then restores;
  `remove()` deletes every artefact and reports the failing step when one is injected.
- `lifecycle.test.ts` (or extend the existing one): startup with one mail account creates a
  missing silo entry with the policy keys and starts the scheduler; shutdown stops it.

## Done when

- With a hand-written `[mail_accounts.*]` entry and a credential saved from the dev console,
  Lodestone starts, mirrors the mailbox, the silo shows in the sidebar with the read-only badge,
  and `lodestone_search` from Claude Code returns email hits interleaved with files.
- `lodestone_edit` against a mirror file is rejected with the phase 1 message.
- Killing Lodestone mid-round and restarting converges without duplicate or missing files.
- Removing the account from the dev console leaves nothing under `<userData>/mail/<hash>` and no
  silo entry.
