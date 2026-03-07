/**
 * Shared auth types and Bearer token authentication.
 *
 * Extracted from index.ts to avoid circular imports between
 * index.ts (OAuthProvider) and auth-handler.ts (defaultHandler).
 */

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

// ── Env bindings (populated by wrangler.jsonc + secrets) ─────────────────────

export interface Env {
  /** Bearer token for REST API auth (Electron GUI). */
  AUTH_TOKEN?: string;
  /** Password for the OAuth authorize form (Claude connector). */
  AUTH_PASSWORD?: string;
  /** D1 database binding for memory storage. */
  DB: D1Database;
  /** Workers AI binding for EmbeddingGemma 300M. */
  AI: Ai;
  /** Vectorize index binding for memory embedding vectors. */
  VECTORIZE: Vectorize;
  /** KV namespace for OAuth token/client storage. Required by OAuthProvider. */
  OAUTH_KV: KVNamespace;
  /** OAuth helpers injected by OAuthProvider at runtime. */
  OAUTH_PROVIDER: OAuthHelpers;
}

// ── Bearer token auth (for REST API endpoints) ──────────────────────────────

/** Returns null on success, or an error Response on failure. */
export function authenticate(request: Request, env: Env): Response | null {
  // Skip auth if no token configured (local dev convenience)
  if (!env.AUTH_TOKEN) return null;

  const header = request.headers.get('Authorization');
  if (!header || !header.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 });
  }

  const token = header.slice(7);
  if (token !== env.AUTH_TOKEN) {
    return new Response('Forbidden', { status: 403 });
  }

  return null;
}
