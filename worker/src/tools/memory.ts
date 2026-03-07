/**
 * Memory tool registrations for the Worker MCP server.
 *
 * Adapted from src/backend/mcp/tools-memory.ts:
 *   - No PuidManager (no file/directory puids in memory-only Worker)
 *   - No McpServerDeps / deps.notifyActivity (no GUI)
 *   - No silo cross-search sidebar in recall (no silo access)
 *   - D1MemoryService passed directly instead of deps.memory
 *   - Inline resolveMemoryId helper instead of PuidManager static
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { parseFlexibleDate, parseRecurrence, parseDateRange } from '../date-parser';
import { type D1MemoryService, levenshtein as levenshteinDistance } from '../d1-memory-service';
import type { PriorityLevel, MemoryStatusValue } from '../shared/types';
import { truncateMemoryBody, memoryBodyWarning, priorityLabel, statusLabel, resolveMemoryId, buildDateContext, buildDatetime } from './formatting';

// ── Shared project-name resolution helper ────────────────────────────────────

/**
 * Resolve a project name via fuzzy match, returning either the project ID or
 * a formatted MCP error response with suggestions.
 */
async function resolveProjectOrError(
  memory: D1MemoryService,
  name: string,
): Promise<{ id: number } | { error: ReturnType<typeof textResult> }> {
  const resolved = await memory.resolveProjectName(name);
  if (resolved.status === 'found') return { id: resolved.id };

  const suggestions = resolved.suggestions
    .filter(s => s.distance <= Math.max(3, Math.ceil(name.length * 0.4)))
    .map(s => `  - "${s.name}" (distance: ${s.distance})`)
    .join('\n');
  const hint = suggestions
    ? `Did you mean one of these?\n${suggestions}\n\nUse lodestone_project with action "create" to create a new project, or retry with the correct name.`
    : 'No similar projects found. Use lodestone_project with action "create" to create one first.';
  return { error: textResult(`Project "${name}" not found.\n\n${hint}`) };
}

/**
 * Resolve an archived project name via fuzzy match, returning either the project ID or
 * a formatted MCP error response with suggestions.
 */
async function resolveArchivedProjectOrError(
  memory: D1MemoryService,
  name: string,
): Promise<{ id: number } | { error: ReturnType<typeof textResult> }> {
  const resolved = await memory.resolveArchivedProjectName(name);
  if (resolved.status === 'found') return { id: resolved.id };

  const suggestions = resolved.suggestions
    .filter(s => s.distance <= Math.max(3, Math.ceil(name.length * 0.4)))
    .map(s => `  - "${s.name}" (distance: ${s.distance})`)
    .join('\n');
  const hint = suggestions
    ? `Did you mean one of these?\n${suggestions}`
    : 'No archived projects found.';
  return { error: textResult(`Archived project "${name}" not found.\n\n${hint}`) };
}

/** Convenience wrapper to build a text MCP result. */
function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/** Today's date as YYYY-MM-DD for overdue/past-due checks. */
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** True when an action_date is overdue (before today, task not done/cancelled). */
function isActionOverdue(r: { actionDate: string | null; status: MemoryStatusValue | null; completedOn: string | null }): boolean {
  if (!r.actionDate) return false;
  if (r.status === 'completed' || r.completedOn || r.status === 'cancelled') return false;
  return r.actionDate < todayStr();
}

/** True when a due_date is past due (before today, task not done/cancelled). */
function isDuePastDue(r: { dueDate: string | null; status: MemoryStatusValue | null; completedOn: string | null }): boolean {
  if (!r.dueDate) return false;
  if (r.status === 'completed' || r.completedOn || r.status === 'cancelled') return false;
  return r.dueDate < todayStr();
}

// ── Guide content (lodestone-memory server) ─────────────────────────────────

const STARTUP_GUIDE = `# lodestone-memory — Startup Guide

This is the memory server. Use it to store, search, and manage persistent memories, tasks, and reminders.

Before producing any response, use \`lodestone_recall\` with a natural language query to check whether relevant memories already exist. This memory-first practice avoids redundant questions and builds on prior context. When storing something that is not actionable (like a fact or preference), pass \`status: null\`. Memories default to open status.

## Key Tools

- **\`lodestone_recall\`** — hybrid search over memories (semantic + keyword). Use before asking the user a question.
- **\`lodestone_read\`** — read a memory's full body by m-id when the preview is truncated.
- **\`lodestone_remember\`** — store a new memory (dedup-checked) or force-create with \`force: true\`.
- **\`lodestone_revise\`** — update an existing memory by id. Use \`status: "completed"\` to complete tasks.
- **\`lodestone_forget\`** — soft-delete a memory that is wrong or superseded.
- **\`lodestone_agenda\`** — view overdue + upcoming tasks for a time window.
- **\`lodestone_skip\`** — advance a recurring task without recording a completion.
- **\`lodestone_project\`** — manage projects (list, create, rename, recolor, merge, delete).
- **\`lodestone_get_datetime\`** — get current date and time for timestamps.

Cross-reference memories by embedding "see m42" or "related: m7, m15" in the body. Memory IDs are stable primary keys.

## Detailed Guides

Two further guides are available via \`lodestone_guide\`. Fetch the relevant one before undertaking that type of work.

- **memory** — how to store, revise, and cross-reference memories; reminders.
- **tasks** — creating tasks, completing, recurring tasks, overdue handling.`;

const MEMORY_GUIDE = `# Lodestone Memory Guide

## Storing and Revising Memories

Before storing a new memory, use \`lodestone_recall\` to check whether a related memory already exists; update it with \`lodestone_revise\` rather than creating a duplicate. Periodically as you work on tasks or have chats, call \`lodestone_remember\` to record useful facts, decisions, or context. Keep memory bodies factual and self-contained; they will be read in a future session without the current conversation as context. Use \`lodestone_forget\` to remove anything confirmed wrong or outdated. Because lodestone search is semantic by default, conceptual phrases and natural language work as well as keywords.

## Cross-Referencing

Cross-referencing by m-id is a first-class pattern: embed "see m42" or "related: m7, m15" directly in the body to build a navigable knowledge graph. \`lodestone_read\` on a single m-id returns the full body plus the top-5 related memories by cosine similarity, so cross-references surface automatically during exploration. Memory IDs are stable primary keys and safe to reference.

## Projects

Memories and tasks can optionally belong to a project. Use \`lodestone_project\` (action: "list") to see available projects. When storing or revising a memory, pass the \`project\` parameter with the exact project name. If the name doesn't match, the server returns fuzzy suggestions. Create projects first with \`lodestone_project\` (action: "create") before assigning memories to them.

## Reminders

Reminders are memories with an \`action_date\` and optional \`recurrence\`. They appear in \`lodestone_agenda\` output. Check the agenda at the start of a session for any critical or high-priority items due today.`;

