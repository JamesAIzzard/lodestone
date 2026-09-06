# Phase 9: On-Demand Attachment Reads

Status: ready · Depends on: phase 8

## Goal

Let an MCP client explicitly read one attachment from an email returned by Lodestone. The client
selects the email by its existing `r` reference and the attachment by its one-based position in
the email's `attachments` list. Lodestone downloads that complete MIME part, converts a supported
file type into content the model can inspect, returns it in the same tool call, and then discards
the bytes.

This phase does not mirror, index, cache or retain attachment content. It adds no attachment UI
and does not change routine mail synchronisation.

## Client contract

Add one MCP tool:

```text
lodestone_read_email_attachment({
  email: "r12",
  attachment: 1
})
```

- `email` is an `r` reference assigned to a mirrored email by `lodestone_search` or
  `lodestone_explore` in the current MCP session. Do not accept an account identifier,
  `message_key` or arbitrary filesystem path from the client.
- `attachment` is a one-based integer matching the order already shown in the mirrored email's
  `attachments` frontmatter. Attachment names are not selectors because they can be absent or
  duplicated.
- A successful call returns the complete usable representation in that response: extracted text
  for a document or an MCP image content block for a supported image. There is no page, range,
  save, cache or index parameter.
- If the attachment is unsupported, encrypted, no longer present, larger than the transfer
  limit, or produces more text than one safe tool response can carry, fail clearly without
  returning partial content.

The guide should encourage the client to read the email before requesting an attachment, so it
can select from the attachment list rather than guessing an ordinal.

## Supported content

Keep the first implementation deliberately narrow:

- `application/pdf`: pass the complete downloaded buffer to the existing PDF extractor and
  return all extracted text. A PDF with no meaningful extracted text is unsupported in this
  phase; do not add OCR or page rendering.
- Image formats that `lodestone_read` already returns as MCP image content: PNG, JPEG, GIF, WebP
  and SVG.
- `text/*`, `application/json` and `application/xml`: decode the declared charset, convert HTML
  to inert text with the existing HTML-to-text path, and return the complete text.

Reject Office documents, archives, executables, audio, video and unknown binary formats. Add a
format only when Lodestone has an explicit reader that produces content useful to the model; do
not treat a filename extension as evidence that an arbitrary binary is readable.

Define two central limits rather than relying on client or server behaviour:

- `MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024` (5 MiB) of decoded attachment content. Treat the
  `BODYSTRUCTURE` size as advisory because transfer encoding can make it differ from the decoded
  file. Call ImapFlow with `maxBytes: MAX_ATTACHMENT_BYTES + 1`; if the decoded stream exceeds
  5 MiB, abort and return a size error without any content.
- `MAX_ATTACHMENT_TEXT_BYTES = 512 * 1024` (512 KiB) of UTF-8 text returned to the MCP client,
  matching Lodestone's existing `MAX_READ_BYTES` boundary. If document extraction or text
  decoding exceeds it, return a size error rather than silently truncating. This phase
  deliberately does not add pagination.

The limits and error wording must be covered by tests. A 5 MiB image becomes approximately
6.7 MiB when base64-encoded for an MCP image content block; acceptance must confirm that both
target clients handle that upper bound.

## Attachment identity and IMAP retrieval

`src/backend/mail/body-part.ts`

- Preserve the MIME section found during the existing depth-first attachment walk. Keep section,
  transfer encoding and charset in an internal downloadable-part type while continuing to write
  only name, MIME type and size into mirrored Markdown.
- Use the same walk for mirroring and on-demand retrieval, so attachment `1` means the same leaf
  in both paths. Nested MIME sections such as `3.1` remain an adapter detail and are not exposed
  in the MCP contract.

`src/backend/mail/adapter.ts` and `imap-adapter.ts`

- Add `fetchAttachment(messageKey, attachmentIndex, maxBytes)`. Resolve the message exactly as
  `fetchMessage` does, obtain `BODYSTRUCTURE`, enumerate downloadable parts, validate the
  one-based index, and download only the selected section.
- Fetch the selected part with `BODY.PEEK` and ImapFlow's `maxBytes` set to 5 MiB plus one byte,
  so an incorrect or absent size declaration can be detected. Do not issue `BODY[...]`,
  `SELECT`, `STORE` or any other server-mutating command. The existing command allowlist remains
  in force.
- Return the complete decoded bytes only when the stream ends within the hard limit. Otherwise
  abort and discard it. Return bytes plus trusted metadata from `BODYSTRUCTURE`, not a server or
  client supplied local filename.
- If the message or selected part has disappeared since the mirror was written, return
  `AdapterError('not-found')`. If the live attachment metadata no longer matches the mirrored
  attachment at that ordinal, fail and ask for a mail resynchronisation rather than risk
  returning the wrong part.

## Account and concurrency boundary

`src/backend/mail/account.ts`

- Add an account-level `readAttachment(messageFileName, attachmentIndex)` operation. Resolve the
  mirror filename to `message_key` through a new indexed manifest lookup. Read the expected
  attachment metadata only from that validated, Lodestone-generated mirror file; do not obtain
  identity or expected metadata from client-supplied values.
