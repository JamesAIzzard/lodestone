import { createHash, randomBytes } from 'node:crypto';

import { AdapterError } from './adapter';

export interface OAuthProviderConfig {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  scope: string;
}

export interface PendingAuthorisation {
  url: string;
  state: string;
  verifier: string;
  createdAt: number;
}

export interface TokenSet {
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
  scope: string;
}

export const MICROSOFT_THUNDERBIRD: OAuthProviderConfig = {
  clientId: '9e5f94bc-e8a4-4e73-b8be-63364c29d753',
  authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  redirectUri: 'https://localhost',
  scope: 'https://outlook.office365.com/IMAP.AccessAsUser.All offline_access',
};

const AUTHORISATION_LIFETIME_MS = 10 * 60 * 1_000;

export function beginAuthorisation(
  config: OAuthProviderConfig,
  loginHint: string,
): PendingAuthorisation {
  const verifier = randomBytes(48).toString('base64url');
  const state = randomBytes(12).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(config.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: config.redirectUri,
    scope: config.scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    prompt: 'select_account',
    login_hint: loginHint,
  }).toString();
  return { url: url.toString(), state, verifier, createdAt: Date.now() };
}

export async function completeAuthorisation(
  config: OAuthProviderConfig,
  pending: PendingAuthorisation,
  pastedUrl: string,
): Promise<TokenSet> {
  if (Date.now() - pending.createdAt > AUTHORISATION_LIFETIME_MS) {
    throw new AdapterError('auth', 'oauth-authorisation-expired');
  }

  const callback = parseCallbackUrl(pastedUrl);
  if (callback.searchParams.get('state') !== pending.state) {
    throw new AdapterError('auth', 'oauth-state-mismatch');
  }
  const code = callback.searchParams.get('code');
  if (!code) throw new AdapterError('auth', 'oauth-code-missing');

  const response = await requestToken(config, {
    client_id: config.clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    code_verifier: pending.verifier,
  });
  if (!response.refresh_token) {
    throw new AdapterError('auth', 'oauth-refresh-token-missing');
  }
  return tokenSet(response, response.refresh_token, config.scope);
}

export async function refreshAccessToken(
  config: OAuthProviderConfig,
  refreshToken: string,
): Promise<TokenSet> {
  const response = await requestToken(config, {
    client_id: config.clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: config.scope,
  });
  return tokenSet(response, response.refresh_token ?? refreshToken, config.scope);
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
}

async function requestToken(
  config: OAuthProviderConfig,
  fields: Record<string, string>,
): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });
  } catch (error) {
    throw new AdapterError('transient', 'oauth-token-request-failed', { cause: error });
  }

  let body: TokenResponse;
  try {
    body = (await response.json()) as TokenResponse;
  } catch (error) {
    throw new AdapterError('transient', 'oauth-token-response-invalid', { cause: error });
  }
  if (!response.ok || body.error) {
    throw new AdapterError(
      body.error === 'invalid_grant' ? 'auth' : 'transient',
      `oauth-token-error:${body.error ?? response.status}`,
    );
  }
  return body;
}

function tokenSet(response: TokenResponse, refreshToken: string, defaultScope: string): TokenSet {
  if (!response.access_token || !validExpiry(response.expires_in)) {
    throw new AdapterError('transient', 'oauth-token-response-incomplete');
  }
  return {
    accessToken: response.access_token,
    expiresAt: Date.now() + response.expires_in * 1_000,
    refreshToken,
    scope: response.scope ?? defaultScope,
  };
}

function validExpiry(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function parseCallbackUrl(value: string): URL {
  try {
    return new URL(value.trim());
  } catch (error) {
    throw new AdapterError('auth', 'oauth-callback-url-invalid', { cause: error });
  }
}
