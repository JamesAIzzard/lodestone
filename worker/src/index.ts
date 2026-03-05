/**
 * Lodestone MCP Worker — Cloudflare Worker with D1-backed memory.
 *
 * Phase 1 of the Task & Memory migration: all 8 memory tools powered by
 * Cloudflare D1 (BM25 keyword search). Semantic/embedding features arrive
 * in Phase 3 (Vectorize).
 */

import { createMcpHandler } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { D1MemoryService } from './d1-memory-service';
import {
  registerRememberTool,
  registerRecallTool,
  registerReviseTool,
  registerForgetTool,
  registerSkipTool,
  registerOrientTool,
  registerAgendaTool,
  registerGetDatetimeTool,
  registerReadTool,
} from './tools/memory';

// ── Env bindings (populated by wrangler.jsonc) ──────────────────────────────

interface Env {
  /** Bearer token for API auth. Set via `wrangler secret put AUTH_TOKEN`. */
  AUTH_TOKEN?: string;
  /** D1 database binding for memory storage. */
  DB: D1Database;
}

// ── Auth ────────────────────────────────────────────────────────────────────

function authenticate(request: Request, env: Env): Response | null {
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

  return null; // Auth passed
}

// ── MCP Server ──────────────────────────────────────────────────────────────

function createServer(env: Env): McpServer {
  const server = new McpServer({
    name: 'Lodestone',
    version: '0.1.0',
  });

  const memory = new D1MemoryService(env.DB);

  // Register all memory tools
  registerRememberTool(server, memory);
  registerRecallTool(server, memory);
  registerReviseTool(server, memory);
  registerForgetTool(server, memory);
  registerSkipTool(server, memory);
  registerOrientTool(server, memory);
  registerAgendaTool(server, memory);
  registerGetDatetimeTool(server);
  registerReadTool(server, memory);

  return server;
}

// ── Worker fetch handler ────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check (unauthenticated)
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', name: 'Lodestone MCP', version: '0.1.0' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // All other routes require auth
    const authError = authenticate(request, env);
    if (authError) return authError;

    // MCP endpoint
    if (url.pathname === '/mcp') {
      const server = createServer(env);
      return createMcpHandler(server)(request, env, ctx);
    }

    return new Response('Not Found', { status: 404 });
  },
};
