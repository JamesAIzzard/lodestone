# Phase 4: IMAP Adapter

Status: ready · Depends on: phases 2, 3 · Unblocks: phases 5, 6

## Goal

A real `MailAdapter` over `ImapFlow` with password authentication, honouring the command
allowlist in [design.md](design.md#adapter), including Gmail behaviour. OAuth is added in phase 5
as a second credential kind; this phase must leave a single seam for it.

## Deliverables

`src/backend/mail/imap-adapter.ts`
- `createImapAdapter(opts: { host; port; username; auth: ImapAuth; log }): MailAdapter` where
  `ImapAuth = { kind: 'password'; password: string } | { kind: 'xoauth2'; accessToken: () => Promise<string> }`.
  Phase 5 fills in the second variant; this phase implements only `password` and throws
  `AdapterError('unsupported')` for `xoauth2`.
- One `ImapFlow` connection, `secure: true`, `logger: false`, connected lazily on first call
  and reused. `close()` sends `LOGOUT`.
- Capability check after connect: record `X-GM-EXT-1` presence as `isGmail`; record
  `CONDSTORE`/`QRESYNC` presence for future use but do not use them.
- `listFolders()`: `LIST` with SPECIAL-USE; map to `Folder` with roles from attributes, falling
  back to the case-insensitive name list in the design. On Gmail return only the `\All` folder
  with role `all`.
- `listMessages(folder)`: open with `getMailboxLock(path, { readOnly: true })` (ImapFlow sends
  `EXAMINE`). Compare `mailbox.uidValidity` to the caller-supplied expected value and throw
  `AdapterError('protocol', 'uidvalidity-changed')` if different; the synchroniser handles the
  reset. `UID SEARCH SINCE <date>` where `<date>` is the cutoff's calendar day in UTC, then
  `UID FETCH` in batches of at most 500 UIDs with `(UID INTERNALDATE FLAGS)` plus
  `X-GM-MSGID X-GM-LABELS` on Gmail. Yield entries whose `INTERNALDATE >= cutoff`. Gmail
  entries whose labels include `\Draft` are not yielded. `message_key` per the design.
- `fetchMessage(messageKey)`: lock the folder read-only, fetch `bodyStructure` and
  `headers` (ImapFlow `fetchOne` with `{ bodyStructure: true, headers: true }`), run
  `chooseBodyPart` and `listAttachments` from phase 2, then `download(uid, section, { uid: true })`
  for the chosen part with `maxBytes: PARTIAL_FETCH_LIMIT` (ImapFlow issues `BODY.PEEK[section]<0.n>`
  for a bounded download; confirm in the protocol trace and fall back to `fetchOne` with an
  explicit `bodyParts: [\`${section}<0.${limit}>\`]` if it does not). Decode with phase 2's
  `decodeBodyPart`, convert HTML with `htmlToText`, and set `bodyStatus`.
- Headers are parsed by ImapFlow into a `Map`; normalise `From`/`To`/`Cc` to the display form
  used by phase 2, decode RFC 2047 encoded words (ImapFlow's `libmime` does this), and parse
  `Date` leniently, `null` on failure.
- Error mapping: `AUTHENTICATIONFAILED` or `NO [AUTHENTICATIONFAILED]` on login → `'auth'`;
  socket errors, timeouts, `[THROTTLED]`, `[UNAVAILABLE]`, `[SERVERBUG]` → `'transient'`;
  a fetch for a UID that returns nothing → `'not-found'`.
- Connection timeouts: connect 30 s, idle command 60 s.

Command allowlist enforcement
- ImapFlow exposes the raw commands it sends only through its logger. Implement a small
  `logger` object that captures each outgoing command name and throws if it is not in the
  allowlist. Wire it in `createImapAdapter` unconditionally; the cost is negligible and it turns
  the allowlist into a runtime invariant, not a code review item.
- Allowlist: `CAPABILITY`, `ID`, `ENABLE`, `AUTHENTICATE`, `LOGIN` (ImapFlow may choose it over
  `AUTHENTICATE PLAIN` for password auth; both are authentication), `NOOP`, `LOGOUT`, `LIST`,
  `STATUS`, `EXAMINE`, `SEARCH`, `FETCH` (with `PEEK`), `NAMESPACE`, `COMPRESS`. Confirm the
  exact strings ImapFlow logs and adjust the match, but do not widen the meaning.

## Tests

`imap-adapter.test.ts`
- Unit tests for role mapping, cutoff-to-`SINCE` date conversion, message key formation, header
  normalisation and error mapping, using stubbed ImapFlow responses.

`imap-adapter.integration.test.ts`
- Skipped unless `LODESTONE_TEST_IMAP_HOST`, `LODESTONE_TEST_IMAP_USER`,
  `LODESTONE_TEST_IMAP_PASSWORD` are set. Runs `listFolders`, lists INBOX with a cutoff of 30
  days, fetches the newest three messages, and asserts `bodyStatus` and non-empty text for at
  least one. Asserts the command capture saw nothing outside the allowlist.
- A second variant for Gmail (`LODESTONE_TEST_GMAIL_USER`, `LODESTONE_TEST_GMAIL_APP_PASSWORD`)
  asserting exactly one folder with role `all`, `gm:` keys, and labels present on entries.
- Large attachment: send yourself a message with a large attachment beforehand and assert the
  bytes transferred for that message (from the capture) are under 3 MiB.

## Done when

- Unit and integration tests pass against Gmail and one non-Gmail server (Fastmail or any
  Dovecot host).
- A protocol trace of a full round shows only allowlisted commands and every `FETCH` uses `PEEK`.
- Running phase 3's `Synchroniser` with this adapter against a real Gmail account produces a
  mirror directory whose files render identically on a second run (zero writes).

## Deferred live verification

Do not request or persist real account credentials during this phase. Keep the credential-gated
integration tests skipped while phases 5 to 7 provide encrypted credential storage, Microsoft
OAuth, account wiring and the account UI. Phase 8 owns the live run of this phase's done criteria,
including Gmail, a non-Gmail server, the command/`PEEK` protocol trace, the large-attachment
transfer bound and the two-round zero-write check.
These live items do not block merging the phase 4 implementation; they remain open acceptance
items until phase 8 records their results.

## Notes

`imapflow` is a new runtime dependency. It is pure JavaScript with no native build, so
`electron-rebuild` is unaffected.
