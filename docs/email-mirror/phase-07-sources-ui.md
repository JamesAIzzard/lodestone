# Phase 7: Sources UI

Status: ready · Depends on: phase 6 · Unblocks: phase 8

## Goal

The renderer side of [design.md](design.md#sources-ui): add an email account, see its state,
change its settings, reconnect, remove. Everything talks to the phase 6 IPC surface; no new
backend behaviour.

## Deliverables

`src/renderer/components/AddSiloModal.tsx`
- Rename the entry point to **Add source** and add a first step with two choices:
  **Files and folders** (existing flow, unchanged) and **Email account**.

`src/renderer/components/mail/AddMailAccountWizard.tsx` (new)
1. **Server**: host, port (default 993), username. A **Microsoft 365** preset fills host and
   selects the OAuth credential kind; a **Gmail** preset fills `imap.gmail.com` and shows the
   2-step-verification and app-password note.
2. **Credential**: either a password field, or for OAuth the client ID (prefilled, editable)
   and a **Sign in** button that calls `mail:begin-oauth` and then shows a paste field with the
   instruction "Your browser will show a page that fails to load at `https://localhost/…`. Copy
   the full address from the address bar and paste it here." **Test connection** calls
   `mail:test-connection` and, on success, moves on with the returned folder list.
3. **Selection**: folder list with the default rule applied (drafts, junk and trash unticked and
   locked, everything else ticked); on Gmail the list is the single All Mail entry and is
   read-only. `received_after` date picker defaulting to one year ago, with an **All history**
   toggle.
4. **Name and summary**: silo name defaulting to `Mail: <display name>`, accent colour and icon
   via the existing `SiloAppearancePicker`, and a summary that states message text and index
   data will be stored unencrypted under the Lodestone data directory. **Create** calls
   `mail:create`.

Cancelling at any step leaves no account, credential or silo behind.

`src/renderer/components/mail/MailAccountCard.tsx` (new), rendered in the sidebar/list
alongside `SiloCard.tsx` for silos whose `managedBy` starts with `mail:`
- Shows display identity, credential kind, folder selection summary, message count,
  `syncState` with a plain-language label, `lastRoundCompletedAt` relative time, and the silo's
  existing indexing state (reuse the `SiloCard` progress rendering).
- Buttons: **Sync now**, **Settings**, **Reconnect**, **Remove**. Remove asks for confirmation
  and lists what will be deleted locally; after a failure it shows the failed step and
  **Retry remove**.
- **Reconnect** reuses the wizard's credential step only.

`src/renderer/components/mail/MailAccountSettings.tsx` (new)
- Timer interval, silo name, folder selection, `received_after`. Saving selection or cutoff
  shows a notice that the mailbox will be unavailable to search until reconciliation completes,
  and the card reflects that state while it runs.

State plumbing
- Extend the existing renderer hook that polls `silos:list` to also poll `mail:list`, and
  merge by `silo_name` so each mail silo has both its `SiloStatus` and `MailAccountStatus`.

## Tests

- Component tests are optional in this codebase; at minimum, a `vitest` test for the wizard's
  pure helpers: default selection derivation from a folder list, Gmail lock-down, default silo
  name, and the summary text.
- Manual checklist (record in the PR): add a password account; add an OAuth account including a
  wrong-`state` paste; cancel at each step; change selection and watch the card go unavailable
  and return; reconnect after revoking the grant at `myaccount.microsoft.com`; remove and
  confirm nothing remains on disk.

## Done when

- A new user can add all three target accounts through the UI without touching `config.toml`.
- No credential, refresh token or access token appears in any renderer state, prop, or log.
- The card states are truthful: `syncState` and indexing state are shown separately and a
  completed round with indexing still running reads that way.
