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
import { getAllTasks, getMemory } from './d1/read';
import { upsertDayOrder, deleteDayOrder, rebalanceDayOrder } from './d1/write';
import { embedDocument } from './embedding';
import type { MemoryStatusValue, PriorityLevel } from './shared/types';

// ── JSON response helper ────────────────────────────────────────────────────

function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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
    return jsonResponse({ status: 'ok', name: 'lodestone-memory', version: '0.1.0' });
  }

  // ── REST API routes (Bearer token auth) ────────────────────────────────

  const authError = authenticate(request, env);
  if (authError) return authError;

  const memory = new D1MemoryService(env.DB, env.AI, env.VECTORIZE);

  const taskResponse = await handleTaskRoutes(request, url, pathname, env, memory);
  if (taskResponse) return taskResponse;

  const projectResponse = await handleProjectRoutes(request, pathname, memory);
  if (projectResponse) return projectResponse;

  const reindexResponse = await handleReindexRoute(request, url, pathname, env);
  if (reindexResponse) return reindexResponse;

  return new Response('Not Found', { status: 404 });
}

// ── Task routes ─────────────────────────────────────────────────────────────

async function handleTaskRoutes(
  request: Request,
  url: URL,
  pathname: string,
  env: Env,
  memory: D1MemoryService,
): Promise<Response | null> {
  // List/search tasks: GET /tasks
  if (pathname === '/tasks' && request.method === 'GET') {
    const q = url.searchParams.get('q')?.trim();
    const rawLimit = parseInt(url.searchParams.get('limit') ?? '200', 10);
    const limit = Number.isNaN(rawLimit) ? 200 : Math.min(rawLimit, 500);

    if (q) {
      try {
        const results = await memory.recall({ query: q, maxResults: Math.min(limit, 50), mode: 'hybrid' });
        const tasks = results
          .filter((r) => r.status != null)
          .slice(0, limit)
          .map(({ score, scoreLabel, signals, ...task }) => ({ ...task, _score: score }));
        return jsonResponse({ tasks });
      } catch (err) {
        return jsonResponse({ error: String(err), stack: (err as Error).stack }, 500);
      }
    }

    const includeCompleted = url.searchParams.get('includeCompleted') === 'true';
    const includeCancelled = url.searchParams.get('includeCancelled') === 'true';
    const rawProjectId = url.searchParams.get('projectId');
    const projectId = rawProjectId ? parseInt(rawProjectId, 10) : undefined;
    const tasks = await getAllTasks(env.DB, { includeCompleted, includeCancelled, projectId }, limit);
    return jsonResponse({ tasks });
  }

  // Create task: POST /tasks
  if (pathname === '/tasks' && request.method === 'POST') {
    const body = (await request.json()) as {
      topic: string;
      status?: MemoryStatusValue;
      priority?: PriorityLevel;
      actionDate?: string;
      dueDate?: string;
      projectId?: number | null;
    };
    // Tasks always have an action_date — default to today if not provided
    const today = new Date().toISOString().slice(0, 10);
    const result = await memory.remember({
      topic: body.topic.trim(),
      body: '',
      status: body.status ?? 'open',
      priority: body.priority ?? null,
      actionDate: body.actionDate ?? today,
      dueDate: body.dueDate ?? null,
      projectId: body.projectId ?? null,
      force: true,
    });
    const id = result.status === 'created' ? result.id : (result as { existing: { id: number } }).existing.id;
    return jsonResponse({ success: true, id });
  }

  // Skip task occurrence: POST /tasks/:id/skip
  const taskSkipMatch = pathname.match(/^\/tasks\/(\d+)\/skip$/);
  if (taskSkipMatch && request.method === 'POST') {
    const id = parseInt(taskSkipMatch[1], 10);
    const body = (await request.json().catch(() => ({}))) as { reason?: string };
    const result = await memory.skip(id, body.reason);
    return jsonResponse({ success: true, nextActionDate: result.nextActionDate });
  }

  // Upsert day order: PUT /tasks/:id/day-order
  const dayOrderMatch = pathname.match(/^\/tasks\/(\d+)\/day-order$/);
  if (dayOrderMatch && request.method === 'PUT') {
    const id = parseInt(dayOrderMatch[1], 10);
    const body = (await request.json()) as { actionDate: string; position: number };
    if (!body.actionDate || typeof body.position !== 'number') {
      return jsonResponse({ error: 'actionDate and position are required' }, 400);
    }
    await upsertDayOrder(env.DB, id, body.actionDate, body.position);
    // Auto-rebalance if position gap is too small
    if (body.position !== Math.round(body.position)) {
      const { results } = await env.DB.prepare(
        `SELECT position FROM day_order WHERE action_date = ? ORDER BY position ASC`,
      ).bind(body.actionDate).all();
      const positions = results.map((r) => (r as Record<string, unknown>).position as number);
      let needsRebalance = false;
      for (let i = 1; i < positions.length; i++) {
        if (positions[i] - positions[i - 1] < 0.001) {
          needsRebalance = true;
          break;
        }
      }
      if (needsRebalance) {
        await rebalanceDayOrder(env.DB, body.actionDate);
      }
    }
    return jsonResponse({ success: true });
  }

  // Delete day order: DELETE /tasks/:id/day-order
  if (dayOrderMatch && request.method === 'DELETE') {
    const id = parseInt(dayOrderMatch[1], 10);
    await deleteDayOrder(env.DB, id);
    return jsonResponse({ success: true });
  }

  // Revise task: PATCH /tasks/:id
  const taskPatchMatch = pathname.match(/^\/tasks\/(\d+)$/);
  if (taskPatchMatch && request.method === 'PATCH') {
    const id = parseInt(taskPatchMatch[1], 10);
    try {
      const payload = (await request.json()) as {
        body?: string;
        status?: MemoryStatusValue | null;
        priority?: PriorityLevel | null;
        actionDate?: string | null;
        dueDate?: string | null;
        recurrence?: string | null;
        topic?: string;
        projectId?: number | null;
      };
      // When actionDate changes, clean up the old day_order entry
      if (payload.actionDate !== undefined) {
        const current = await getMemory(env.DB, id);
        if (current?.actionDate && current.actionDate !== payload.actionDate) {
          await deleteDayOrder(env.DB, id, current.actionDate);
        }
      }
      const result = await memory.revise({
        id,
        ...(payload.body !== undefined && { body: payload.body }),
        ...(payload.status !== undefined && { status: payload.status }),
        ...(payload.priority !== undefined && { priority: payload.priority }),
        ...(payload.actionDate !== undefined && { actionDate: payload.actionDate }),
        ...(payload.dueDate !== undefined && { dueDate: payload.dueDate }),
        ...(payload.recurrence !== undefined && { recurrence: payload.recurrence }),
        ...(payload.topic !== undefined && { topic: payload.topic }),
        ...(payload.projectId !== undefined && { projectId: payload.projectId }),
      });
      return jsonResponse({ success: true, ...result });
    } catch (err) {
      console.error(`[auth-handler] PATCH /tasks/${id} failed:`, err);
      return jsonResponse({ success: false, error: String(err), stack: (err as Error).stack }, 500);
    }
  }

  // Delete task: DELETE /tasks/:id
  if (taskPatchMatch && request.method === 'DELETE') {
    const id = parseInt(taskPatchMatch[1], 10);
    await memory.forget(id, 'Deleted via Tasks GUI');
    return jsonResponse({ success: true });
  }

  return null;
}

