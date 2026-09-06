# Phase 9: On-Demand Attachment Reads

Status: ready · Depends on: phase 8

## Goal

One new MCP tool lets a client read one attachment from a mirrored email. The client names the
email by its `r` reference and the attachment by its one-based position in the email's
`attachments` frontmatter. Lodestone downloads that MIME part over the existing IMAP adapter,
converts it in memory, returns it in the same tool call, and discards the bytes.

Nothing is mirrored, indexed, cached or retained. No UI is added. Routine synchronisation is
unchanged.

## Tool contract

```text
lodestone_read_email_attachment({ email: "r12", attachment: 1 })
```

- `email`: an `r` reference from `lodestone_search` or `lodestone_explore` in this session. No
  paths, account identifiers or message keys.
- `attachment`: integer, minimum 1, indexing the mirrored `attachments` list. Names are not
  selectors because they can be absent or duplicated.
- Success returns the whole usable representation: extracted text, or an MCP image block for a
  raster image. No page, range, save, cache or index parameters.
- Unsupported, encrypted, missing, oversized or over-length results fail with no partial
  content. A reference whose mirror file has since been renamed or deleted fails with the same
  "search again" wording as `lodestone_read`.

## Supported content and limits

Type decisions use the MIME type from `BODYSTRUCTURE`, confirmed against the leading bytes for
binary formats. The filename extension is never consulted.

| MIME type | Result |
|---|---|
| `application/pdf` | All text from `extractPdf`, with a 60 s `shouldStop` deadline. No text layer → `unsupported`; password → `encrypted`. |
| `image/png`, `image/jpeg` (`image/jpg` normalised), `image/gif`, `image/webp` | MCP image block. Signature mismatch → `unsupported`. |
| `text/*`, `application/json`, `application/xml`, `image/svg+xml` | Text, charset-decoded; `text/html` through `htmlToText`. SVG is text, not an image: the Claude API accepts only the four raster types above. |
| Anything else, including `message/rfc822` | `unsupported`. |

Charset decoding belongs to the reader: ImapFlow decodes transfer encoding for every part but
converts charset only for inline text, and every selectable part has attachment disposition.
Use `decodeBodyPart(bytes, '8bit', charset ?? 'utf-8')` from `decode.ts`.

Constants, in `src/backend/mail/attachment.ts` with the shared `AttachmentContent` type:

- `MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024`, decoded. A declared `BODYSTRUCTURE` size above
  `3 * MAX_ATTACHMENT_BYTES` is rejected before download. Otherwise download with
  `maxBytes: MAX_ATTACHMENT_BYTES + 1`; ImapFlow truncates silently at `maxBytes`, so receiving
  more than the limit is the oversize signal. Destroy the stream (this aborts ImapFlow's chunk
  loop) and return `too-large`.
- `MAX_ATTACHMENT_TEXT_BYTES = 512 * 1024` of UTF-8 after conversion, matching `MAX_READ_BYTES`.
  Exceeding it is `too-large`, never truncation. No pagination in this phase.

## Changes

`src/backend/mail/body-part.ts`
- `listAttachmentParts(structure): AttachmentPart[]`, where
  `AttachmentPart = Attachment & { section; encoding; charset }`, using the existing walk and
  `isAttachment` rule. `listAttachments` becomes its projection to name, MIME type and size, so
  ordinal `n` is the same leaf for mirroring and retrieval. `section` is `node.part` when
  present, else the inferred section.

`src/backend/mail/adapter.ts`
- `AdapterErrorKind` gains `'too-large'` and `'stale'`.
- `fetchAttachment(messageKey, attachmentIndex, { maxBytes, expected: { count, attachment } }): Promise<AttachmentContent>`
  where `AttachmentContent = { bytes; mime; name; charset; declaredSize }`.
- `MailAdapterOperation` gains `` `fetchAttachment:${MessageKey}:${number}` ``.

`src/backend/mail/imap-adapter.ts`
- Extract `locateMessage(messageKey)` from `fetchMessage` (location cache, `uid:` parse, Gmail
  search, read-only lock, `UIDVALIDITY` check) and share it.
