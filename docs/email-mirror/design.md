# Email Mirror Design

Status: settled · Branch: `develop` · Last updated: 2026-09-06

This is the repository copy of the design. The phase docs in this folder implement it. Where a
phase doc and this document disagree, fix the disagreement rather than picking one.

## Summary

Build a Windows-only module that mirrors selected email into local Markdown files, one file per
message, inside a read-only Lodestone silo per mailbox. Nothing else changes: the existing
watcher, chunker, embedder and ranker index the mirror like any other folder, so email hits appear
in the same ranked result set as files, and `lodestone_read` reads a message the same way it
reads a note. The module adds no MCP tools.

The module never sends mail and never changes anything on the server. Its credentials are
ordinary IMAP credentials, which are not read-only by nature; the read-only guarantee comes from
the adapter, which selects mailboxes with `EXAMINE`, fetches with `PEEK`, and issues no command
that can alter server state.

Every mailbox is reached over IMAP. The only thing that differs between providers is how the
credential is obtained: a password (Gmail app password, Fastmail, any ordinary host) or an OAuth2
refresh token for Microsoft 365 obtained with Thunderbird's registered client ID. That client ID
is a tested dependency, not a general guarantee: on 2026-09-06 both the Swansea and Nuanced Bio
tenants issued a token for it with the IMAP scope, and `outlook.office365.com:993` accepted each
token.

Out of scope: calendar, attachment download, live reads, threading tools, Microsoft Graph,
Gmail's native API, EWS, Exchange on-premises, shared mailboxes, and any server write operation.

## Adapter

One IMAP adapter, built on `ImapFlow`, is constructed for one account with its decrypted
credential and exposes three operations.

```text
listFolders()                    -> Folder[]
listMessages(folder)             -> AsyncIterable<Entry>
fetchMessage(message_key)        -> Message
```

A `Folder` has an opaque `folder_key`, a display `path`, and a `role` of `inbox`, `sent`,
`drafts`, `junk`, `trash`, `archive`, `all` or `other`. An `Entry` has `message_key`,
`received_at` (RFC 3339 UTC), `seen`, `flagged` and, on Gmail, `labels`. `listMessages` yields
every message currently in the folder that satisfies the account's date cutoff and finishes only
when the listing is complete; an error before that point means the listing is incomplete. A
`Message` has the parsed headers, the chosen body part (text, its MIME type, and a
`body_status`), and the attachment list (name, MIME type, size). The adapter has no other public
methods.

The adapter issues only these commands: `CAPABILITY`, `ID`, `ENABLE`, `AUTHENTICATE`, `NOOP`,
`LOGOUT`, `LIST`, `STATUS`, `EXAMINE`, `UID SEARCH` and `UID FETCH` with `PEEK` sections only.
It never issues `SELECT`, `STORE`, `COPY`, `MOVE`, `APPEND`, `EXPUNGE`, `CREATE`, `DELETE`,
`RENAME` or `SUBSCRIBE`. Open one connection per account. Determine folder roles from
SPECIAL-USE attributes, falling back to the case-insensitive names `Drafts`, `Junk`, `Spam`,
`Trash`, `Deleted`, `Sent`, `Archive`.

`listMessages` for a folder issues `UID SEARCH SINCE <cutoff date>` (day granularity, may
over-include), then `UID FETCH <set> (UID INTERNALDATE FLAGS)`, adding `X-GM-MSGID X-GM-LABELS`
on Gmail, and applies the exact cutoff to `INTERNALDATE`. If `UIDVALIDITY` differs from the
manifest's stored value, every manifest entry for that folder is treated as removed and the
folder is enumerated from scratch.

`fetchMessage` never downloads a whole message. It fetches `BODYSTRUCTURE` and
`BODY.PEEK[HEADER]`, chooses the body part by walking the structure (first `text/plain` leaf
outside any attachment disposition; otherwise first `text/html` leaf; on `multipart/alternative`
prefer plain), and fetches only that part with a partial fetch `BODY.PEEK[<section>]<0.2097152>`.
If the part's declared size exceeds 2 MiB the body is `truncated`. If no text leaf exists the
body is `unsupported`; if the only candidates are `multipart/encrypted` or
`application/pkcs7-mime` it is `encrypted`. The attachment list is read from `BODYSTRUCTURE`
(disposition `attachment`, or any non-text leaf with a filename); attachment bytes never leave
the server. The adapter decodes the part's content-transfer-encoding and charset and returns
text.

