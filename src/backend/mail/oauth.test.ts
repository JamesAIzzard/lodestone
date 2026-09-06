import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdapterError } from './adapter';
import {
  beginAuthorisation,
  completeAuthorisation,
  MICROSOFT_THUNDERBIRD,
  refreshAccessToken,
} from './oauth';

describe('Microsoft OAuth', () => {
  beforeEach(() => vi.setSystemTime(new Date('2026-09-06T10:00:00Z')));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts an authorisation-code flow with the exact IMAP scope and PKCE', () => {
    const pending = beginAuthorisation(MICROSOFT_THUNDERBIRD, 'james@example.com');
    const url = new URL(pending.url);

    expect(url.origin + url.pathname).toBe(MICROSOFT_THUNDERBIRD.authorizeUrl);
    expect(url.searchParams.get('client_id')).toBe(MICROSOFT_THUNDERBIRD.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe('https://localhost');
    expect(url.searchParams.get('scope')).toBe(
      'https://outlook.office365.com/IMAP.AccessAsUser.All offline_access',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('state')).toBe(pending.state);
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('login_hint')).toBe('james@example.com');
    expect(pending.verifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(pending.state).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it('exchanges the pasted callback without a client secret', async () => {
    const pending = beginAuthorisation(MICROSOFT_THUNDERBIRD, 'james@example.com');
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const fields = new URLSearchParams(String(init?.body));
      expect(fields.get('grant_type')).toBe('authorization_code');
      expect(fields.get('code')).toBe('one-use-code');
      expect(fields.get('code_verifier')).toBe(pending.verifier);
      expect(fields.has('client_secret')).toBe(false);
      return tokenResponse({
        access_token: 'access-token',
        expires_in: 3600,
        refresh_token: 'refresh-token',
        scope: MICROSOFT_THUNDERBIRD.scope,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      completeAuthorisation(
        MICROSOFT_THUNDERBIRD,
        pending,
        `https://localhost/?code=one-use-code&state=${pending.state}`,
      ),
    ).resolves.toEqual({
      accessToken: 'access-token',
      expiresAt: Date.now() + 3_600_000,
      refreshToken: 'refresh-token',
      scope: MICROSOFT_THUNDERBIRD.scope,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      MICROSOFT_THUNDERBIRD.tokenUrl,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it.each([
    ['wrong state', 'https://localhost/?code=code&state=wrong', 0, 'oauth-state-mismatch'],
    ['missing code', 'https://localhost/?state=STATE', 0, 'oauth-code-missing'],
    [
      'expired request',
      'https://localhost/?code=code&state=STATE',
      600_001,
      'oauth-authorisation-expired',
    ],
  ])('rejects a %s', async (_name, callbackTemplate, age, message) => {
    const pending = beginAuthorisation(MICROSOFT_THUNDERBIRD, 'james@example.com');
    const callback = callbackTemplate.replace('STATE', pending.state);
    vi.setSystemTime(pending.createdAt + age);
    await expect(
      completeAuthorisation(MICROSOFT_THUNDERBIRD, pending, callback),
    ).rejects.toMatchObject({ kind: 'auth', message });
  });

  it('rejects a code exchange that omits the refresh token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => tokenResponse({ access_token: 'access', expires_in: 60 })),
    );
    const pending = beginAuthorisation(MICROSOFT_THUNDERBIRD, 'james@example.com');

    await expect(
      completeAuthorisation(
        MICROSOFT_THUNDERBIRD,
        pending,
        `https://localhost/?code=code&state=${pending.state}`,
      ),
    ).rejects.toMatchObject({ kind: 'auth', message: 'oauth-refresh-token-missing' });
  });

  it('maps invalid_grant to auth and other token failures to transient', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => tokenResponse({ error: 'invalid_grant' }, 400)),
    );
    await expect(
      refreshAccessToken(MICROSOFT_THUNDERBIRD, 'expired-refresh-token'),
    ).rejects.toEqual(expect.objectContaining<Partial<AdapterError>>({ kind: 'auth' }));

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => tokenResponse({ error: 'temporarily_unavailable' }, 503)),
    );
    await expect(refreshAccessToken(MICROSOFT_THUNDERBIRD, 'refresh-token')).rejects.toEqual(
      expect.objectContaining<Partial<AdapterError>>({ kind: 'transient' }),
    );
  });
});

function tokenResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
