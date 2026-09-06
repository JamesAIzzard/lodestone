# Phase 8: Guide Text and Acceptance

Status: ready · Depends on: phase 7

## Goal

Tell MCP clients how to use mail silos, then run the full acceptance list from
[design.md](design.md#acceptance) against the real accounts from both Claude Code and Codex, and
record the results.

## Deliverables

`lodestone_guide` startup text (`src/backend/mcp/formatting.ts` or wherever the guide body
lives)
- Add a short paragraph: silos named `Mail: …` are read-only mirrors of email, refreshed on a
  timer; each hit is one message; the file's frontmatter carries sender, recipients, date,
  folders and attachment names; `lodestone_read` on a hit returns the whole message; results may
  lag the mailbox by up to the sync interval; `lodestone_edit` cannot modify them.
- Keep it concise and clear. Clients read this every conversation.

`lodestone_status` / `handleStatus`
- Confirm the new `available`, `indexCaughtUp`, `readOnly` and `managedBy` fields are present
  in the status the MCP bridge renders, so a client can see why a mail silo is missing from
  results.

Acceptance run
- Work through every bullet in the design's acceptance list. For each, note the command or
  action, the observed result, and pass/fail, in `docs/email-mirror/acceptance-<date>.md`.
- Pick up the live checks deliberately deferred from phases 4 and 5: Gmail app-password login,
  Microsoft 365 OAuth login, a non-Gmail IMAP round, the command/`PEEK` protocol trace, transfer
  below 3 MiB for a message with a large attachment, and two unchanged Gmail rounds with zero
  writes on the second round. Obtain credentials through the finished application's encrypted
  credential path rather than test-only environment variables where possible.
- The protocol-trace bullet: enable ImapFlow's logger to a file for one full round on the
  Swansea account and grep it for any command outside the allowlist and any `FETCH` without
  `PEEK`. Attach the grep, not the trace, since the trace contains subjects.
- The crash bullets are covered by phase 3's automated tests; cite them rather than repeating
  them manually.
- The week-long token bullet cannot be observed in a day: instead, delete the cached access
  token from memory (restart Lodestone) after the token's `expires_in` has passed and confirm
  the account reconnects without a browser. Note the date so it can be rechecked after a real
  week.

Repository hygiene
- Update `README.md` with a one-paragraph description of mail silos and a pointer to this
  folder.
- Remove the `Test-M365Imap.ps1` reference from phase 5 if the script was not committed, or
  commit it under `scripts/` if it was.

## Done when

- The acceptance file exists with every bullet marked pass, or with a linked issue for any
  failure.
- The same three workflows (find an email by topic, read it, confirm it cannot be edited) have
  been performed from Claude Code and from Codex against the installed build, not the dev build.