`message_key` is `uid:<folder_key>:<UIDVALIDITY>:<UID>`, where `folder_key` is the
UTF-7-decoded mailbox path. A message copied into two folders yields two mirror files; accept
this.

If the server advertises `X-GM-EXT-1` (Gmail), the only folder offered is the one carrying the
`\All` attribute, with role `all`; do not depend on its English path. `message_key` is
`gm:<X-GM-MSGID>`. Entries whose `X-GM-LABELS` include `\Draft` are skipped, since All Mail
contains drafts. The label list is the message's `folders` and is persisted in the manifest so
that a label-only change is detected on the next listing. All Mail excludes Spam and Trash and
includes Sent, so one folder gives the whole selectable mailbox and every message appears once.
Gmail requires 2-step verification and an app password; the connection form says so.

## Accounts and Credentials

`account_uid` is `imap:<host>:<port>:<username>`, with the host lower-cased and the username
preserved exactly as entered, since some servers treat it case-sensitively. `account_hash` is the
first 32 hex characters of SHA-256 over `account_uid`. Connecting an identity that already exists
updates its credential and changes nothing else. Email addresses are display information only.

A credential is one of two kinds.

`password`: the IMAP password or app password, sent with `AUTH=PLAIN` over TLS.

`oauth`: an OAuth2 refresh token, sent as `AUTH=XOAUTH2` with a freshly minted access token.
Lodestone has no app registration of its own; the client ID is a per-account setting whose
default is Thunderbird's, `9e5f94bc-e8a4-4e73-b8be-63364c29d753`, with authorisation endpoint
`https://login.microsoftonline.com/common/oauth2/v2.0/authorize`, token endpoint
`https://login.microsoftonline.com/common/oauth2/v2.0/token`, redirect `https://localhost`, and
scope `https://outlook.office365.com/IMAP.AccessAsUser.All offline_access`. Sign-in is the
authorisation code flow with PKCE and a random one-use `state`: the main process opens the URL in
the system browser; the browser fails to load `https://localhost/?code=…` because nothing listens
there; the user pastes that address into the form; the main process rejects it unless `state`
matches the pending sign-in, then exchanges the code and discards the `state`. There is no
loopback listener. Access tokens are minted from the refresh token before each connection, held
in memory, and never persisted; a rotated refresh token replaces the stored one atomically.

Credentials are encrypted with Electron `safeStorage` and stored at
`%APPDATA%\Lodestone\mail\<account_hash>\credential.bin`. If `safeStorage` reports encryption
unavailable, connection fails with a visible error; there is no plaintext fallback.

The renderer necessarily handles what the user types into the form: a password or a pasted
callback URL. It passes these to the main process once and never receives a stored credential, a
refresh token or a minted access token. Only the main process constructs adapters.

## Configuration

Account settings live in `config.toml` under `[mail_accounts.<account_hash>]`:

```toml
[mail_accounts.3f1c9a2b7e4d5c6f8a9b0c1d2e3f4a5b]
host = "outlook.office365.com"
port = 993
username = "james.izzard@nuanced.bio"
display_name = "Nuanced Bio"
credential_kind = "oauth"            # "password" | "oauth"
oauth_client_id = "9e5f94bc-e8a4-4e73-b8be-63364c29d753"
silo_name = "Mail: Nuanced Bio"
received_after = "2025-09-06T00:00:00Z"   # or "unlimited"
selection_mode = "default"           # "default" | "explicit"
selected_folders = []                # folder_keys, explicit mode only
sync_interval_seconds = 300
```

The mirror silo is an ordinary `[silos.<silo_name>]` entry pointing at the mirror directory, with
`read_only = true`, `supports_path_search = false` and `managed_by = "mail:<account_hash>"`.
Existing silo loading, watching and indexing apply unchanged.

