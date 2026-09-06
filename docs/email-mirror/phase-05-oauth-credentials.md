# Phase 5: OAuth and Credential Storage

Status: ready · Depends on: phase 4 · Unblocks: phase 6

## Goal

The `oauth` credential kind: obtain a Microsoft refresh token with the borrowed Thunderbird
client ID through a paste-back authorisation code flow, mint access tokens on demand, feed them
to the adapter as XOAUTH2, and store both credential kinds encrypted with Electron
`safeStorage`. This phase produces no UI; it exposes functions the phase 7 form will call.

The working reference is `Test-M365Imap.ps1` / `m365-imap-oauth-test.mjs` from the design
work: the flow below is that script, restructured.

## Deliverables

`src/backend/mail/oauth.ts` (no Electron import; pure `fetch` and `node:crypto`)
- `OAuthProviderConfig { clientId; authorizeUrl; tokenUrl; redirectUri; scope }` and
  `MICROSOFT_THUNDERBIRD: OAuthProviderConfig` with the values from
  [design.md](design.md#accounts-and-credentials).
- `beginAuthorisation(cfg, loginHint): PendingAuthorisation` returning
  `{ url: string; state: string; verifier: string; createdAt: number }`. PKCE S256, 48-byte
  verifier, 12-byte `state`, `prompt=select_account`, `login_hint`.
- `completeAuthorisation(cfg, pending, pastedUrl): Promise<TokenSet>`: parse the pasted URL,
  reject if `state` differs or `code` absent, reject if `pending` is older than 10 minutes,
  POST the code exchange with `code_verifier`, no client secret. `TokenSet` is
  `{ accessToken; expiresAt; refreshToken; scope }`. Throw if `refresh_token` is absent.
- `refreshAccessToken(cfg, refreshToken): Promise<TokenSet>`: `grant_type=refresh_token`.
  Map `invalid_grant` to `AdapterError('auth')`; other HTTP failures to `'transient'`.
- Never log the URL, code, or tokens. Log only `account_hash` and outcome.

`src/backend/mail/credential-store.ts` (Electron import allowed; this is main-process only)
- `Credential = { kind: 'password'; password: string } | { kind: 'oauth'; refreshToken: string; clientId: string }`.
- `saveCredential(accountHash, cred)`: throw if `!safeStorage.isEncryptionAvailable()`; encrypt
  `JSON.stringify(cred)` and write to `<userData>/mail/<accountHash>/credential.bin` via a temp
  file and rename.
- `loadCredential(accountHash): Credential | null`; `deleteCredential(accountHash)`.
- A `CredentialStore` interface plus an in-memory implementation for tests, so phase 6's
  scheduler can be tested without Electron.

`src/backend/mail/token-source.ts`
- `createAccessTokenSource(cfg, store, accountHash): () => Promise<string>` that caches the
  minted access token in memory until 60 seconds before `expiresAt`, refreshes otherwise, and
  persists a rotated refresh token through the store before returning. Two concurrent calls
  share one in-flight refresh.

`src/backend/mail/imap-adapter.ts`
- Implement the `xoauth2` branch: ImapFlow `auth: { user, accessToken }`. Call the token
  source immediately before `connect()`, never earlier, so the token is fresh for the login.
  If the login fails with `AUTHENTICATIONFAILED` once, invalidate the cached access token,
  refresh, and retry once; a second failure is `'auth'`.

## Tests

- `oauth.test.ts` with a stubbed `fetch`: URL contains the exact scope string and PKCE
  parameters; `completeAuthorisation` rejects wrong `state`, missing `code`, expired pending,
  and a response without `refresh_token`; `refreshAccessToken` maps `invalid_grant` to
  `'auth'`.
- `token-source.test.ts`: caches until near expiry; concurrent callers share one refresh; a
  rotated refresh token is persisted before the access token is returned.
- `credential-store.test.ts`: the in-memory implementation round-trips both kinds; the
  Electron implementation is exercised in phase 8's manual pass, not here.
- `imap-adapter.integration.test.ts`: add an XOAUTH2 variant gated on
  `LODESTONE_TEST_M365_USER` and `LODESTONE_TEST_M365_REFRESH_TOKEN`, asserting login and a
  folder list.

## Done when

- Tests pass.
- With a refresh token obtained once by the paste-back flow, the adapter connects to both
  Microsoft 365 mailboxes headlessly, and still does so after the access token has expired.
- The scope requested is exactly `https://outlook.office365.com/IMAP.AccessAsUser.All offline_access`;
  grep the codebase for any other Microsoft scope string and find none.