const TASKS_GUIDE = `# Lodestone Tasks & Agenda Guide

## Creating Tasks

Tasks are memories with a \`status\`. Every task must have an \`action_date\` — if omitted, it defaults to today. Create with \`lodestone_remember\`:
- \`action_date\` — when the task is actionable (flexible: "tomorrow", "next Monday", "2026-03-15"). Defaults to today.
- \`due_date\` — hard deadline (optional). A warning is emitted if action_date > due_date.
- \`priority\` — 1=low, 2=medium, 3=high, 4=critical
- \`status\` — "open" (default on creation)
- \`recurrence\` — for repeating tasks: "daily", "weekly", "every monday", "every 3 days", etc.

Use a short descriptive \`topic\` (e.g. "TASK - Send invoice"). Check \`lodestone_recall\` first to avoid duplicating an existing task.

## Viewing the Agenda

Call \`lodestone_agenda\` at the start of a work session or when the user asks what needs doing. It surfaces overdue items first, then upcoming items sorted by priority then date. The \`when\` parameter accepts: "today", "tomorrow", "this week" (default), "next week", "this month", "overdue".

## Completing Tasks

**Non-recurring**: \`lodestone_revise\` with \`status: "completed"\`. Auto-fills \`completed_on\` with today.

**Recurring**: same call — \`lodestone_revise\` with \`status: "completed"\`. This automatically:
1. Creates an immutable completion record referencing the task by m-id.
2. Resets the task to status="open" with \`action_date\` advanced to the next occurrence.

No further action needed after a single revise call.

## Skipping a Recurring Task

Use \`lodestone_skip\` when an occurrence should be skipped without recording a completion (e.g. holiday, postponed). The \`action_date\` advances to the next occurrence. Pass a \`reason\` to append an audit note to the memory body.

## Assigning Tasks to Projects

Tasks can belong to a project. When creating with \`lodestone_remember\`, pass \`project: "project name"\`. When updating with \`lodestone_revise\`, pass \`project: "name"\` to assign or \`project: null\` to unassign. The project name must match an existing project — if it doesn't, close matches are suggested. Use \`lodestone_project\` (action: "list") to see projects, and (action: "create") to make new ones.

## Handling Overdue Items

When reviewing overdue tasks with the user, ask what to do with each one:
- Done: \`lodestone_revise(status: "completed")\`
- No longer relevant this cycle: \`lodestone_skip\`
- Cancelled permanently: \`lodestone_revise(status: "cancelled")\`
- Needs rescheduling: \`lodestone_revise(action_date: "new date")\``;

const GUIDES = { startup: STARTUP_GUIDE, memory: MEMORY_GUIDE, tasks: TASKS_GUIDE } as const;

// ── Tool Registrations ──────────────────────────────────────────────────────

