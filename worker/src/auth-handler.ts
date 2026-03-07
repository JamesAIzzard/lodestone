/**
 * Default handler for the OAuthProvider.
 *
 * Handles two concerns:
 * 1. OAuth authorization flow — password-protected authorize endpoint
 * 2. REST API routes — Bearer token auth for Electron GUI (/tasks, /projects, etc.)
 *
 * The OAuthProvider routes /mcp requests to the apiHandler (MCP server) and
 * everything else here. OAuth protocol endpoints (/token, /register,
 * /.well-known/*) are handled by OAuthProvider itself before reaching this.
 */

import type { AuthRequest } from '@cloudflare/workers-oauth-provider';
import { authenticate, type Env } from './auth';
import { D1MemoryService } from './d1-memory-service';
import { addToInvertedIndex, updateMemoryCorpusStats } from './d1/inverted-index';
import { getAllTasks } from './d1/read';
import { embedDocument } from './embedding';
import type { MemoryStatusValue, PriorityLevel } from './shared/types';

// ── OAuth authorize flow ─────────────────────────────────────────────────────

export async function handleDefaultRequest(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  // ── GET /authorize — render password form ──────────────────────────────
  if (request.method === 'GET' && pathname === '/authorize') {
    try {
      const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      if (!oauthReqInfo.clientId) {
        return new Response('Missing client_id', { status: 400 });
      }

      const client = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
      const clientName = client?.clientName ?? 'Unknown MCP Client';

      // Generate CSRF token stored in KV (10-min TTL)
      const csrfToken = crypto.randomUUID();
      await env.OAUTH_KV.put(`csrf:${csrfToken}`, '1', { expirationTtl: 600 });

      // Encode OAuth request info in a hidden field
      const encodedState = btoa(JSON.stringify(oauthReqInfo));

      return renderPasswordForm({ clientName, csrfToken, encodedState });
    } catch (err) {
      return renderPasswordForm({
        clientName: 'Unknown',
        csrfToken: '',
        encodedState: '',
        error: 'Invalid authorization request.',
      });
    }
  }

  // ── POST /authorize — validate password, complete authorization ────────
  if (request.method === 'POST' && pathname === '/authorize') {
    const formData = await request.formData();

    // Validate CSRF token
    const csrfToken = formData.get('csrf_token');
    if (!csrfToken || typeof csrfToken !== 'string') {
      return renderPasswordForm({ clientName: 'Unknown', csrfToken: '', encodedState: '', error: 'Invalid request.' });
    }
    const csrfValid = await env.OAUTH_KV.get(`csrf:${csrfToken}`);
    if (!csrfValid) {
      return renderPasswordForm({ clientName: 'Unknown', csrfToken: '', encodedState: '', error: 'Session expired. Please try again.' });
    }
    await env.OAUTH_KV.delete(`csrf:${csrfToken}`);

    // Decode OAuth request info
    const encodedState = formData.get('state');
    if (!encodedState || typeof encodedState !== 'string') {
      return renderPasswordForm({ clientName: 'Unknown', csrfToken: '', encodedState: '', error: 'Invalid request.' });
    }

    let oauthReqInfo: AuthRequest;
    try {
      oauthReqInfo = JSON.parse(atob(encodedState)) as AuthRequest;
    } catch {
      return renderPasswordForm({ clientName: 'Unknown', csrfToken: '', encodedState: '', error: 'Invalid request.' });
    }

    // Check password
    const password = formData.get('password');
    if (!password || typeof password !== 'string' || !env.AUTH_PASSWORD || password !== env.AUTH_PASSWORD) {
      // Re-render form with error — need fresh CSRF token
      const client = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
      const clientName = client?.clientName ?? 'Unknown MCP Client';
      const newCsrf = crypto.randomUUID();
      await env.OAUTH_KV.put(`csrf:${newCsrf}`, '1', { expirationTtl: 600 });

      return renderPasswordForm({
        clientName,
        csrfToken: newCsrf,
        encodedState,
        error: 'Incorrect password.',
      });
    }

    // Password correct — complete the OAuth authorization
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      userId: 'owner',
      metadata: { label: 'Lodestone Owner' },
      scope: oauthReqInfo.scope,
      props: { userId: 'owner' },
    });

    return Response.redirect(redirectTo, 302);
  }

  // ── Health check (unauthenticated) ─────────────────────────────────────
  if (pathname === '/health') {
    return new Response(
      JSON.stringify({ status: 'ok', name: 'lodestone-memory', version: '0.1.0' }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }

  // ── REST API routes (Bearer token auth) ────────────────────────────────

  const authError = authenticate(request, env);
  if (authError) return authError;

  // List/search tasks: GET /tasks
  if (pathname === '/tasks' && request.method === 'GET') {
    const q = url.searchParams.get('q')?.trim();
    const rawLimit = parseInt(url.searchParams.get('limit') ?? '200', 10);
    const limit = Number.isNaN(rawLimit) ? 200 : Math.min(rawLimit, 500);

    if (q) {
      try {
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
    const rawProjectId = url.searchParams.get('projectId');
    const projectId = rawProjectId ? parseInt(rawProjectId, 10) : undefined;
    const tasks = await getAllTasks(env.DB, { includeCompleted, includeCancelled, projectId }, limit);
    return new Response(JSON.stringify({ tasks }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Create task: POST /tasks
  if (pathname === '/tasks' && request.method === 'POST') {
    const body = (await request.json()) as {
      topic: string;
      status?: MemoryStatusValue;
      priority?: PriorityLevel;
      actionDate?: string;
      projectId?: number | null;
    };
    const memory = new D1MemoryService(env.DB, env.AI, env.VECTORIZE);
    const result = await memory.remember({
      topic: body.topic.trim(),
      body: '',
      status: body.status ?? 'open',
      priority: body.priority ?? null,
      actionDate: body.actionDate ?? null,
      projectId: body.projectId ?? null,
      force: true,
    });
    const id = result.status === 'created' ? result.id : (result as { existing: { id: number } }).existing.id;
    return new Response(JSON.stringify({ success: true, id }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Skip task occurrence: POST /tasks/:id/skip
  const taskSkipMatch = pathname.match(/^\/tasks\/(\d+)\/skip$/);
  if (taskSkipMatch && request.method === 'POST') {
    const id = parseInt(taskSkipMatch[1], 10);
    const body = (await request.json().catch(() => ({}))) as { reason?: string };
    const memory = new D1MemoryService(env.DB, env.AI, env.VECTORIZE);
    const result = await memory.skip(id, body.reason);
    return new Response(JSON.stringify({ success: true, nextActionDate: result.nextActionDate }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Revise task: PATCH /tasks/:id
  const taskPatchMatch = pathname.match(/^\/tasks\/(\d+)$/);
  if (taskPatchMatch && request.method === 'PATCH') {
    const id = parseInt(taskPatchMatch[1], 10);
    const payload = (await request.json()) as {
      body?: string;
      status?: MemoryStatusValue | null;
      priority?: PriorityLevel | null;
      actionDate?: string | null;
      recurrence?: string | null;
      topic?: string;
      projectId?: number | null;
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
      ...(payload.projectId !== undefined && { projectId: payload.projectId }),
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

  // ── Project routes ─────────────────────────────────────────────────────

  // List projects: GET /projects
  if (pathname === '/projects' && request.method === 'GET') {
    const memory = new D1MemoryService(env.DB, env.AI, env.VECTORIZE);
    const projects = await memory.getProjectsWithCounts();
    return new Response(JSON.stringify({ projects }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Create project: POST /projects
  if (pathname === '/projects' && request.method === 'POST') {
    const body = (await request.json()) as { name: string; color?: string };
    if (!body.name?.trim()) {
      return new Response(JSON.stringify({ error: 'Project name is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const memory = new D1MemoryService(env.DB, env.AI, env.VECTORIZE);
    try {
      const id = await memory.createProject(body.name.trim(), body.color ?? 'blue');
      return new Response(JSON.stringify({ success: true, id }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      const msg = String(err);
      if (msg.includes('UNIQUE constraint')) {
        return new Response(JSON.stringify({ error: `Project "${body.name}" already exists` }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw err;
    }
  }

  // Merge project: POST /projects/:id/merge
  const projectMergeMatch = pathname.match(/^\/projects\/(\d+)\/merge$/);
  if (projectMergeMatch && request.method === 'POST') {
    const sourceId = parseInt(projectMergeMatch[1], 10);
    const body = (await request.json()) as { targetId: number };
    if (!body.targetId) {
      return new Response(JSON.stringify({ error: 'targetId is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const memory = new D1MemoryService(env.DB, env.AI, env.VECTORIZE);
    const reassigned = await memory.mergeProjects(sourceId, body.targetId);
    return new Response(JSON.stringify({ success: true, reassigned }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Update project: PATCH /projects/:id
  const projectMatch = pathname.match(/^\/projects\/(\d+)$/);
  if (projectMatch && request.method === 'PATCH') {
    const id = parseInt(projectMatch[1], 10);
    const body = (await request.json()) as { name?: string; color?: string };
    const memory = new D1MemoryService(env.DB, env.AI, env.VECTORIZE);
    await memory.updateProject(id, body);
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Delete project: DELETE /projects/:id
  if (projectMatch && request.method === 'DELETE') {
    const id = parseInt(projectMatch[1], 10);
    const memory = new D1MemoryService(env.DB, env.AI, env.VECTORIZE);
    await memory.deleteProject(id);
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Reindex ────────────────────────────────────────────────────────────

  if (pathname === '/reindex' && request.method === 'POST') {
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

    if (scope === 'all' || scope === 'bm25') {
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

    if (scope === 'all' || scope === 'vectors') {
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

  return new Response('Not Found', { status: 404 });
}

// ── Password form HTML ───────────────────────────────────────────────────────

function renderPasswordForm(opts: {
  clientName: string;
  csrfToken: string;
  encodedState: string;
  error?: string;
}): Response {
  const { clientName, csrfToken, encodedState, error } = opts;

  // Escape HTML entities
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lodestone - Authorize</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0a0a0a; color: #e5e5e5;
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
    }
    .card {
      background: #171717; border: 1px solid #262626; border-radius: 12px;
      padding: 2rem; width: 100%; max-width: 400px;
    }
    .title { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.25rem; color: #fafafa; }
    .subtitle { font-size: 0.875rem; color: #a3a3a3; margin-bottom: 1.5rem; }
    .client-name { color: #f97316; font-weight: 500; }
    .error {
      background: #7f1d1d; border: 1px solid #991b1b; border-radius: 6px;
      padding: 0.625rem 0.75rem; margin-bottom: 1rem; font-size: 0.875rem; color: #fca5a5;
    }
    label { display: block; font-size: 0.875rem; font-weight: 500; margin-bottom: 0.375rem; color: #d4d4d4; }
    input[type="password"] {
      width: 100%; padding: 0.625rem 0.75rem; border: 1px solid #404040; border-radius: 6px;
      background: #0a0a0a; color: #fafafa; font-size: 0.9375rem;
      outline: none; transition: border-color 0.15s;
    }
    input[type="password"]:focus { border-color: #f97316; }
    .actions { display: flex; justify-content: flex-end; margin-top: 1.25rem; }
    button {
      padding: 0.625rem 1.5rem; border: none; border-radius: 6px;
      font-size: 0.875rem; font-weight: 500; cursor: pointer;
      background: #f97316; color: #fff; transition: background 0.15s;
    }
    button:hover { background: #ea580c; }
  </style>
</head>
<body>
  <div class="card">
    <div class="title">Lodestone</div>
    <div class="subtitle"><span class="client-name">${esc(clientName)}</span> is requesting access</div>
    ${error ? `<div class="error">${esc(error)}</div>` : ''}
    <form method="POST" action="/authorize">
      <input type="hidden" name="csrf_token" value="${esc(csrfToken)}">
      <input type="hidden" name="state" value="${esc(encodedState)}">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required autofocus>
      <div class="actions">
        <button type="submit">Authorize</button>
      </div>
    </form>
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
    },
  });
}