## Selection

Each account has a fixed, inclusive `received_after` instant, defaulting to 365 days before the
connection time, adjustable earlier or to unlimited. It is a cutoff on `received_at`, not a
rolling window: nothing ages out.

Each account has a folder selection. The default is every folder except those with role
`drafts`, `junk` or `trash`. The user may pick folders explicitly from `listFolders`; `drafts`
can never be selected. For Gmail the selection is fixed to All Mail. New folders discovered later
are included only under the default rule, never under an explicit selection.

Any change to selection increments `selection_revision` and makes the silo unavailable. A full
reconciliation then runs, membership rows for folders that are no longer selected are deleted,
and orphaned messages are removed from disk. The silo becomes available again only when the
existing index reconciliation reports that the index reflects the current directory contents, so
that excluded messages are absent from search and not merely from disk.

## Mirror Files

The mirror directory is `%APPDATA%\Lodestone\mail\<account_hash>\mirror\`. Each message is a
UTF-8 file named `<first 32 hex of SHA-256 over account_uid + "\n" + message_key>.md`. Filenames
carry no meaning and are never derived from subjects or attachment names.

The file is a pure function of the message content, its flags and its folders: the same inputs
always produce byte-identical output, so replaying a write is idempotent and byte comparison
detects changes. Timestamps of Lodestone's own activity are kept in the manifest, not in the file.

```markdown
---
schema: 1
account_uid: imap:outlook.office365.com:993:james.izzard@nuanced.bio
message_key: uid:INBOX:1234567:8901
message_id: <abc@example.com>
in_reply_to: <xyz@example.com>
references:
  - <xyz@example.com>
subject: Thermal rig test plan
from: Jane Smith <jane@example.com>
to:
  - James Izzard <james.izzard@nuanced.bio>
cc: []
date: 2026-09-01T09:14:00Z
received_at: 2026-09-01T09:14:07Z
folders:
  - INBOX
seen: true
flagged: false
attachments:
  - name: rig-plan-v3.pdf
    mime: application/pdf
    size: 184322
body_status: complete
---
Subject: Thermal rig test plan
From: Jane Smith <jane@example.com>
To: James Izzard <james.izzard@nuanced.bio>
Date: 2026-09-01T09:14:00Z

<plain-text body>
```

Write the frontmatter with a YAML serialiser that quotes as needed, so header text cannot inject
fields. Absent values are `null`; absent lists are `[]`. The four-line plain header is repeated
in the body so that sender, subject and date are embedded and searchable even if frontmatter is
not chunked.

If the chosen part is `text/html`, convert it with `html-to-text`, preserving paragraph breaks,
block quotes and link targets, never fetching remote resources or executing anything. A
`truncated` body ends with the line `[truncated by Lodestone]`. Metadata is written in every
case, including `unsupported` and `encrypted`.

`date` is the parsed `Date` header in UTC; `received_at` is the server's `INTERNALDATE`.
`folders` is the membership folder paths, or on Gmail the label list.

## Manifest

Each account has `%APPDATA%\Lodestone\mail\<account_hash>\manifest.sqlite`, outside the mirror
directory, owned solely by the synchroniser. It holds runtime state only; settings are in
`config.toml`.

```sql
CREATE TABLE state (
  key TEXT PRIMARY KEY, value TEXT);
  -- selection_revision, current_round, sync_state, last_round_completed_at, last_error
CREATE TABLE folder (
  folder_key TEXT PRIMARY KEY, path TEXT, role TEXT, selected INTEGER,
  uidvalidity INTEGER, listed_complete_in_round INTEGER);
CREATE TABLE message (
  message_key TEXT PRIMARY KEY, file_name TEXT UNIQUE, received_at TEXT,
  labels TEXT, content_hash TEXT, fetched_at TEXT);
CREATE TABLE membership (
  message_key TEXT, folder_key TEXT, seen INTEGER, flagged INTEGER,
  seen_in_round INTEGER,
  PRIMARY KEY (message_key, folder_key));