export function registerRememberTool(server: McpServer, memory: D1MemoryService): void {
  server.tool(
    'lodestone_remember',
    [
      'Write a new memory or update an existing similar one.',
      '',
      'Before inserting, checks cosine similarity against existing memories.',
      'If a closely related entry is found, its details are returned so you can',
      'decide whether to update it (via lodestone_revise) or force-create a new one.',
      '',
      'Keep memories atomic \u2014 each should capture a single concept or decision.',
      'If a memory grows beyond ~200 tokens, consider splitting it into multiple',
      'memories that reference each other by m-id (e.g. "see m12 for the schema',
      'details"). Memory IDs are stable primary keys and safe to reference.',
      '',
      'Cross-referencing by m-id is a first-class pattern: embed "see m42" or',
      '"related: m7, m15" directly in the body to build a navigable knowledge graph.',
      'lodestone_read m-id returns the full body plus the top-5 related memories by',
      'cosine similarity, so cross-references surface automatically during exploration.',
      '',
      'Parameters:',
      '  topic        \u2014 Short label categorising the memory (e.g. "JAMES - THINKING STYLE")',
      '  body         \u2014 The memory content (plain text)',
      '  confidence   \u2014 Float 0\u20131. 1.0 = reliable, lower = tentative. Default: 1.0',
      '  context_hint \u2014 Optional short string recording the conversational context',
      '  force        \u2014 Skip dedup check and always create a new memory. Default: false',
      '  action_date  \u2014 Date for when this memory is actionable. Accepts flexible',
      '                  expressions ("tomorrow", "next Monday", "2026-03-15"). Stored as',
      '                  ISO 8601 (YYYY-MM-DD). Required for tasks (memories with status);',
      '                  defaults to today if omitted when status is set.',
      '  due_date     \u2014 Optional hard deadline. Accepts flexible expressions.',
      '                  Stored as ISO 8601 (YYYY-MM-DD). A warning is emitted',
      '                  if action_date falls after due_date.',
      '  recurrence   \u2014 Optional recurrence rule for repeating action dates. Accepted formats:',
      '                  "daily", "weekly", "biweekly", "monthly", "yearly",',
      '                  "every monday", "every weekday", "every 3 days", "every 2 weeks".',
      '                  Requires action_date to be set. The action_date auto-advances on orient.',
      '  priority     \u2014 Optional urgency level: 1=low, 2=medium, 3=high, 4=critical.',
      '  status       \u2014 Optional lifecycle status: "open", "completed", "cancelled", or null.',
      '                  Omitting defaults to "open". Pass null for no lifecycle status (not a task).',
      '                  Setting completed_on implies completed. Setting status="completed"',
      '                  auto-fills completed_on with today if not provided.',
      '                  Setting status="open" clears completed_on.',
      '  completed_on \u2014 Optional date the memory was completed. Implies status="completed".',
      '                  Accepts flexible expressions ("today", "yesterday", "2026-03-15").',
      '  project      \u2014 Optional project name to assign to. Must match an existing project',
      '                  (fuzzy matched). If not found, close matches are suggested. Use',
      '                  lodestone_project with action "create" to create new projects first.',
      '',
      'Returns: { id } on success, or details of a similar existing memory for review.',
    ].join('\n'),
    {
      topic: z.string().describe('Short label categorising the memory (e.g. "LODESTONE", "JAMES - THINKING STYLE")'),
      body: z.string().describe('The memory content'),
      confidence: z.number().min(0).max(1).optional().describe('Epistemic confidence 0\u20131. Default: 1.0'),
      context_hint: z.string().optional().describe('Short string recording the conversational context (not searchable)'),
      force: z.boolean().optional().describe('Skip dedup check and always create a new memory. Default: false'),
      action_date: z.string().optional().describe('Date when this memory is actionable. Flexible expressions accepted ("tomorrow", "next Monday", "2026-03-15"). Stored as ISO 8601.'),
      due_date: z.string().optional().describe('Hard deadline date. Flexible expressions accepted ("tomorrow", "next Friday", "2026-03-15"). Stored as ISO 8601.'),
      recurrence: z.string().optional().describe('Recurrence rule: "daily", "weekly", "biweekly", "monthly", "yearly", "every monday", "every weekday", "every N days", "every N weeks". Requires action_date.'),
      priority: z.number().int().min(1).max(4).optional().describe('Urgency: 1=low, 2=medium, 3=high, 4=critical'),
      status: z.union([z.enum(['open', 'in_progress', 'completed', 'blocked', 'cancelled']), z.null()]).optional().describe('Lifecycle status. Omit to default to "open". Pass null for no lifecycle status. "completed" auto-fills completed_on=today. "open" clears completed_on.'),
      completed_on: z.string().optional().describe('Date completed. Flexible expressions accepted. Implies status="completed".'),
      project: z.string().optional().describe('Project name to assign to. Must match an existing project (fuzzy matched). If not found, suggestions are returned. Use lodestone_project to create/list projects. Omit to leave unassigned.'),
    },
    async ({ topic, body, confidence, context_hint, force, action_date, due_date, recurrence, priority, status, completed_on, project }) => {
      try {
        // Parse flexible action_date to ISO 8601
        let parsedActionDate: string | null = null;
        if (action_date) {
          parsedActionDate = parseFlexibleDate(action_date);
          if (!parsedActionDate) {
            return { content: [{ type: 'text' as const, text: `Error: Could not parse action_date "${action_date}". Use ISO 8601 (YYYY-MM-DD), relative expressions (tomorrow, next Monday), or natural dates (March 15).` }] };
          }
        }

        // Parse flexible due_date to ISO 8601
        let parsedDueDate: string | null = null;
        if (due_date) {
          parsedDueDate = parseFlexibleDate(due_date);
          if (!parsedDueDate) {
            return { content: [{ type: 'text' as const, text: `Error: Could not parse due_date "${due_date}". Use ISO 8601 (YYYY-MM-DD), relative expressions (tomorrow, next Monday), or natural dates (March 15).` }] };
          }
        }

        // Parse and validate recurrence rule
        let parsedRecurrence: string | null = null;
        if (recurrence) {
          parsedRecurrence = parseRecurrence(recurrence);
          if (!parsedRecurrence) {
            return { content: [{ type: 'text' as const, text: `Error: Could not parse recurrence "${recurrence}". Accepted: daily, weekly, biweekly, monthly, yearly, every monday, every weekday, every N days, every N weeks.` }] };
          }
          if (!parsedActionDate) {
            return { content: [{ type: 'text' as const, text: `Error: recurrence requires action_date to be set. Provide an action_date for the first occurrence.` }] };
          }
        }

        // Parse flexible completed_on to ISO 8601
        let parsedCompletedOn: string | null = null;
        if (completed_on) {
          parsedCompletedOn = parseFlexibleDate(completed_on);
          if (!parsedCompletedOn) {
            return { content: [{ type: 'text' as const, text: `Error: Could not parse completed_on "${completed_on}". Use ISO 8601 (YYYY-MM-DD) or relative expressions (today, yesterday).` }] };
          }
        }

        // Resolve project name to ID (fuzzy match)
        let projectId: number | null = null;
        if (project) {
          const resolved = await resolveProjectOrError(memory, project);
          if ('error' in resolved) return resolved.error;
          projectId = resolved.id;
        }

        const result = await memory.remember({
          topic,
          body,
          confidence,
          contextHint: context_hint,
          force,
          actionDate: parsedActionDate,
          dueDate: parsedDueDate,
          recurrence: parsedRecurrence,
          priority: (priority ?? null) as PriorityLevel | null,
          status: (status === undefined || (status === null && parsedActionDate) ? 'open' : status ?? null) as MemoryStatusValue | null,
          completedOn: parsedCompletedOn,
          projectId,
        });

        if (result.status === 'duplicate') {
          const sim = Math.round(result.similarity * 100);
          const preview = truncateMemoryBody(result.existing.body);
          const meta: string[] = [];
          if (result.existing.actionDate) {
            let actionStr = `Action: ${result.existing.actionDate}`;
            if (result.existing.recurrence) actionStr += ` (${result.existing.recurrence})`;
            if (isActionOverdue(result.existing)) actionStr += ' \u26a0\ufe0f OVERDUE';
            meta.push(actionStr);
          }
          if (result.existing.dueDate) {
            meta.push(`Due: ${result.existing.dueDate}${isDuePastDue(result.existing) ? ' \ud83d\udea8 PAST DUE' : ''}`);
          }
          if (result.existing.priority) meta.push(`Priority: ${priorityLabel(result.existing.priority)}`);
          if (result.existing.status) meta.push(`Status: ${statusLabel(result.existing.status)}`);
          if (result.existing.completedOn) meta.push(`Completed: ${result.existing.completedOn}`);
          const lines = [
            `Similar memory found (${sim}% similarity):`,
            '',
            `## [m${result.existing.id}] ${result.existing.topic} (confidence: ${result.existing.confidence})`,
            preview,
            ...(meta.length > 0 ? [`_${meta.join(' | ')}_`] : []),
            '',
            'Consider:',
            `- Use lodestone_revise(id: "m${result.existing.id}", body: "...") to update the existing memory.`,
            '- Use lodestone_remember with force: true to create a new memory despite the similarity.',
          ];
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }

        const warning = memoryBodyWarning(body);
        const extras: string[] = [];
        if (parsedActionDate) {
          let actionStr = `Action date: ${parsedActionDate}`;
          if (parsedRecurrence) actionStr += ` (${parsedRecurrence})`;
          extras.push(actionStr + '.');
        }
        if (parsedDueDate) extras.push(`Due: ${parsedDueDate}.`);
        if (priority) extras.push(`Priority: ${priorityLabel(priority as PriorityLevel)}.`);
        if (status) extras.push(`Status: ${statusLabel(status as MemoryStatusValue)}.`);
        if (parsedCompletedOn) extras.push(`Completed: ${parsedCompletedOn}.`);
        const dateWarning = result.warning ? `\n\n${result.warning}` : '';
        return {
          content: [{ type: 'text' as const, text: `Created memory m${result.id}.${extras.length ? ' ' + extras.join(' ') : ''}${warning}${dateWarning}` }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }] };
      }
    },
  );
}