- Coordinate the read with the account scheduler so shutdown, pause, reconnect, removal and a
  synchronisation round cannot close or replace the adapter underneath it. Wait for any active
  round, prevent a new round from starting for the duration of the download, then restore normal
  scheduling. This is an explicit read operation, not a change to `sync_state`.
- Reject requests while the account is paused, being removed or awaiting reauthorisation.

`src/backend/mail/manifest.ts`

- Add `messageByFileName(fileName)` using the existing unique `message.file_name` column. No
  schema migration is needed.

Do not add a persistent attachment table or cache directory. The attachment buffer lives only
for the duration of the request and is released after conversion and response construction.

## GUI and MCP bridge

`src/main/internal-api.ts`

- Add an `email.readAttachment` request. Resolve the supplied mirror filepath to exactly one
  configured silo whose `managed_by` value is `mail:<account_hash>`, verify that the path is a
  direct mirror file for that account, then call its `MailAccount`.
- Convert the returned bytes through a focused attachment reader in the GUI/backend process.
  Return a serialisable union such as `{ kind: 'text', text, metadata }` or
  `{ kind: 'image', dataBase64, mimeType, metadata }` over the named pipe.

`src/main/mcp-bridge.ts` and `src/backend/mcp/types.ts`

- Add the corresponding dependency method to the bridge. Keep account lookup, credentials, IMAP
  and local-path validation in the GUI process.

`src/backend/mcp/`

- Register `lodestone_read_email_attachment` with the contract above.
- Resolve `email` through the session's `PuidManager`. Reject unknown, invalidated and directory
  references before calling the GUI. Do not accept literal paths for this tool.
- Render text and image results with the same MCP content-block conventions as `lodestone_read`.
  Include the email reference, attachment ordinal, filename when present, MIME type and size in
  the textual header.
- Notify normal silo activity so the Lodestone UI shows that a client request is in progress.

`src/backend/mcp/resources.ts`

- Extend the startup guide's mail paragraph: attachment names are metadata only until a client
  explicitly calls `lodestone_read_email_attachment`; supported attachments are downloaded and
  returned on demand, are not indexed or retained, and may be rejected by type or size.

## Safety and privacy

- Treat attachment filenames and contents as untrusted data. Never execute, open in a shell,
  expand an archive, render active HTML, follow links or enable document macros.
- Do not write attachment bytes to disk. If a library later requires a temporary file, that is a
  separate design change with explicit cleanup and crash-recovery requirements.
- Logs may contain account hash, operation, MIME type, byte count, duration and error category.
  They must not contain account identity, email subject, attachment filename, extracted content
  or raw server errors.
- The attachment is sent to the requesting MCP client because the client explicitly asked for
  it. Make this distinction clear in the guide and application privacy text; routine mirroring
  still downloads no attachment bytes.

## Tests

`body-part.test.ts`

- Deterministic one-based ordering for flat and nested MIME trees.
- Missing and duplicate filenames remain independently selectable.
- The internal MIME section, encoding and charset are retained without appearing in rendered
  mail frontmatter.

`imap-adapter.test.ts`

- The requested ordinal downloads the correct section using `PEEK` and returns the complete
  decoded bytes.
- Index zero, an out-of-range index, changed metadata and a deleted message fail safely.
- Declared oversize, undeclared oversize and a stream exceeding its declaration all fail at the
  hard limit without returning partial data.
- The command logger rejects a non-`PEEK` attachment fetch.

`account.test.ts` and `manifest.test.ts`

- Mirror filename resolves to the correct message key.
- Attachment reads do not overlap adapter replacement or close during sync, pause, reconnect,
  removal or shutdown.
- No attachment file or manifest row remains after success or failure.

MCP and internal API tests

- Only a live email `r` reference is accepted; a file reference, raw path, stale reference and
  directory reference are rejected.
- A text-bearing PDF returns all extracted text in one response.
- Supported text and image attachments produce the correct MCP content blocks.
- Unsupported MIME, encrypted content, empty/scanned PDF, transfer limit and output limit return
  concise actionable errors without partial content.
- Routine email search and `lodestone_read` behaviour is unchanged.

Live acceptance

- From Claude and Codex, find a known flight-related email, read it, select its PDF attachment by
  ordinal, and recover a known flight number, departure time and destination found only in the
  PDF.
- Repeat with an image attachment and confirm that the model receives the image.
- Request a deliberately oversized and an unsupported attachment and confirm that neither is
  returned or retained.
- Inspect the IMAP protocol trace and confirm the explicit request fetches only the selected MIME
  section with `PEEK`; routine sync still transfers no attachment bytes.

## Done when

- The automated tests above pass and the original email-mirror suite remains green.
- The Claude and Codex flight-PDF acceptance succeeds against the installed build.
- No attachment content is indexed, written to the mirror, persisted elsewhere or logged.
- The guide and README distinguish routine attachment metadata from explicit on-demand reads.