```

`labels` is a JSON array, Gmail only. `content_hash` is SHA-256 of the file as written.
`seen_in_round` and `listed_complete_in_round` carry the round number and are what make deletion
safe.

## Synchronisation

One synchroniser per account, one round at a time; triggers (startup, timer, **Sync now**) are
coalesced while a round is running. The timer default is 5 minutes and is configurable per
account. Each round has a number, `round`, one higher than the last.

A round proceeds folder by folder in `folder_key` order:

1. `listFolders`; upsert the `folder` table and apply the selection rule. Delete `membership`
   rows for any folder that is not selected or no longer exists.
2. For each selected folder, run `listMessages` to completion. For each entry, upsert its
   `membership` row with `seen_in_round = round`, and record `seen`, `flagged` and `labels`. If
   the listing fails before completion, leave the folder's `listed_complete_in_round` unchanged
   and move on; nothing is deleted for that folder this round.
3. For every entry whose `message_key` has no `message` row, call `fetchMessage`, write the
   file, then insert the row. For every entry whose flags, folder set or labels differ from what
   the file was written with, rewrite the file and update `content_hash`.
4. Once the listing completed, set `listed_complete_in_round = round` and delete `membership`
   rows for that folder with `seen_in_round < round`.
5. When every selected folder has `listed_complete_in_round = round`: delete each `message` with
   no remaining `membership`, removing its file first and its row second; set
   `last_round_completed_at`; set `sync_state` to `idle`.

There is no saved enumeration cursor. The listing is cheap and idempotent, so an interrupted
folder is simply listed again on the next round; the expensive body fetches are naturally
resumable because the manifest already records which keys have files. The 60-second work budget
is checked between body fetches, never mid-listing: when it expires the round persists what it
has, ends, and continues from step 2 on the next trigger with the same `round` number.

Every file write goes to a temporary name under `%APPDATA%\Lodestone\mail\<account_hash>\tmp\`
on the same volume, then `rename`s into the mirror. The manifest row commits only after the
rename returns. A message whose file is written but whose row is missing after a crash is simply
written again; a row whose file is missing is fetched again. Startup deletes anything left in
`tmp`.

A `fetchMessage` failure that is not `unsupported` or `encrypted` stops the round at that message
and is retried on the next round; the folder's deletion step does not run until the fetch
succeeds. A UID that has vanished between listing and fetch is treated as removed.

Full reconciliation (first round, selection change, changed `UIDVALIDITY`) is the same
algorithm; the round-number bookkeeping already guarantees that nothing is deleted until a
complete listing has been seen. An interrupted round leaves the last complete mirror in place.

Transient failures (connection loss, `[THROTTLED]`, `[UNAVAILABLE]`) back off exponentially from
5 seconds to a 5-minute cap with jitter. An authentication failure (`AUTHENTICATIONFAILED`, or an
`invalid_grant` when refreshing an OAuth token) sets `sync_state` to `reauthorisation-required`
and stops the timer until the user reconnects through the GUI. One account's failure never blocks
another.

`sync_state` is one of `initialising`, `syncing`, `idle`, `reauthorisation-required`, `error`.
It describes the server round and the mirror. Index freshness is the existing silo indexing
state and is reported separately; a completed round means the files are on disk, not that they
are searchable.

## Generic Lodestone Changes

These properties are added to silos. They carry no provider knowledge.

`read_only`: every `lodestone_edit` operation, IPC route and named-pipe route that writes,
renames, moves or deletes rejects any target or destination whose canonical path is inside the
silo root, or is an ancestor of it. Canonicalise with `fs.realpath` for existing paths and the
nearest existing ancestor for new paths; compare case-insensitively with Windows separators. A
writable silo that overlaps a read-only root does not unlock it. Only the synchroniser and
account removal write these roots, through internal functions that are not reachable from any
client API.

`managed_by`: the silo cannot have its directory changed, its `read_only` cleared, or be removed
through silo settings. It is created and removed only with its owner.

`supports_path_search`: false for mail silos. The ranker sets the filename score to zero for
these silos and `filepath` mode excludes them. Content scoring is unchanged. File-path filters
continue to apply literally; to restrict to one mailbox, restrict to its silo.

`available`: search, explore and read exclude unavailable silos, including reads by absolute path
or previously issued reference ID.

Index-caught-up signal: the silo exposes whether the index currently reflects the directory
contents (no pending additions, changes or removals). The selection-change flow depends on it.

Silo naming: the connection form asks for a silo name and suggests `Mail: <display name>`. The
name is what MCP clients see in `lodestone_status`, so it must identify the mailbox. The
`lodestone_guide` startup text says that silos named `Mail: …` are read-only mirrors refreshed on
a timer, that their frontmatter carries sender and date, and that `lodestone_read` on a hit
returns the whole message.

## Sources UI

**Add silo** becomes **Add source** with two options: **Files and folders** (existing flow) and
**Email account**.

The email form asks for host, port (993) and username, then a credential kind. **Password**
takes the password. **Microsoft 365** shows the client ID (prefilled) and a **Sign in** button
that opens the authorisation URL in the system browser, and a field to paste the redirected
`https://localhost/?code=…` address into. After the connection is verified with a `LIST`, the
form shows the folder list with the default selection applied, the `received_after` date, the
silo name, and a summary stating that message text and index data will be stored unencrypted
under the Lodestone data directory. **Create** encrypts the credential, writes the config,
registers the silo and starts the first round.

