import { describe, expect, it } from 'vitest';

import { InMemoryCredentialStore } from './credential-store';

describe('InMemoryCredentialStore', () => {
  it('round-trips and deletes both credential kinds without returning shared objects', async () => {
    const store = new InMemoryCredentialStore();
    await store.save('password-account', { kind: 'password', password: 'app-password' });
    await store.save('oauth-account', {
      kind: 'oauth',
      refreshToken: 'refresh-token',
      clientId: 'client-id',
    });

    const password = await store.load('password-account');
    const oauth = await store.load('oauth-account');
    expect(password).toEqual({ kind: 'password', password: 'app-password' });
    expect(oauth).toEqual({
      kind: 'oauth',
      refreshToken: 'refresh-token',
      clientId: 'client-id',
    });
    expect(password).not.toBe(await store.load('password-account'));

    await store.delete('password-account');
    await store.delete('password-account');
    expect(await store.load('password-account')).toBeNull();
  });
});