export function registerRecallTool(server: McpServer, memory: D1MemoryService): void {
  server.tool(
    'lodestone_recall',
    [
      'Hybrid search over memories: BM25 (FTS5) + cosine similarity, fused by weighted-max.',
      '',
      'Returns ranked memory records with m-prefixed id, topic, truncated body preview, confidence, and score.',
      'Use this when you have a specific question or topic to retrieve context for.',
      'Results show truncated previews. Use lodestone_read with the m-prefixed ID (e.g. "m3") to read the full body.',
      '',
      'Query with natural language \u2014 use concepts, short sentences, or brief descriptions',
      'of what you are looking for (e.g. "how does the search pipeline compose scores"',
      'not "decaying-sum"). Think about meaning, not keywords.',
      '',
      'Parameters:',
      '  query          \u2014 Natural language search query',
      '  max_results    \u2014 Maximum memories to return. Default: 5',
      '  mode           \u2014 Search mode: hybrid (default, vector + BM25), bm25 (keyword-only), semantic (vector-only)',
      '  updated_after  \u2014 Filter to memories with updated_at >= this date',
      '  updated_before \u2014 Filter to memories with updated_at <= this date',
      '  action_after     \u2014 Filter to memories with action_date >= this date',
      '  action_before    \u2014 Filter to memories with action_date <= this date',
      '  completed_after  \u2014 Filter to memories completed on or after this date',
      '  completed_before \u2014 Filter to memories completed on or before this date',
      '  due_after        \u2014 Filter to memories with due_date >= this date',
      '  due_before       \u2014 Filter to memories with due_date <= this date',
      '  status           \u2014 Filter by status: "open", "completed", "cancelled"',
      '',
      'All date filters accept flexible expressions ("today", "yesterday", "last Monday",',
      '"next Friday", "2026-03-15") which are normalised to ISO 8601 before querying.',
      'Combine freely: updated_after + action_before for memories updated recently with upcoming deadlines.',
    ].join('\n'),
    {
      query: z.string().describe('Search query \u2014 natural language, use concepts and short sentences not keywords'),
      max_results: z.number().min(1).max(50).optional().describe('Maximum results to return. Default: 5'),
      mode: z.enum(['hybrid', 'bm25', 'semantic']).optional()
        .describe('Search mode: hybrid (default, vector + BM25), bm25 (keyword-only), semantic (vector-only)'),
      updated_after: z.string().optional().describe('Filter: updated_at >= this date. Flexible expressions accepted.'),
      updated_before: z.string().optional().describe('Filter: updated_at <= this date. Flexible expressions accepted.'),
      action_after: z.string().optional().describe('Filter: action_date >= this date. Flexible expressions accepted.'),
      action_before: z.string().optional().describe('Filter: action_date <= this date. Flexible expressions accepted.'),
      completed_after: z.string().optional().describe('Filter: completed_on >= this date. Flexible expressions accepted.'),
      completed_before: z.string().optional().describe('Filter: completed_on <= this date. Flexible expressions accepted.'),
      due_after: z.string().optional().describe('Filter: due_date >= this date. Flexible expressions accepted.'),
      due_before: z.string().optional().describe('Filter: due_date <= this date. Flexible expressions accepted.'),
      status: z.enum(['open', 'in_progress', 'completed', 'blocked', 'cancelled']).optional().describe('Filter by status.'),
      include_archived: z.boolean().optional().describe('Include memories belonging to archived projects. Default: false'),
    },
    async ({ query, max_results, mode, updated_after, updated_before, action_after, action_before, completed_after, completed_before, due_after, due_before, status, include_archived }) => {
      try {
        // Parse flexible date expressions to ISO 8601
        const dateFilters: Record<string, string> = {};
        for (const [key, raw] of Object.entries({
          updatedAfter: updated_after,
          updatedBefore: updated_before,
          actionAfter: action_after,
          actionBefore: action_before,
          completedAfter: completed_after,
          completedBefore: completed_before,
          dueAfter: due_after,
          dueBefore: due_before,
        })) {
          if (!raw) continue;
          const parsed = parseFlexibleDate(raw);
          if (!parsed) {
            return { content: [{ type: 'text' as const, text: `Error: Could not parse date filter "${raw}". Use ISO 8601 (YYYY-MM-DD), relative expressions (tomorrow, next Monday), or natural dates (March 15).` }] };
          }
          dateFilters[key] = parsed;
        }

        const results = await memory.recall({
          query,
          maxResults: max_results,
          mode,
          dateFilters: Object.keys(dateFilters).length > 0 || status !== undefined || include_archived
            ? { ...dateFilters, ...(status !== undefined ? { status } : {}), ...(include_archived ? { includeArchived: true } : {}) }
            : undefined,
        });

        const lines: string[] = [];
        if (results.length === 0) {
          lines.push('No memories found.');
        } else {
          for (const r of results) {
            const pct = Math.round(r.score * 100);
            const signalEntries = Object.entries(r.signals);
            let scoreStr: string;
            if (signalEntries.length <= 1) {
              scoreStr = `${pct}% ${r.scoreLabel}`;
            } else {
              const breakdown = signalEntries
                .sort(([, a], [, b]) => b - a)
                .map(([name, val]) => `${name} ${Math.round(val * 100)}%`)
                .join(', ');
              scoreStr = `${pct}% ${r.scoreLabel}: ${breakdown}`;
            }
            lines.push(`## [m${r.id}] ${r.topic} (${scoreStr}, confidence: ${r.confidence})`);
            lines.push(truncateMemoryBody(r.body));
            const meta = [`Updated: ${r.updatedAt}`];
            if (r.actionDate) {
              let actionStr = `Action: ${r.actionDate}`;
              if (r.recurrence) actionStr += ` (${r.recurrence})`;
              if (isActionOverdue(r)) actionStr += ' \u26a0\ufe0f OVERDUE';
              meta.push(actionStr);
            }
            if (r.dueDate) {
              meta.push(`Due: ${r.dueDate}${isDuePastDue(r) ? ' \ud83d\udea8 PAST DUE' : ''}`);
            }
            if (r.priority) meta.push(`Priority: ${priorityLabel(r.priority)}`);
            if (r.status) meta.push(`Status: ${statusLabel(r.status)}`);
            if (r.completedOn) meta.push(`Completed: ${r.completedOn}`);
            lines.push(`_${meta.join(' | ')}_`);
            lines.push('');
          }
        }

        // No silo cross-search sidebar — Worker has no silo access

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }] };
      }
    },
  );
}