- `fetchAttachment`: `fetchOne(uid, { bodyStructure: true })` → `listAttachmentParts` → index
  check (`not-found`) → compare count and the selected part's name, MIME type and size with
  `expected` (`stale`, before any download) → declared-size pre-check → `client.download(uid,
  section, { uid: true, maxBytes })`. A result without `content` is `not-found`. Read up to
  `maxBytes`; more than `maxBytes - 1` bytes is `too-large`. Return metadata from
  `BODYSTRUCTURE`, not `download().meta`.
- ImapFlow issues `UID FETCH n (UID BODY.PEEK[s.MIME] BODY.PEEK[s]<start.len>)` in 64 KiB chunks
  (plus a `BODYSTRUCTURE` fetch when `s` is `1`); the command logger already admits these. Do
  not widen the allowlist.
- Log `imap-attachment-fetched` with `received_bytes`, `mime`, `duration_ms`.

`src/backend/mail/manifest.ts`
- `messageByFileName(fileName): MessageRecord | null`, exact match on the unique `file_name`
  column. No migration.

`src/backend/mail/account.ts`
- `SyncScheduler.exclusive(operation)`: await any running round, run `operation` while
  holding the scheduler. Triggers arriving meanwhile set `queued` and return the deferred
  round's promise. Afterwards run the queued round if one was requested and the scheduler is
  neither stopped nor auth-paused; otherwise leave the timer alone. `stop()` awaits the held
  operation too, so `pause`, `reconnect`, `applySelection`, `remove` and `shutdown` cannot close
  the adapter under a read. Do not use `start()` for this: it clears the auth pause and forces
  a round.
- `readAttachment(fileName, attachmentIndex): Promise<AttachmentContent>`:
  1. `MailReadError('unavailable')` if `sync_state` is `paused` or
     `reauthorisation-required`, `removing` is set, or a lifecycle transition is in progress
     (private flag set on entry to the methods above, cleared in `finally`).
  2. `manifest.messageByFileName` → `not-found` on miss.
  3. Parse the mirror file's frontmatter with `gray-matter`; `expected` is
     `attachments.length` and `attachments[index - 1]`. Missing file, bad frontmatter or index
     beyond the list → `not-found`. Nothing client-supplied reaches the adapter.
  4. Inside `scheduler.exclusive`: create the adapter if absent (same factory call as
     `createSynchroniser`), then `adapter.fetchAttachment(messageKey, index, { maxBytes:
     MAX_ATTACHMENT_BYTES, expected })`.
  5. Return the content. Write no state, no manifest row, no file.
- `MailReadError { reason: 'unavailable' | AdapterErrorKind }` is the only error thrown. Log
  `mail-attachment-read` with `outcome` and `duration_ms` only.

`src/main/mail-attachment-route.ts` (new, no Electron import)
- `resolveMailMirrorFile({ siloManagers, mailAccounts }, filepath)` → `{ account, fileName,
  siloName }` or `{ code, message }`. Requires: exactly one silo root contains the path
  (`isPathWithinRoot`); `managedBy` is `mail:<hash>`; `readOnly`; not stopped; `isAvailable`;
  canonical path is a direct `.md` child of the mirror directory; `mailAccounts.get(hash)`
  exists.

`src/main/internal-api.ts`
- `email.readAttachment { filepath, attachment }`: resolve, send `mcp:activity` with the silo
  name, call `account.readAttachment`, return a union instead of throwing:

  ```ts
  | { kind: 'attachment'; dataBase64; mime; name; charset; size }
  | { kind: 'error'; code: 'not-email' | 'unavailable' | 'not-found' | 'stale' | 'too-large'
      | 'encrypted' | 'unsupported' | 'auth' | 'transient' | 'protocol'; message }
  ```

  `message` is Lodestone wording; raw server text never crosses the pipe.

`src/main/mcp-bridge.ts`, `src/backend/mcp/types.ts`
- `McpServerDeps.mail.readAttachment({ filepath, attachment })` backed by
  `gui.call('email.readAttachment')`. Give `GuiPipeClient.call` a per-call timeout and use
  180 s here: a read may wait one 60 s work budget plus a 5 MiB transfer.

`src/backend/mail/attachment-reader.ts` (new)
- `readAttachmentContent(content, { deadlineMs })` → `{ kind: 'text'; text } | { kind: 'image';
  dataBase64; mimeType }`, throwing `AttachmentReadError('unsupported' | 'encrypted' |
  'too-large')`. Implements the table above and nothing else. Runs in the bridge process, like
  `lodestone_read`'s PDF path, so a slow parse never blocks the GUI.

