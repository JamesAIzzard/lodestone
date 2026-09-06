# Email Mirror Acceptance, 6 September 2026

Status: in progress

This records Phase 8 acceptance against `codex/email-mirror-phase-08`. Automated evidence was
collected first; checks requiring real accounts or an installed build remain explicitly pending.
No credentials, message subjects, protocol trace or other mailbox content belong in this file.

## Automated baseline

| Command or action | Observed result | Result |
|---|---|---|
| `npx vitest run` | Under pinned Node 24.15.0, 37 test files and 379 tests passed; the three credential-gated IMAP integration tests were skipped. | Pass |
| `npm run typecheck` | TypeScript completed with no errors. | Pass |
| Inspect `handleStatus` and the MCP `lodestone_status` renderer | `available`, `indexCaughtUp`, `readOnly` and `managedBy` are copied into `SiloStatus`; the renderer emits each field, with `managedBy` omitted only when unset. | Pass, installed-build confirmation pending |
| `npx vitest run src/backend/mcp/resources.test.ts` | Five guide tests passed, including the mail-silo usage text. | Pass |

The final automated release gate used the repository's pinned Node 24.15.0. TypeScript and ESLint
also completed without errors.

## Design acceptance

### 1. Real account connection and mirroring

Action: connect Gmail with an app password, then Swansea and Nuanced Bio Microsoft 365 with OAuth
through the application UI; mirror the chosen folders and inspect Sources and `lodestone_status`.

Observed result: Gmail connected successfully with an app password and the selected All Mail
folder began mirroring in the dev build. The first run fetched messages and checkpointed with
`budget-exhausted`, after which mirroring continued. This is the intended bounded-round behaviour,
not a sync failure. Microsoft 365 accounts and the settled Gmail status remain pending.

Result: **Gmail live pass in progress; Microsoft 365 pending**.

### 2. Search ranking and disabled filepath search

Action: from the installed build, run an unrestricted topic search which matches both ordinary
files and email, then repeat in `filepath` mode and inspect the score signals.

Observed result: automated policy tests pass for omitting the filepath signal and returning no
mail results in filepath mode. Interleaving against a live mirror is pending.

Result: **Automated pass; live pending**.

### 3. Reading a complete message

Action: read a live email hit and compare the returned Markdown and hint line range with its
mirror file.

Observed result: the development MCP stdio entry (`mcp-wrapper.js --dev`) returned a search
reference and more than 100 characters from `lodestone_read` for each of the four live mail silos:
JAI Engineer, Gmail, Swansea and Nuanced Bio. Message content was not retained in the test output.

Result: **Development MCP pass; installed-client confirmation pending**.

### 4. IMAP command boundary and OAuth scope

Action: capture one full Swansea round with ImapFlow protocol logging enabled, then retain only a
grep-derived command and non-`PEEK` report. Search the source for Microsoft OAuth scope strings.

Observed result: automated adapter tests pass for rejecting commands outside the allowlist and
non-`PEEK` fetches. OAuth tests pass for the configured scope. The real-server trace is pending.

Result: **Automated pass; live trace pending**.

### 5. Large attachment transfer bound

Action: mirror a known message with a 50 MiB attachment and verify its attachment metadata while
measuring less than 3 MiB transferred for the message.

Observed result: pending manual run and suitable test message.

Result: **Pending**.

### 6. Read-only enforcement

Action: run the automated write-policy suite, then attempt `lodestone_edit` on a live mail hit
from both clients.

Observed result: automated tests pass for every write operation at, below and above a read-only
root, overlapping silos, junction traversal, and both ends of a move. A dry-run append through the
development MCP was rejected as read-only for a live hit from each of the four mail silos.

Result: **Automated and development MCP pass; installed-client checks pending**.

### 7. Crash convergence

Action: run the synchroniser crash-injection tests for the rename/manifest and
membership/listing-complete boundaries.

Observed result: the full suite passed both required crash-recovery tests.

Result: **Pass**.

### 8. Gmail label changes, deletion and draft exclusion

Action: run the fake-adapter synchroniser tests, then perform two unchanged Gmail rounds and a
controlled live label or deletion check.

Observed result: automated tests pass for label-only rewrites, server deletion and draft
exclusion. A live Gmail initial round has begun successfully. Two unchanged live rounds with zero
writes and the controlled live change remain pending after initial catch-up.

Result: **Automated pass; live pending**.

### 9. Partial listing failure and UIDVALIDITY change

Action: run the fake-adapter failure and UIDVALIDITY tests.

Observed result: the full suite passed preservation after partial listing failure and
folder-local re-enumeration after a UIDVALIDITY change.

Result: **Pass**.

### 10. Selection reconciliation and availability

Action: change the date cutoff or folder selection in the dev app and observe the silo status,
mirror directory and search results through reconciliation.

Observed result: automated account and synchroniser tests pass for hiding until indexing catches
up and removing messages excluded by the new selection. UI observation is pending.

Result: **Automated pass; live pending**.

### 11. Account removal

Action: remove a disposable live account and verify that its mirror, manifest, encrypted
credential, silo configuration and index rows are absent.

Observed result: automated account-removal tests pass, including retry after partial failure.
The live lifecycle check is pending.

Result: **Automated pass; live pending**.

### 12. Credential persistence and token refresh

Action: restart Lodestone after the Microsoft access token's `expires_in` has elapsed and confirm
both Microsoft accounts reconnect without a browser; also confirm the Gmail password survives
restart. Record this date for a later real-week recheck.

Observed result: token-cache, refresh rotation and in-memory credential-store tests pass. The
encrypted Electron store, elapsed-token restart and Gmail restart checks are pending.

Result: **Automated pass; live pending**.

### 13. Log privacy

Action: inspect routine logs after live rounds and grep retained diagnostic output for addresses,
subjects, bodies and secrets.

Observed result: automated logger and synchroniser tests pass for account-hash-only logging and
redaction of message data. Live-log inspection is pending.

Result: **Automated pass; live pending**.

## Installed-client workflows

From both Claude Code and Codex, against the installed build:

1. Find an email by topic.
2. Read the complete message.
3. Confirm that editing it is rejected.

Observed result: pending after the live mirrors have been configured and a candidate build has
been installed.

Result: **Pending**.