export function registerReviseTool(server: McpServer, memory: D1MemoryService): void {
  server.tool(
    'lodestone_revise',
    [
      'Explicitly update a specific memory by id.',
      '',
      'Use this when you have recalled a memory and want to correct or extend it with',
      'precision, bypassing the similarity-based upsert of lodestone_remember.',
      'Also use it to adjust confidence on an existing memory without rewriting the body.',
      '',
      'Auto-advance on complete: when status="completed" is set on a memory that has a',
      'recurrence rule, the server automatically (1) creates an immutable completion record',
      'referencing this memory by m-id, and (2) resets the recurring task to status="open"',
      'with action_date advanced to the next occurrence. The LLM does not need to take any',
      'further action \u2014 a single revise call handles everything. Use lodestone_skip instead',
      'if the occurrence should be skipped without recording a completion.',
      '',
      'Parameters:',
      '  id           \u2014 Memory id (from lodestone_recall)',
      '  body         \u2014 New body text (optional)',
      '  confidence   \u2014 New confidence value 0\u20131 (optional)',
      '  context_hint \u2014 New context hint (optional, pass null to clear)',
      '  action_date  \u2014 New action date (optional, pass null to clear). Flexible expressions accepted.',
      '                  Cannot be cleared on tasks with an active status (open, in_progress, blocked).',
      '  due_date     \u2014 New due date (optional, pass null to clear). Flexible expressions accepted.',
      '  recurrence   \u2014 New recurrence rule (optional, pass null to clear).',
      '                  Accepted: daily, weekly, biweekly, monthly, yearly,',
      '                  every monday, every weekday, every N days, every N weeks.',
      '  priority     \u2014 New priority (optional, pass null to clear). 1=low, 2=medium, 3=high, 4=critical.',
      '  topic        \u2014 New topic label (optional).',
      '  status       \u2014 New status (optional, pass null to clear): "open", "completed", "cancelled".',
      '                  "completed" auto-fills completed_on=today. "open" clears completed_on.',
      '  completed_on \u2014 New completion date (optional, pass null to clear). Flexible expressions accepted.',
      '  project      \u2014 Project name to assign to (null to clear). Must match an existing project',
      '                  (fuzzy matched). Use lodestone_project to create/list projects.',
    ].join('\n'),
    {
      id: z.union([z.number().int(), z.string()]).describe('Memory id to update (number or m-prefixed id like "m5")'),
      body: z.string().optional().describe('New body text'),
      confidence: z.number().min(0).max(1).optional().describe('New confidence value 0\u20131'),
      context_hint: z.union([z.string(), z.null()]).optional().describe('New context hint (null to clear)'),
      action_date: z.union([z.string(), z.null()]).optional().describe('New action date (null to clear). Flexible expressions accepted.'),
      due_date: z.union([z.string(), z.null()]).optional().describe('New due date (null to clear). Flexible expressions accepted.'),
      recurrence: z.union([z.string(), z.null()]).optional().describe('New recurrence rule (null to clear). Accepted: daily, weekly, biweekly, monthly, yearly, every monday, every weekday, every N days, every N weeks.'),
      priority: z.union([z.number().int().min(1).max(4), z.null()]).optional().describe('New priority (null to clear). 1=low, 2=medium, 3=high, 4=critical.'),
      topic: z.string().optional().describe('New topic label'),
      status: z.union([z.enum(['open', 'in_progress', 'completed', 'blocked', 'cancelled']), z.null()]).optional().describe('New status (null to clear). "completed" auto-fills completed_on. "open" clears completed_on.'),
      completed_on: z.union([z.string(), z.null()]).optional().describe('New completion date (null to clear). Flexible expressions accepted.'),
      project: z.union([z.string(), z.null()]).optional().describe('Project name (null to clear assignment). Must match an existing project (fuzzy matched). Use lodestone_project to create/list projects.'),
    },
    async ({ id: rawId, body, confidence, context_hint, action_date, due_date, recurrence, priority, topic, status, completed_on, project }) => {
      try {
        const id = resolveMemoryId(rawId);

        // Parse flexible action_date (null clears it)
        let parsedActionDate: string | null | undefined;
        if (action_date === null) {
          parsedActionDate = null;
        } else if (action_date !== undefined) {
          parsedActionDate = parseFlexibleDate(action_date);
          if (!parsedActionDate) {
            return { content: [{ type: 'text' as const, text: `Error: Could not parse action_date "${action_date}". Use ISO 8601 (YYYY-MM-DD), relative expressions (tomorrow, next Monday), or natural dates (March 15).` }] };
          }
        }

        // Parse flexible due_date (null clears it)
        let parsedDueDate: string | null | undefined;
        if (due_date === null) {
          parsedDueDate = null;
        } else if (due_date !== undefined) {
          parsedDueDate = parseFlexibleDate(due_date);
          if (!parsedDueDate) {
            return { content: [{ type: 'text' as const, text: `Error: Could not parse due_date "${due_date}". Use ISO 8601 (YYYY-MM-DD), relative expressions (tomorrow, next Monday), or natural dates (March 15).` }] };
          }
        }

        // Parse recurrence rule (null clears it)
        let parsedRecurrence: string | null | undefined;
        if (recurrence === null) {
          parsedRecurrence = null;
        } else if (recurrence !== undefined) {
          parsedRecurrence = parseRecurrence(recurrence);
          if (!parsedRecurrence) {
            return { content: [{ type: 'text' as const, text: `Error: Could not parse recurrence "${recurrence}". Accepted: daily, weekly, biweekly, monthly, yearly, every monday, every weekday, every N days, every N weeks.` }] };
          }
        }

        // Parse flexible completed_on (null clears it)
        let parsedCompletedOn: string | null | undefined;
        if (completed_on === null) {
          parsedCompletedOn = null;
        } else if (completed_on !== undefined) {
          parsedCompletedOn = parseFlexibleDate(completed_on);
          if (!parsedCompletedOn) {
            return { content: [{ type: 'text' as const, text: `Error: Could not parse completed_on "${completed_on}". Use ISO 8601 (YYYY-MM-DD) or relative expressions (today, yesterday).` }] };
          }
        }

        // Resolve project name to ID (null clears it, string resolves with fuzzy match)
        let projectId: number | null | undefined;
        if (project === null) {
          projectId = null;
        } else if (project !== undefined) {
          const resolved = await resolveProjectOrError(memory, project);
          if ('error' in resolved) return resolved.error;
          projectId = resolved.id;
        }

        const reviseResult = await memory.revise({
          id,
          body,
          confidence,
          contextHint: context_hint,
          actionDate: parsedActionDate,
          dueDate: parsedDueDate,
          recurrence: parsedRecurrence,
          priority: priority as PriorityLevel | undefined,
          topic,
          status: status as MemoryStatusValue | null | undefined,
          completedOn: parsedCompletedOn,
          projectId,
        });
        const warning = body ? memoryBodyWarning(body) : '';
        let msg = `Memory m${id} revised.`;
        if (reviseResult.completionRecordId !== undefined) {
          msg += ` Completion recorded as m${reviseResult.completionRecordId}. Next occurrence: ${reviseResult.nextActionDate}.`;
        }
        const dateWarning = reviseResult.warning ? `\n\n${reviseResult.warning}` : '';
        return { content: [{ type: 'text' as const, text: msg + warning + dateWarning }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }] };
      }
    },
  );
}

