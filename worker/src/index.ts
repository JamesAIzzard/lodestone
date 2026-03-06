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

    // List tasks: GET /tasks?includeCompleted=false&includeCancelled=false&limit=200
    // Search tasks: GET /tasks?q=search+terms  (hybrid search, sorted by relevance)
    if (url.pathname === '/tasks' && request.method === 'GET') {
      const q = url.searchParams.get('q')?.trim();
      const rawLimit = parseInt(url.searchParams.get('limit') ?? '200', 10);
      const limit = Number.isNaN(rawLimit) ? 200 : Math.min(rawLimit, 500);

      if (q) {
        try {
          // Hybrid search — fetch more than needed, then filter to status-bearing tasks
          const memory = new D1MemoryService(env.DB, env.AI, env.VECTORIZE);
          const results = await memory.recall({ query: q, maxResults: Math.min(limit, 50), mode: 'hybrid' });
          const tasks = results
            .filter((r) => r.status != null)
            .slice(0, limit)
            .map(({ score, scoreLabel, signals, ...task }) => ({ ...task, _score: score }));
          return new Response(JSON.stringify({ tasks }), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (err) {
          return new Response(JSON.stringify({ error: String(err), stack: (err as Error).stack }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      const includeCompleted = url.searchParams.get('includeCompleted') === 'true';
      const includeCancelled = url.searchParams.get('includeCancelled') === 'true';
      const tasks = await getAllTasks(env.DB, { includeCompleted, includeCancelled }, limit);
      return new Response(JSON.stringify({ tasks }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Create task: POST /tasks
    if (url.pathname === '/tasks' && request.method === 'POST') {
      const body = await request.json() as { topic: string; status?: MemoryStatusValue; priority?: PriorityLevel; actionDate?: string };
      const memory = new D1MemoryService(env.DB, env.AI, env.VECTORIZE);
      const result = await memory.remember({
        topic: body.topic.trim(),
        body: '',
        status: body.status ?? 'open',
        priority: body.priority ?? null,
        actionDate: body.actionDate ?? null,
        force: true,
      });
      const id = result.status === 'created' ? result.id : (result as { existing: { id: number } }).existing.id;
      return new Response(JSON.stringify({ success: true, id }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Skip task occurrence: POST /tasks/:id/skip
    const taskSkipMatch = url.pathname.match(/^\/tasks\/(\d+)\/skip$/);
    if (taskSkipMatch && request.method === 'POST') {
      const id = parseInt(taskSkipMatch[1], 10);
      const body = await request.json().catch(() => ({})) as { reason?: string };
      const memory = new D1MemoryService(env.DB, env.AI, env.VECTORIZE);
      const result = await memory.skip(id, body.reason);
      return new Response(JSON.stringify({ success: true, nextActionDate: result.nextActionDate }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Revise / Delete task: PATCH|DELETE /tasks/:id
    const taskPatchMatch = url.pathname.match(/^\/tasks\/(\d+)$/);
    if (taskPatchMatch && request.method === 'PATCH') {
      const id = parseInt(taskPatchMatch[1], 10);
      const payload = await request.json() as {
        body?: string;
        status?: MemoryStatusValue | null;
        priority?: PriorityLevel | null;
        actionDate?: string | null;
        recurrence?: string | null;
        topic?: string;
      };
      const memory = new D1MemoryService(env.DB, env.AI, env.VECTORIZE);
      const result = await memory.revise({
        id,
        ...(payload.body !== undefined && { body: payload.body }),
        ...(payload.status !== undefined && { status: payload.status }),
        ...(payload.priority !== undefined && { priority: payload.priority }),
        ...(payload.actionDate !== undefined && { actionDate: payload.actionDate }),
        ...(payload.recurrence !== undefined && { recurrence: payload.recurrence }),
        ...(payload.topic !== undefined && { topic: payload.topic }),
      });
      return new Response(JSON.stringify({ success: true, ...result }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Delete task: DELETE /tasks/:id
    if (taskPatchMatch && request.method === 'DELETE') {
      const id = parseInt(taskPatchMatch[1], 10);
      const memory = new D1MemoryService(env.DB, env.AI, env.VECTORIZE);
      await memory.forget(id, 'Deleted via Tasks GUI');
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