The account card shows display identity, credential kind, folder selection summary, message
count, `sync_state`, `last_round_completed_at`, the silo's indexing state, and the buttons
**Sync now**, **Settings**, **Reconnect** and **Remove**. Settings can change the timer, silo
name, folder selection and `received_after`.

**Remove** marks the silo unavailable, cancels and awaits the running round, deletes the mirror
directory, `tmp`, manifest and credential, removes the silo and its index rows, and finally
deletes the account. A failed step leaves the card visible in an error state with **Retry
remove**. Removal does not revoke a server-side OAuth grant; the card links to the provider's
account-permissions page.

## Logging and Privacy

Routine logs identify accounts by `account_hash`, never by `account_uid`, and contain operation,
round timings, counts and error codes. They never contain queries, addresses, subjects, bodies,
attachment filenames, tokens, passwords or raw server error text.

Message content is inert text. The module never renders HTML, never follows links and never
downloads attachments. The mirror is readable by any local process; only the credential is
encrypted, and the connection summary says so.

## Acceptance

The feature is complete when the following hold, using a fake adapter for automated tests and the
real accounts for a manual pass:

- A Gmail account with an app password and both Microsoft 365 accounts with OAuth each connect,
  mirror their selection, and appear as `Mail: …` silos.
- An unrestricted `lodestone_search` returns email and file hits interleaved in one ranking;
  `filepath` mode returns no email hits; filename contributes nothing to any email score.
- `lodestone_read` on an email hit returns the whole Markdown file, and the search hint line
  ranges fall within that file.
- The adapter issues only the commands listed above, verified by a command log in the fake and by
  a protocol trace against a real server; the OAuth scope requested is
  `IMAP.AccessAsUser.All offline_access` only.
- A message with a 50 MiB attachment is mirrored with correct attachment metadata while
  transferring only its headers and text part.
- Every write route in Lodestone rejects operations under, or on an ancestor of, a mail silo
  root, including via overlapping silos, junctions and both ends of a move.
- A crash injected between file rename and manifest commit, and between membership update and
  `listed_complete_in_round`, converges to the same mirror on the next round.
- A label-only change on Gmail is detected on the next listing and rewrites the file; a message
  deleted on the server disappears from the mirror after the next complete round; Gmail drafts
  never appear.
- A listing that fails part way deletes nothing; a changed `UIDVALIDITY` re-mirrors the folder
  without deleting other folders' messages.
- Changing `received_after` or folder selection hides the silo, reconciles, removes excluded
  messages from disk and from search results, and only then restores the silo.
- Removing an account leaves no files, manifest, credential, silo or index rows behind.
- Restarting Lodestone after a week still connects both Microsoft accounts without a browser, and
  the Gmail password survives restart.
- Routine logs contain no addresses, subjects, bodies or secrets.