export function registerForgetTool(server: McpServer, memory: D1MemoryService): void {
  server.tool(
    'lodestone_forget',
    [
      'Soft-delete a specific memory by id.',
      '',
      'Use when something is definitively wrong, no longer relevant,',
      'or has been superseded by a revised memory.',
      '',
      'The memory is not permanently removed. It is marked deleted and becomes',
      'invisible to recall, agenda, and dedup checks. It can still be',
      'read via lodestone_read (using its m-id), which will show the body alongside',
      'a deletion notice. This preserves reference integrity: any memory that',
      'cross-references this one by m-id will still resolve correctly.',
      '',
      'Parameters:',
      '  id     \u2014 Memory id (from lodestone_recall)',
      '  reason \u2014 Optional brief explanation of why the memory was deleted',
      '             (e.g. "superseded by m45", "information was incorrect", "task cancelled").',
      '             Stored on the record and shown in the deletion notice.',
    ].join('\n'),
    {
      id: z.union([z.number().int(), z.string()]).describe('Memory id to delete (number or m-prefixed id like "m5")'),
      reason: z.string().optional().describe('Optional brief explanation of why this memory is being deleted.'),
    },
    async ({ id: rawId, reason }) => {
      try {
        const id = resolveMemoryId(rawId);
        await memory.forget(id, reason);
        const reasonSuffix = reason ? ` Reason: ${reason}` : '';
        return { content: [{ type: 'text' as const, text: `Memory m${id} soft-deleted.${reasonSuffix}` }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }] };
      }
    },
  );
}

export function registerSkipTool(server: McpServer, memory: D1MemoryService): void {
  server.tool(
    'lodestone_skip',
    [
      'Advance a recurring memory to its next occurrence without recording a completion.',
      '',
      'Use this when an occurrence of a recurring task is intentionally skipped \u2014',
      'the task is not done, but it should not remain overdue. Use lodestone_revise',
      'with status="completed" instead when the task was actually completed.',
      '',
      'Only valid for memories with a recurrence rule. Returns an error for non-recurring memories.',
      '',
      'Parameters:',
      '  id     \u2014 Memory id of the recurring memory to skip (number or m-prefixed, e.g. "m5")',
      '  reason \u2014 Optional brief explanation of why this occurrence was skipped.',
      '             If provided, a skip note is appended to the memory body for audit purposes.',
    ].join('\n'),
    {
      id: z.union([z.number().int(), z.string()]).describe('Memory id of the recurring memory to skip (number or m-prefixed id like "m5")'),
      reason: z.string().optional().describe('Optional explanation of why this occurrence was skipped. Appended to the memory body.'),
    },
    async ({ id: rawId, reason }) => {
      try {
        const id = resolveMemoryId(rawId);
        const result = await memory.skip(id, reason);
        const reasonSuffix = reason ? ` Reason: ${reason}.` : '';
        return { content: [{ type: 'text' as const, text: `Memory m${id} skipped. Next occurrence: ${result.nextActionDate}.${reasonSuffix}` }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }] };
      }
    },
  );
}

export function registerGuideTool(server: McpServer): void {
  server.tool(
    'lodestone_guide',
    [
      'Retrieve a detailed usage guide for the lodestone-memory toolset.',
      '',
      'Call this at the start of a conversation to understand available tools,',
      'or on demand when you need instructions for a specific capability.',
      '',
      'Topics:',
      '  startup — Overview of all memory tools and how to use them.',
      '  memory  — Memory management: storing, revising, cross-referencing, reminders.',
      '  tasks   — Task and agenda management: creating, completing, recurring, overdue handling.',
    ].join('\n'),
    {
      topic: z.enum(['startup', 'memory', 'tasks']).describe('Guide topic to retrieve.'),
    },
    async ({ topic }) => ({
      content: [{ type: 'text' as const, text: GUIDES[topic] }],
    }),
  );
}

export function registerAgendaTool(server: McpServer, memory: D1MemoryService): void {
  server.tool(
    'lodestone_agenda',
    [
      'Return an agenda view: overdue items + upcoming items for the requested time window.',
      '',
      'Always surfaces overdue memories first (action_date before today, not completed/cancelled),',
      'with a prompt to ask the user what to do about them.',
      'Then lists upcoming items within the requested window, sorted by priority then date.',
      'Completed and cancelled memories are excluded by default.',
      '',
      'Call this at the start of a work session or when the user asks what needs doing.',
      'Use lodestone_recall for conversational context; use lodestone_agenda for tasks.',
      '',
      'Parameters:',
      '  when             \u2014 Time window for upcoming items. Accepts:',
      '                       Keywords: "today", "tomorrow", "this week" (default), "next week",',
      '                                 "this month", "next month", "overdue" (only overdue items)',
      '                       Single dates: "Monday", "next Friday", "March 15", "2026-03-15"',
      '  include_completed \u2014 Include completed/cancelled items in upcoming. Default: false',
      '  max_results      \u2014 Maximum items per section (overdue + upcoming each). Default: 20',
    ].join('\n'),
    {
      when: z.string().optional().describe(
        'Time window: "today", "tomorrow", "this week" (default), "next week", "this month", "next month", "overdue", or any date expression.',
      ),
      include_completed: z.boolean().optional().describe('Include completed/cancelled items. Default: false'),
      max_results: z.number().int().min(1).max(50).optional().describe('Max items per section. Default: 20'),
    },
    async ({ when = 'this week', include_completed = false, max_results = 20 }) => {
      try {
        const range = parseDateRange(when);
        if (!range) {
          return { content: [{ type: 'text' as const, text: `Error: Could not parse "when" value "${when}". Use keywords (today, tomorrow, this week, next week, this month, next month, overdue) or a date expression.` }] };
        }

        const result = await memory.agenda({
          when: range,
          includeCompleted: include_completed,
          maxResults: max_results,
        });

        const lines: string[] = [];
        lines.push(buildDateContext());
        lines.push('');

        // Overdue section
        if (result.overdue.length > 0) {
          lines.push(`## \u26a0\ufe0f Overdue (${result.overdue.length})`);
          lines.push('');
          for (const r of result.overdue) {
            lines.push(formatAgendaItem(r));
          }
          lines.push('> These items are overdue \u2014 consider asking the user what to do with them.');
          lines.push('');
        }

        // Upcoming section
        if (!('overdue' in range)) {
          const windowLabel = when.toLowerCase();
          if (result.upcoming.length === 0) {
            lines.push(`## \ud83d\udcc5 Upcoming (${windowLabel})`);
            lines.push('');
            lines.push('No upcoming items.');
          } else {
            lines.push(`## \ud83d\udcc5 Upcoming (${windowLabel}) \u2014 ${result.upcoming.length} item${result.upcoming.length === 1 ? '' : 's'}`);
            lines.push('');
            for (const r of result.upcoming) {
              lines.push(formatAgendaItem(r));
            }
          }
        }

        if (result.overdue.length === 0 && 'overdue' in range) {
          return { content: [{ type: 'text' as const, text: `Nothing on the agenda for "${when}".` }] };
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }] };
      }
    },
  );
}

