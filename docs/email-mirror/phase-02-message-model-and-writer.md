# Phase 2: Message Model and Markdown Writer

Status: ready · Depends on: nothing · Unblocks: phase 3

## Goal

Pure functions, no I/O, no network: given parsed headers, a `BODYSTRUCTURE`, and the bytes of
one body part, produce the deterministic Markdown file described in
[design.md](design.md#mirror-files). Everything here is testable with fixtures and never touches
a server.

## Deliverables

All under `src/backend/mail/`.

`types.ts`
- `AccountUid`, `AccountHash`, `MessageKey`, `FolderKey` string aliases.
- `Folder`, `Entry`, `Message`, `BodyStatus` (`'complete' | 'truncated' | 'unsupported' | 'encrypted'`),
  `Attachment { name: string | null; mime: string; size: number | null }`.
- `MessageHeaders` with `messageId`, `inReplyTo`, `references[]`, `subject`, `from`, `to[]`,
  `cc[]`, `date` (Date | null). Address values are the display form `Name <addr>` or bare `addr`.
- `BodyPartChoice { section: string; mime: 'text/plain' | 'text/html'; encoding: string; charset: string; declaredSize: number } | { status: 'unsupported' | 'encrypted' }`.
- `MirrorInput`: the complete set of fields the writer needs (headers, body text, `bodyStatus`,
  attachments, `folders[]`, `seen`, `flagged`, `receivedAt`, `accountUid`, `messageKey`).

`identity.ts`
- `accountUid(host, port, username)` per the design: host lower-cased, username verbatim.
- `accountHash(uid)`: first 32 hex of SHA-256.
- `mirrorFileName(uid, messageKey)`: first 32 hex of SHA-256 over `uid + "\n" + messageKey`,
  plus `.md`.

`body-part.ts`
- `chooseBodyPart(structure): BodyPartChoice`. Input is ImapFlow's `bodyStructure` object
  shape (so phase 4 can pass it straight through); write the walker against that shape and keep
  a fixture file of real structures. Rules from the design: first `text/plain` leaf not under an
  `attachment` disposition; else first `text/html` leaf; inside `multipart/alternative` prefer
  plain; `multipart/encrypted` or `application/pkcs7-mime` with no readable alternative is
  `encrypted`; no text leaf is `unsupported`.
- `listAttachments(structure): Attachment[]`: leaves with disposition `attachment`, or any
  non-text leaf with a filename. Inline images with a filename count as attachments.
- `PARTIAL_FETCH_LIMIT = 2 * 1024 * 1024`.

`decode.ts`
- `decodeBodyPart(bytes, encoding, charset): string`. Handle `7bit`, `8bit`, `binary`,
  `quoted-printable`, `base64`; charsets via `TextDecoder` with a fallback to `latin1` when the
  label is unknown. Normalise line endings to `\n`.
- `htmlToText(html): string` using the `html-to-text` package with `selectors` configured so
  links keep their `href`, images are dropped, `blockquote` is prefixed with `> `, and no
  network or script execution is possible (the package does neither, but pin the options).

`markdown-writer.ts`
- `renderMirrorFile(input: MirrorInput): string`. Frontmatter serialised with a strict YAML
  emitter (add the `yaml` package; do not hand-roll quoting). Then the four-line plain header,
  a blank line, the body. If `bodyStatus === 'truncated'` the last line is
  `[truncated by Lodestone]`. Output uses `\n` only and ends with exactly one `\n`.
- Determinism: key order fixed as in the design; lists emitted as block sequences; `null` for
  absent scalars; `[]` for absent lists; dates as RFC 3339 UTC with second precision.
- `contentHash(rendered): string` SHA-256 hex of the UTF-8 bytes.

## Tests

`src/backend/mail/*.test.ts` with fixtures under `src/backend/mail/fixtures/`.

- Golden files: at least these structures, each with an expected `.md`: plain only; HTML only;
  `multipart/alternative` plain+HTML; plain with one PDF attachment; nested
  `multipart/mixed` containing an alternative; `multipart/encrypted`; a message with no text
  part; a subject containing `: ` and quotes and a leading `#`; a `From` with a comma in the
  display name; a body over 2 MiB (generated in the test, not stored).
- Idempotence: rendering the same `MirrorInput` twice gives identical bytes and hash; changing
  only `seen` changes the bytes.
- Injection: a subject of `"\nfolders: [\"x\"]"` produces frontmatter that parses back with
  `gray-matter` (already a dependency) to the original subject and the original `folders`.
- `htmlToText` on a fixture with `<script>`, tracking `<img>`, and nested `<blockquote>`.
- `chooseBodyPart` returns the expected IMAP section string for each fixture (`1`, `1.1`,
  `2`, and so on), because phase 4 fetches by that string.

## Done when

- All golden tests pass on Windows and Linux (line endings).
- `npm run typecheck` and `npm run lint` are clean.
- No file in `src/backend/mail/` imports `node:net`, `imapflow`, `electron`, or anything from
  `src/main/` or `src/renderer/`.

## Notes

`yaml` and `html-to-text` are new runtime dependencies. Add them in this phase. `mailparser` is
not used anywhere in this feature.
