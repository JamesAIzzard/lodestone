import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credential, CredentialStore } from './credential-store';
import { InMemoryCredentialStore } from './credential-store';
import { MICROSOFT_THUNDERBIRD } from './oauth';
import { createAccessTokenSource } from './token-source';

const ACCOUNT_HASH = '0123456789abcdef0123456789abcdef';

describe('access-token source', () => {
  beforeEach(() => vi.setSystemTime(new Date('2026-09-06T10:00:00Z')));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('caches until 60 seconds before expiry and can be explicitly invalidated', async () => {
    const store = await oauthStore();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse('access-1', 3600))
      .mockResolvedValueOnce(tokenResponse('access-2', 3600))
      .mockResolvedValueOnce(tokenResponse('access-3', 3600));
    vi.stubGlobal('fetch', fetchMock);
    const source = createAccessTokenSource(MICROSOFT_THUNDERBIRD, store, ACCOUNT_HASH);

    await expect(source()).resolves.toBe('access-1');
    vi.setSystemTime(new Date('2026-09-06T10:58:59Z'));
    await expect(source()).resolves.toBe('access-1');
    vi.setSystemTime(new Date('2026-09-06T10:59:00Z'));
    await expect(source()).resolves.toBe('access-2');
    source.invalidate();
    await expect(source()).resolves.toBe('access-3');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('shares one in-flight refresh between concurrent callers', async () => {
    const store = await oauthStore();
    let resolveResponse: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveResponse = resolve;
          }),
      ),
    );
    const source = createAccessTokenSource(MICROSOFT_THUNDERBIRD, store, ACCOUNT_HASH);

    const first = source();
    const second = source();
    await vi.waitFor(() => expect(resolveResponse).toBeTypeOf('function'));
    resolveResponse?.(tokenResponse('shared-access', 3600));

    await expect(Promise.all([first, second])).resolves.toEqual(['shared-access', 'shared-access']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('persists a rotated refresh token before returning the access token', async () => {
    const operations: string[] = [];
    const store = new RecordingStore(operations);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => tokenResponse('access-token', 3600, 'rotated-refresh-token')),
    );
    const source = createAccessTokenSource(MICROSOFT_THUNDERBIRD, store, ACCOUNT_HASH);

    await expect(source()).resolves.toBe('access-token');
    operations.push('returned');

    expect(operations).toEqual(['load', 'save:rotated-refresh-token', 'returned']);
    expect(await store.load(ACCOUNT_HASH)).toMatchObject({
      kind: 'oauth',
      refreshToken: 'rotated-refresh-token',
    });
  });
});

async function oauthStore(): Promise<InMemoryCredentialStore> {
  const store = new InMemoryCredentialStore();
  await store.save(ACCOUNT_HASH, {
    kind: 'oauth',
    refreshToken: 'refresh-token',
    clientId: MICROSOFT_THUNDERBIRD.clientId,
  });
  return store;
}

function tokenResponse(
  accessToken: string,
  expiresIn: number,
  refreshToken = 'refresh-token',
): Response {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: MICROSOFT_THUNDERBIRD.scope,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

class RecordingStore implements CredentialStore {
  private credential: Credential = {
    kind: 'oauth',
    refreshToken: 'refresh-token',
    clientId: MICROSOFT_THUNDERBIRD.clientId,
  };

  constructor(private readonly operations: string[]) {}

  async save(_accountHash: string, credential: Credential): Promise<void> {
    this.operations.push(
      `save:${credential.kind === 'oauth' ? credential.refreshToken : credential.kind}`,
    );
    this.credential = structuredClone(credential);
  }

  async load(accountHash: string): Promise<Credential | null> {
    if (accountHash !== ACCOUNT_HASH) throw new Error('Unexpected account hash.');
    this.operations.push('load');
    return structuredClone(this.credential);
  }

  async delete(): Promise<void> {
    throw new Error('Not used by this test.');
  }
}