// ── Project routes ──────────────────────────────────────────────────────────

async function handleProjectRoutes(
  request: Request,
  pathname: string,
  memory: D1MemoryService,
): Promise<Response | null> {
  // List projects: GET /projects
  if (pathname === '/projects' && request.method === 'GET') {
    const url = new URL(request.url);
    const includeArchived = url.searchParams.get('includeArchived') === 'true';
    const projects = await memory.getProjectsWithCounts(includeArchived);
    return jsonResponse({ projects });
  }

  // Create project: POST /projects
  if (pathname === '/projects' && request.method === 'POST') {
    const body = (await request.json()) as { name: string; color?: string };
    if (!body.name?.trim()) {
      return jsonResponse({ error: 'Project name is required' }, 400);
    }
    try {
      const id = await memory.createProject(body.name.trim(), body.color ?? 'blue');
      return jsonResponse({ success: true, id });
    } catch (err) {
      const msg = String(err);
      if (msg.includes('UNIQUE constraint')) {
        return jsonResponse({ error: `Project "${body.name}" already exists` }, 409);
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
      return jsonResponse({ error: 'targetId is required' }, 400);
    }
    const reassigned = await memory.mergeProjects(sourceId, body.targetId);
    return jsonResponse({ success: true, reassigned });
  }

  // Archive project: POST /projects/:id/archive
  const projectArchiveMatch = pathname.match(/^\/projects\/(\d+)\/archive$/);
  if (projectArchiveMatch && request.method === 'POST') {
    const id = parseInt(projectArchiveMatch[1], 10);
    await memory.archiveProject(id);
    return jsonResponse({ success: true });
  }

  // Unarchive project: POST /projects/:id/unarchive
  const projectUnarchiveMatch = pathname.match(/^\/projects\/(\d+)\/unarchive$/);
  if (projectUnarchiveMatch && request.method === 'POST') {
    const id = parseInt(projectUnarchiveMatch[1], 10);
    await memory.unarchiveProject(id);
    return jsonResponse({ success: true });
  }

  // Update project: PATCH /projects/:id
  const projectMatch = pathname.match(/^\/projects\/(\d+)$/);
  if (projectMatch && request.method === 'PATCH') {
    const id = parseInt(projectMatch[1], 10);
    const body = (await request.json()) as { name?: string; color?: string };
    await memory.updateProject(id, body);
    return jsonResponse({ success: true });
  }

  // Delete project: DELETE /projects/:id
  if (projectMatch && request.method === 'DELETE') {
    const id = parseInt(projectMatch[1], 10);
    await memory.deleteProject(id);
    return jsonResponse({ success: true });
  }

  return null;
}

// ── Reindex route ───────────────────────────────────────────────────────────

async function handleReindexRoute(
  request: Request,
  url: URL,
  pathname: string,
  env: Env,
): Promise<Response | null> {
  if (pathname !== '/reindex' || request.method !== 'POST') return null;

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

  return jsonResponse({ status: 'ok', bm25: bm25Count, vectors: vectorCount });
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
