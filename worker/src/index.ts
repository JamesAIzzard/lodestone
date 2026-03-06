/**
 * Lodestone MCP Worker — Cloudflare Worker with D1, Vectorize, and Workers AI.
 *
 * Memory storage in D1, embedding vectors in Vectorize (EmbeddingGemma 300M
 * via Workers AI). Provides BM25 keyword search, semantic search, hybrid
 * search, dedup detection, and related-memory discovery.
 */

import { createMcpHandler } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { D1MemoryService } from './d1-memory-service';
import { embedDocument } from './embedding';
import { addToInvertedIndex, removeFromInvertedIndex, updateMemoryCorpusStats } from './d1/inverted-index';
import { getAllTasks } from './d1/read';
import type { MemoryStatusValue, PriorityLevel } from './shared/types';
import {
  registerRememberTool,
  registerRecallTool,
  registerReviseTool,
  registerForgetTool,
  registerSkipTool,
  registerAgendaTool,
  registerGetDatetimeTool,
  registerReadTool,
  registerGuideTool,
} from './tools/memory';

// ── Env bindings (populated by wrangler.jsonc) ──────────────────────────────

interface Env {
  /** Bearer token for API auth. Set via `wrangler secret put AUTH_TOKEN`. */
  AUTH_TOKEN?: string;
  /** D1 database binding for memory storage. */
  DB: D1Database;
  /** Workers AI binding for EmbeddingGemma 300M. */
  AI: Ai;
  /** Vectorize index binding for memory embedding vectors. */
  VECTORIZE: Vectorize;
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
    name: 'lodestone-memory',
    version: '0.1.0',
  });

  const memory = new D1MemoryService(env.DB, env.AI, env.VECTORIZE);

  // Register all memory tools
  registerRememberTool(server, memory);
  registerRecallTool(server, memory);
  registerReviseTool(server, memory);
  registerForgetTool(server, memory);
  registerSkipTool(server, memory);
  registerAgendaTool(server, memory);
  registerGetDatetimeTool(server);
  registerReadTool(server, memory);
  registerGuideTool(server);

  return server;
}

// ── Worker fetch handler ────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check (unauthenticated)
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', name: 'lodestone-memory', version: '0.1.0' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // All other routes require auth
    const authError = authenticate(request, env);
    if (authError) return authError;

    // List tasks: GET /tasks?includeCompleted=false&limit=200
    if (url.pathname === '/tasks' && request.method === 'GET') {
      const includeCompleted = url.searchParams.get('includeCompleted') === 'true';
      const rawLimit = parseInt(url.searchParams.get('limit') ?? '200', 10);
      const limit = Number.isNaN(rawLimit) ? 200 : Math.min(rawLimit, 500);
      const tasks = await getAllTasks(env.DB, includeCompleted, limit);
      return new Response(JSON.stringify({ tasks }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Revise task: PATCH /tasks/:id
    const taskPatchMatch = url.pathname.match(/^\/tasks\/(\d+)$/);
    if (taskPatchMatch && request.method === 'PATCH') {
      const id = parseInt(taskPatchMatch[1], 10);
      const body = await request.json() as {
        status?: MemoryStatusValue | null;
        priority?: PriorityLevel | null;
        actionDate?: string | null;
        topic?: string;
      };
      const memory = new D1MemoryService(env.DB, env.AI, env.VECTORIZE);
      await memory.revise({
        id,
        ...(body.status !== undefined && { status: body.status }),
        ...(body.priority !== undefined && { priority: body.priority }),
        ...(body.actionDate !== undefined && { actionDate: body.actionDate }),
        ...(body.topic !== undefined && { topic: body.topic }),
      });
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Rebuild all indexes: inverted index (BM25) + Vectorize embeddings
    // ?scope=bm25|vectors|all (default: all)
    // ?from=N&to=N — optional ID range filter for chunked vector rebuilds
    if (url.pathname === '/reindex' && request.method === 'POST') {
      const scope = url.searchParams.get('scope') ?? 'all';
      const fromId = url.searchParams.get('from');
      const toId = url.searchParams.get('to');

      let query = `SELECT id, topic, body FROM memories WHERE deleted_at IS NULL`;
      const binds: unknown[] = [];
      if (fromId) { query += ` AND id >= ?`; binds.push(Number(fromId)); }
      if (toId) { query += ` AND id <= ?`; binds.push(Number(toId)); }
      query += ` ORDER BY id`;

      const stmt = env.DB.prepare(query);
      const { results: rows } = binds.length > 0 ? await stmt.bind(...binds).all() : await stmt.all();

      let bm25Count = 0;
      let vectorCount = 0;

      // Rebuild inverted index for BM25
      if (scope === 'all' || scope === 'bm25') {
        // Clear existing index
        await env.DB.batch([
          env.DB.prepare('DELETE FROM memory_postings'),
          env.DB.prepare('DELETE FROM memory_terms'),
          env.DB.prepare('DELETE FROM memory_metadata'),
        ]);

        for (const row of rows) {
          const r = row as Record<string, unknown>;
          await addToInvertedIndex(env.DB, r.id as number, r.body as string);
          bm25Count++;
        }
        await updateMemoryCorpusStats(env.DB);
      }

      // Rebuild Vectorize embeddings
      if (scope === 'all' || scope === 'vectors') {
        // Process in batches of 10 to stay within Workers AI rate limits
        for (let i = 0; i < rows.length; i += 10) {
          const batch = rows.slice(i, i + 10);
          const vectors: VectorizeVector[] = [];

          for (const row of batch) {
            const r = row as Record<string, unknown>;
            const embedding = await embedDocument(env.AI, r.topic as string, r.body as string);
            vectors.push({ id: String(r.id), values: embedding });
            vectorCount++;
          }

          if (vectors.length > 0) {
            await env.VECTORIZE.upsert(vectors);
          }
        }
      }

      return new Response(JSON.stringify({ status: 'ok', bm25: bm25Count, vectors: vectorCount }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // MCP endpoint
    if (url.pathname === '/mcp') {
      const server = createServer(env);
      return createMcpHandler(server)(request, env, ctx);
    }

    return new Response('Not Found', { status: 404 });
  },
};
