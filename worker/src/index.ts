/**
 * Lodestone MCP Worker — Cloudflare Worker with D1, Vectorize, and Workers AI.
 *
 * Memory storage in D1, embedding vectors in Vectorize (EmbeddingGemma 300M
 * via Workers AI). Provides BM25 keyword search, semantic search, hybrid
 * search, dedup detection, and related-memory discovery.
 *
 * OAuth 2.1 via @cloudflare/workers-oauth-provider:
 * - /mcp requests require a valid OAuth access token (issued after password auth)
 * - REST API routes (/tasks, /projects, etc.) use Bearer token auth (for Electron GUI)
 * - OAuth protocol endpoints (/token, /register, /.well-known/*) handled by OAuthProvider
 */

import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { handleDefaultRequest } from './auth-handler';
import type { Env } from './auth';
import { D1MemoryService } from './d1-memory-service';
import {
  registerRememberTool,
  registerTaskTool,
  registerRecallTool,
  registerReviseTool,
  registerForgetTool,
  registerSkipTool,
  registerAgendaTool,
  registerGetDatetimeTool,
  registerReadTool,
  registerGuideTool,
  registerProjectTool,
} from './tools/memory';

// ── MCP Server ──────────────────────────────────────────────────────────────

function createServer(env: Env): McpServer {
  const server = new McpServer({
    name: 'lodestone-memory',
    version: '0.1.0',
  });

  const memory = new D1MemoryService(env.DB, env.AI, env.VECTORIZE);

  registerRememberTool(server, memory);
  registerTaskTool(server, memory);
  registerRecallTool(server, memory);
  registerReviseTool(server, memory);
  registerForgetTool(server, memory);
  registerSkipTool(server, memory);
  registerAgendaTool(server, memory);
  registerGetDatetimeTool(server);
  registerReadTool(server, memory);
  registerProjectTool(server, memory);
  registerGuideTool(server);

  return server;
}

// ── OAuthProvider (Worker entrypoint) ────────────────────────────────────────

export default new OAuthProvider<Env>({
  apiRoute: '/mcp',
  apiHandler: {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const server = createServer(env);
      return createMcpHandler(server)(request, env, ctx);
    },
  },
  defaultHandler: {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      return handleDefaultRequest(request, env, ctx);
    },
  },
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  accessTokenTTL: 3600,         // 1 hour
  refreshTokenTTL: 90 * 86400,  // 90 days
});