/** Format a single agenda item as a compact markdown block. */
function formatAgendaItem(r: { id: number; topic: string; body: string; actionDate: string | null; dueDate: string | null; recurrence: string | null; priority: PriorityLevel | null; status: MemoryStatusValue | null; completedOn: string | null; confidence: number }): string {
  const meta: string[] = [];
  if (r.actionDate) {
    let actionStr = `Action: ${r.actionDate}`;
    if (r.recurrence) actionStr += ` (${r.recurrence})`;
    if (isActionOverdue(r)) actionStr += ' \u26a0\ufe0f OVERDUE';
    meta.push(actionStr);
  }
  if (r.dueDate) {
    meta.push(`Due: ${r.dueDate}${isDuePastDue(r) ? ' \ud83d\udea8 PAST DUE' : ''}`);
  }
  if (r.priority) meta.push(`Priority: ${priorityLabel(r.priority)}`);
  if (r.status) meta.push(`Status: ${statusLabel(r.status)}`);
  if (r.completedOn) meta.push(`Completed: ${r.completedOn}`);
  return [
    `### [m${r.id}] ${r.topic}`,
    truncateMemoryBody(r.body),
    `_${meta.join(' | ')}_`,
    '',
  ].join('\n');
}

export function registerGetDatetimeTool(server: McpServer): void {
  server.tool(
    'lodestone_get_datetime',
    'Return the current date and time. Call this when you need to generate an accurate timestamp mid-conversation (e.g. for note frontmatter or memory entries).',
    {},
    async () => {
      return { content: [{ type: 'text' as const, text: buildDatetime() }] };
    },
  );
}

// ── Read tool (memory-only) ─────────────────────────────────────────────────

export function registerReadTool(server: McpServer, memory: D1MemoryService): void {
  server.tool(
    'lodestone_read',
    [
      'Read file contents by reference ID from a previous lodestone_search or lodestone_explore.',
      'Supports text and image files (PNG, JPG, GIF, WebP, SVG).',
      '',
      'Accepts an array of references:',
      '  \u2022 Plain string "r1" \u2014 reads the full file for result r1',
      '  \u2022 Object { id: "r1", location: { type: "lines", start: 10, end: 20 } } \u2014 reads lines 10\u201320',
      '  \u2022 Object { id: "r1", location: { type: "page", page: 3 } } \u2014 reads page 3 of a PDF',
      '',
      'The location parameter accepts the same shape as LocationHint from search results.',
      'For text files (markdown, code, plaintext), use { type: "lines", start, end }.',
      'For PDFs, use { type: "page", page }.',
      '',
      'Reference IDs (r1, r2, ...) persist across all tool calls in the session.',
      'You can also pass absolute file paths instead of reference IDs.',
      '',
      'Note: d-prefixed IDs (d1, d2, ...) are directory references from lodestone_explore.',
      'They cannot be read \u2014 use lodestone_explore with startPath to browse directories.',
      '',
      'Note: m-prefixed IDs (m1, m2, ...) are memory references from lodestone_recall.',
      'Use lodestone_read with an m-puid to retrieve the full memory body when the preview is truncated.',
      '',
      'Examples:',
      '  \u2022 ["r1", "r3"] \u2014 read two files from the last search',
      '  \u2022 [{ id: "r2", location: { type: "lines", start: 10, end: 50 } }] \u2014 read a specific line range',
      '  \u2022 [{ id: "r4", location: { type: "page", page: 5 } }] \u2014 read page 5 of a PDF',
      '  \u2022 ["m5", "r3"] \u2014 read memory m5 and file r3',
      '  \u2022 ["C:/Users/me/docs/notes.md"] \u2014 read a file directly by path (no search needed)',
    ].join('\n'),
    {
      results: z.array(z.union([
        z.string(),
        z.object({
          id: z.string(),
          location: z.object({
            type: z.enum(['lines', 'page']),
            start: z.number().optional(),
            end: z.number().optional(),
            page: z.number().optional(),
          }).optional(),
        }),
      ])).describe('Array of reference IDs (e.g. "r1") or objects with id and optional line range'),
    },
    async ({ results: refs }) => {
      try {
        const outputParts: string[] = [];

        for (const ref of refs) {
          const id = typeof ref === 'string' ? ref : ref.id;

          // Only support m-prefixed IDs in the Worker (no file/dir puids)
          if (/^m\d+$/i.test(id)) {
            const memId = parseInt(id.slice(1), 10);
            const mem = await memory.getById(memId);
            if (!mem) {
              outputParts.push(`## ${id}: Memory not found`);
              continue;
            }

            const lines: string[] = [];
            lines.push(`## ${id}: ${mem.topic}`);

            if (mem.deletedAt) {
              lines.push(`\u26a0\ufe0f This memory was deleted on ${mem.deletedAt}.${mem.deletionReason ? ` Reason: ${mem.deletionReason}` : ''}`);
              lines.push('');
            }

            lines.push(mem.body);
            lines.push('');

            // Metadata
            const meta: string[] = [`Confidence: ${mem.confidence}`, `Created: ${mem.createdAt}`, `Updated: ${mem.updatedAt}`];
            if (mem.actionDate) {
              let actionStr = `Action: ${mem.actionDate}`;
              if (mem.recurrence) actionStr += ` (${mem.recurrence})`;
              if (isActionOverdue(mem)) actionStr += ' \u26a0\ufe0f OVERDUE';
              meta.push(actionStr);
            }
            if (mem.dueDate) {
              meta.push(`Due: ${mem.dueDate}${isDuePastDue(mem) ? ' \ud83d\udea8 PAST DUE' : ''}`);
            }
            if (mem.priority) meta.push(`Priority: ${priorityLabel(mem.priority)}`);
            if (mem.status) meta.push(`Status: ${statusLabel(mem.status)}`);
            if (mem.completedOn) meta.push(`Completed: ${mem.completedOn}`);
            if (mem.contextHint) meta.push(`Context: ${mem.contextHint}`);
            lines.push(`_${meta.join(' | ')}_`);

            // Related memories via Vectorize KNN
            const related = await memory.findRelated(memId, 5);
            if (related.length > 0) {
              lines.push('');
              lines.push('### Related memories');
              for (const rel of related) {
                const sim = Math.round(rel.similarity * 100);
                lines.push(`- [m${rel.id}] ${rel.topic} (${sim}% similar)`);
              }
            }

            outputParts.push(lines.join('\n'));
          } else {
            outputParts.push(`## ${id}: Not supported on lodestone-memory (only m-prefixed memory IDs are available). Use lodestone_read on the lodestone-files server for file references.`);
          }
        }

        return { content: [{ type: 'text' as const, text: outputParts.join('\n\n') }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }] };
      }
    },
  );
}

// ── Project tool ────────────────────────────────────────────────────────────

