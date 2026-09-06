import { AdapterError } from './adapter';
import type { CredentialStore } from './credential-store';
import { refreshAccessToken, type OAuthProviderConfig } from './oauth';

export interface AccessTokenSource {
  (): Promise<string>;
  invalidate(): void;
}

export function createAccessTokenSource(
  config: OAuthProviderConfig,
  store: CredentialStore,
  accountHash: string,
): AccessTokenSource {
  let cached: { accessToken: string; expiresAt: number } | null = null;
  let inFlight: Promise<string> | null = null;

  const source = async (): Promise<string> => {
    if (cached && Date.now() < cached.expiresAt - 60_000) return cached.accessToken;
    if (!inFlight) {
      inFlight = (async () => {
        try {
          const tokenSet = await mintAccessToken(config, store, accountHash);
          cached = { accessToken: tokenSet.accessToken, expiresAt: tokenSet.expiresAt };
          return tokenSet.accessToken;
        } finally {
          inFlight = null;
        }
      })();
    }
    return inFlight;
  };

  source.invalidate = () => {
    cached = null;
  };
  return source;
}

async function mintAccessToken(
  config: OAuthProviderConfig,
  store: CredentialStore,
  accountHash: string,
) {
  const credential = await store.load(accountHash);
  if (!credential || credential.kind !== 'oauth') {
    throw new AdapterError('auth', 'oauth-credential-missing');
  }
  const provider = { ...config, clientId: credential.clientId };
  const tokenSet = await refreshAccessToken(provider, credential.refreshToken);
  if (tokenSet.refreshToken !== credential.refreshToken) {
    await store.save(accountHash, {
      kind: 'oauth',
      refreshToken: tokenSet.refreshToken,
      clientId: credential.clientId,
    });
  }
  return tokenSet;
}