`src/backend/mcp/tools-attachment.ts` (new)
- Register the tool; export `readEmailAttachment(args, deps, puid)` for tests.
- Accept `^r\d+$` only. Resolve through `PuidManager` with `lodestone_read`'s unknown,
  invalidated and directory errors. Confirm via `deps.silo.status()` that the path is under a
  silo whose `managedBy` starts with `mail:`, else "not an email". Call `notifyActivity`.
- Decode `dataBase64`, convert, render: header
  `## r12 attachment 1: <name or (unnamed)> (<mime>, <size>)`, then a fenced text block or an
  image block. Errors use the `Error:` prefix plus one sentence on what to do next.

`src/backend/mcp/resources.ts`, `src/renderer/components/mail/mail-ui.ts`, `README.md`
- Guide: attachment names are metadata until the client calls
  `lodestone_read_email_attachment` with the email reference and one-based position; supported
  types are fetched on demand, not indexed or retained, and may be rejected by type or size.
- Wizard storage summary: attachments are never stored; one is downloaded only on explicit MCP
  request and discarded after the response.
- README: one sentence distinguishing metadata from on-demand reads.

## Safety

- Attachment names and bytes are untrusted. Never execute, unpack, render active HTML, follow
  links or enable macros.
- No attachment bytes touch disk. A future library that needs a temp file is a separate design.
- Logs carry account hash, operation, MIME type, byte count, duration and error kind only.

## Tests

- `body-part.test.ts`: deterministic ordinals for flat and nested trees; `listAttachments`
  equals the projection; missing and duplicate names stay selectable; section, encoding and
  charset never reach frontmatter.
- `imap-adapter.test.ts` (extend `StubImapClient.download` to record arguments and serve a
  configurable stream): correct section and `maxBytes`; index 0, out of range, `expected`
  mismatch, missing message and empty download fail with the specified kinds and no wrong-part
  download; declared oversize rejected without `download`; a `MAX + 1` byte stream is
  `too-large`, destroyed, no bytes returned; exactly `MAX` succeeds; logger rejects
  `UID FETCH 5 (BODY[2])` and accepts the PEEK form.
- `fake-adapter.ts`: `fetchAttachment` over `addAttachment(messageKey, attachment, bytes)`,
  honouring `maxBytes` and `expected`, recorded in `commandLog`.
- `account.test.ts`, `manifest.test.ts`: `messageByFileName`; `exclusive` waits for a running
  round, defers a timer trigger, keeps the auth pause, and `stop()` awaits it; `readAttachment`
  succeeds from a real-round mirror file, rejects while paused, removing or reauthorising,
  reports `stale`, and leaves mirror, `tmp`, manifest rows and state untouched; `pause()` during
  a read completes only after the read.
- `attachment-reader.test.ts`: text PDF; scanned and password PDFs; four raster types with
  normalised MIME; wrong signature; ISO-8859-1 text, HTML, JSON, SVG as text; over-length text;
  Office, zip, executable and `message/rfc822` unsupported regardless of name.
- `tools-attachment.test.ts`, `mail-attachment-route.test.ts`: `d` refs, raw paths, unknown,
  invalidated and non-mail refs rejected without a GUI call; every error code renders; the
  resolver rejects non-mail silo, nested path, non-`.md`, stopped, unavailable and missing
  account.

## Acceptance

- From Claude Code and Codex against the installed build: find a flight email, read it, fetch
  its PDF by ordinal, recover a flight number, departure time and destination that exist only
  in the PDF. Repeat with a PNG or JPEG.
- Oversized, unsupported and stale requests return nothing and leave nothing under the
  account's data directory.
- Measure the client ceilings and record them: Claude Code's MCP output token cap
  (`MAX_MCP_OUTPUT_TOKENS`, default 25 000) is below 512 KiB of text, and the API's 5 MB image
  limit is just below 5 MiB. Adjust guide wording if they bind.
- Protocol trace: the request fetches only `BODY.PEEK[s.MIME]` and `BODY.PEEK[s]<…>` for the
  selected section; routine sync transfers no attachment bytes. Attach the grep, not the trace.

## Done when

- The tests above pass and the existing email-mirror suite stays green.
- Both clients pass the flight-PDF acceptance on the installed build.
- No attachment content is indexed, written, persisted or logged.
- Guide, wizard summary and README distinguish attachment metadata from on-demand reads.