export function registerProjectTool(server: McpServer, memory: D1MemoryService): void {
  server.tool(
    'lodestone_project',
    [
      'Manage projects for grouping memories and tasks.',
      '',
      'Projects provide a way to organise related memories/tasks under a named group',
      'with a colour. Each memory/task can belong to one project.',
      '',
      'Actions:',
      '  list      — List all projects with task counts',
      '  create    — Create a new project: { name, color? }',
      '  rename    — Rename a project: { name, new_name }',
      '  recolor   — Change project colour: { name, color }',
      '  merge     — Merge source into target: { source, target } (all source tasks move to target)',
      '  delete    — Delete a project: { name } (tasks become unassigned)',
      '  archive   — Archive a project: { name } (hides from recall/agenda without deleting)',
      '  unarchive — Restore an archived project: { name }',
      '  search    — Fuzzy search for projects by name: { name } (returns closest matches)',
      '',
      'Available colours: slate, red, orange, amber, emerald, teal, cyan, blue,',
      'indigo, violet, purple, rose, pink. Default: blue.',
    ].join('\n'),
    {
      action: z.enum(['list', 'create', 'rename', 'recolor', 'merge', 'delete', 'archive', 'unarchive', 'search']).describe('Operation to perform'),
      name: z.string().optional().describe('Project name (required for all actions except list)'),
      new_name: z.string().optional().describe('New name for rename action'),
      color: z.string().optional().describe('Colour for create/recolor: slate, red, orange, amber, emerald, teal, cyan, blue, indigo, violet, purple, rose, pink'),
      source: z.string().optional().describe('Source project name for merge action'),
      target: z.string().optional().describe('Target project name for merge action'),
      include_archived: z.boolean().optional().describe('Include archived projects in list output. Default: false'),
    },
    async ({ action, name, new_name, color, source, target, include_archived }) => {
      try {
        switch (action) {
          case 'list': {
            const projects = await memory.getProjectsWithCounts(include_archived ?? false);
            if (projects.length === 0) {
              return textResult('No projects found.');
            }
            const lines: string[] = [`## Projects (${projects.length})`, ''];
            for (const p of projects) {
              const counts = `${p.openCount} open, ${p.completedCount} completed, ${p.totalCount} total`;
              const archivedTag = p.archivedAt ? ' (archived)' : '';
              lines.push(`- **${p.name}**${archivedTag} (${p.color}) — ${counts}`);
            }
            return textResult(lines.join('\n'));
          }

          case 'create': {
            if (!name) return textResult('Error: name is required for create.');
            // Exact match check (case-insensitive via COLLATE NOCASE)
            const existing = await memory.getProjectByName(name);
            if (existing) {
              return textResult(`Project "${name}" already exists (id: ${existing.id}).`);
            }
            // Create the project
            const id = await memory.createProject(name, color ?? 'blue');
            // Fuzzy dedup: non-blocking warning about near-matches
            const resolved = await memory.resolveProjectName(name);
            // resolveProjectName will find exact match now (just created), so check
            // all projects for close names (excluding the one we just created)
            if (resolved.status === 'found') {
              const allProjects = await memory.getProjectsWithCounts();
              const close = allProjects
                .filter(p => p.id !== id)
                .map(p => ({ name: p.name, distance: levenshteinDistance(name.toLowerCase(), p.name.toLowerCase()) }))
                .filter(s => s.distance > 0 && s.distance <= Math.max(2, Math.ceil(name.length * 0.3)))
                .sort((a, b) => a.distance - b.distance)
                .slice(0, 3)
                .map(s => `  - "${s.name}"`)
                .join('\n');
              if (close) {
                return textResult(
                  `Created project "${name}" (id: ${id}, colour: ${color ?? 'blue'}).\n\n`
                  + `⚠️ Note: similar projects already exist:\n${close}\n`
                  + 'Consider merging if this was a typo.',
                );
              }
            }
            return textResult(`Created project "${name}" (id: ${id}, colour: ${color ?? 'blue'}).`);
          }

          case 'rename': {
            if (!name) return textResult('Error: name is required for rename.');
            if (!new_name) return textResult('Error: new_name is required for rename.');
            const resolved = await resolveProjectOrError(memory, name);
            if ('error' in resolved) return resolved.error;
            await memory.updateProject(resolved.id, { name: new_name });
            return textResult(`Renamed project "${name}" to "${new_name}".`);
          }

          case 'recolor': {
            if (!name) return textResult('Error: name is required for recolor.');
            if (!color) return textResult('Error: color is required for recolor.');
            const resolved = await resolveProjectOrError(memory, name);
            if ('error' in resolved) return resolved.error;
            await memory.updateProject(resolved.id, { color });
            return textResult(`Changed "${name}" colour to ${color}.`);
          }

          case 'merge': {
            if (!source) return textResult('Error: source is required for merge.');
            if (!target) return textResult('Error: target is required for merge.');
            const srcResolved = await resolveProjectOrError(memory, source);
            if ('error' in srcResolved) return srcResolved.error;
            const tgtResolved = await resolveProjectOrError(memory, target);
            if ('error' in tgtResolved) return tgtResolved.error;
            const reassigned = await memory.mergeProjects(srcResolved.id, tgtResolved.id);
            return textResult(`Merged "${source}" into "${target}". ${reassigned} task${reassigned === 1 ? '' : 's'} reassigned. Source project deleted.`);
          }

          case 'delete': {
            if (!name) return textResult('Error: name is required for delete.');
            const resolved = await resolveProjectOrError(memory, name);
            if ('error' in resolved) return resolved.error;
            await memory.deleteProject(resolved.id);
            return textResult(`Deleted project "${name}". Tasks in this project are now unassigned.`);
          }

          case 'archive': {
            if (!name) return textResult('Error: name is required for archive.');
            const resolved = await resolveProjectOrError(memory, name);
            if ('error' in resolved) return resolved.error;
            await memory.archiveProject(resolved.id);
            return textResult(`Archived project "${name}". Its memories are now hidden from recall and agenda. Use action "unarchive" to restore.`);
          }

          case 'unarchive': {
            if (!name) return textResult('Error: name is required for unarchive.');
            const resolved = await resolveArchivedProjectOrError(memory, name);
            if ('error' in resolved) return resolved.error;
            await memory.unarchiveProject(resolved.id);
            return textResult(`Unarchived project "${name}". Its memories are now visible in recall and agenda again.`);
          }

          case 'search': {
            if (!name) return textResult('Error: name is required for search.');
            const allProjects = await memory.getProjectsWithCounts();
            if (allProjects.length === 0) return textResult('No projects found.');
            const scored = allProjects
              .map(p => ({ ...p, distance: levenshteinDistance(name.toLowerCase(), p.name.toLowerCase()) }))
              .sort((a, b) => a.distance - b.distance)
              .slice(0, 5);
            const lines = scored.map(p => {
              const counts = `${p.openCount} open, ${p.completedCount} completed, ${p.totalCount} total`;
              return `- **${p.name}** (${p.color}, distance: ${p.distance}) — ${counts}`;
            });
            return textResult(`## Search results for "${name}"\n\n${lines.join('\n')}`);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return textResult(`Error: ${message}`);
      }
    },
  );
}
