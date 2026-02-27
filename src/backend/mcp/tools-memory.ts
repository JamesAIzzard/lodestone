/**
 * Memory tool registrations: remember, recall, revise, forget, orient, agenda.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { parseFlexibleDate, parseRecurrence, parseDateRange } from '../date-parser';
import type { McpServerDeps } from './types';
import { PuidManager } from './puid-manager';
import { truncateMemoryBody, memoryBodyWarning, priorityLabel, statusLabel } from './formatting';

export function registerRememberTool(server: McpServer, deps: McpServerDeps): void {
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
      '  action_date  \u2014 Optional date for when this memory is actionable. Accepts flexible',
      '                  expressions ("tomorrow", "next Monday", "2026-03-15"). Stored as',
      '                  ISO 8601 (YYYY-MM-DD).',
      '  recurrence   \u2014 Optional recurrence rule for repeating action dates. Accepted formats:',
      '                  "daily", "weekly", "biweekly", "monthly", "yearly",',
      '                  "every monday", "every weekday", "every 3 days", "every 2 weeks".',
      '                  Requires action_date to be set. The action_date auto-advances on orient.',
      '  priority     \u2014 Optional urgency level: 1=low, 2=medium, 3=high, 4=critical.',
      '  status       \u2014 Optional lifecycle status: "open", "completed", "cancelled".',
      '                  Setting completed_on implies completed. Setting status="completed"',
      '                  auto-fills completed_on with today if not provided.',
      '                  Setting status="open" clears completed_on.',
      '  completed_on \u2014 Optional date the memory was completed. Implies status="completed".',
      '                  Accepts flexible expressions ("today", "yesterday", "2026-03-15").',
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
      recurrence: z.string().optional().describe('Recurrence rule: "daily", "weekly", "biweekly", "monthly", "yearly", "every monday", "every weekday", "every N days", "every N weeks". Requires action_date.'),
      priority: z.number().int().min(1).max(4).optional().describe('Urgency: 1=low, 2=medium, 3=high, 4=critical'),
      status: z.enum(['open', 'completed', 'cancelled']).optional().describe('Lifecycle status. "completed" auto-fills completed_on=today. "open" clears completed_on.'),
      completed_on: z.string().optional().describe('Date completed. Flexible expressions accepted. Implies status="completed".'),
    },
    async ({ topic, body, confidence, context_hint, force, action_date, recurrence, priority, status, completed_on }) => {
      try {
        deps.notifyActivity?.({ channel: 'memory' });

        // Parse flexible action_date to ISO 8601
        let parsedActionDate: string | null = null;
        if (action_date) {
          parsedActionDate = parseFlexibleDate(action_date);
          if (!parsedActionDate) {
            return {
              content: [{ type: 'text' as const, text: `Error: Could not parse action_date "${action_date}". Use ISO 8601 (YYYY-MM-DD), relative expressions (tomorrow, next Monday), or natural dates (March 15).` }],
              isError: true,
            };
          }
        }

        // Parse and validate recurrence rule
        let parsedRecurrence: string | null = null;
        if (recurrence) {
          parsedRecurrence = parseRecurrence(recurrence);
          if (!parsedRecurrence) {
            return {
              content: [{ type: 'text' as const, text: `Error: Could not parse recurrence "${recurrence}". Accepted: daily, weekly, biweekly, monthly, yearly, every monday, every weekday, every N days, every N weeks.` }],
              isError: true,
            };
          }
          if (!parsedActionDate) {
            return {
              content: [{ type: 'text' as const, text: `Error: recurrence requires action_date to be set. Provide an action_date for the first occurrence.` }],
              isError: true,
            };
          }
        }

        // Parse flexible completed_on to ISO 8601
        let parsedCompletedOn: string | null = null;
        if (completed_on) {
          parsedCompletedOn = parseFlexibleDate(completed_on);
          if (!parsedCompletedOn) {
            return {
              content: [{ type: 'text' as const, text: `Error: Could not parse completed_on "${completed_on}". Use ISO 8601 (YYYY-MM-DD) or relative expressions (today, yesterday).` }],
              isError: true,
            };
          }
        }

        const result = await deps.memoryRemember({
          topic,
          body,
          confidence,
          contextHint: context_hint,
          force,
          actionDate: parsedActionDate,
          recurrence: parsedRecurrence,
          priority: priority ?? null,
          status: status ?? null,
          completedOn: parsedCompletedOn,
        });

        if (result.status === 'duplicate') {
          const sim = Math.round(result.similarity * 100);
          const preview = truncateMemoryBody(result.existing.body);
          const meta: string[] = [];
          if (result.existing.actionDate) {
            let actionStr = `Action: ${result.existing.actionDate}`;
            if (result.existing.recurrence) actionStr += ` (${result.existing.recurrence})`;
            meta.push(actionStr);
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
          return {
            content: [{ type: 'text' as const, text: lines.join('\n') }],
          };
        }

        const warning = memoryBodyWarning(body);
        const extras: string[] = [];
        if (parsedActionDate) {
          let actionStr = `Action date: ${parsedActionDate}`;
          if (parsedRecurrence) actionStr += ` (${parsedRecurrence})`;
          extras.push(actionStr + '.');
        }
        if (priority) extras.push(`Priority: ${priorityLabel(priority)}.`);
        if (status) extras.push(`Status: ${statusLabel(status)}.`);
        if (parsedCompletedOn) extras.push(`Completed: ${parsedCompletedOn}.`);
        return {
          content: [{ type: 'text' as const, text: `Created memory m${result.id}.${extras.length ? ' ' + extras.join(' ') : ''}${warning}` }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}

export function registerRecallTool(server: McpServer, deps: McpServerDeps): void {
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
      status: z.enum(['open', 'completed', 'cancelled']).optional().describe('Filter by status.'),
    },
    async ({ query, max_results, mode, updated_after, updated_before, action_after, action_before, completed_after, completed_before, status }) => {
      try {
        deps.notifyActivity?.({ channel: 'memory' });

        // Parse flexible date expressions to ISO 8601
        const dateFilters: Record<string, string> = {};
        for (const [key, raw] of Object.entries({
          updatedAfter: updated_after,
          updatedBefore: updated_before,
          actionAfter: action_after,
          actionBefore: action_before,
          completedAfter: completed_after,
          completedBefore: completed_before,
        })) {
          if (!raw) continue;
          const parsed = parseFlexibleDate(raw);
          if (!parsed) {
            return {
              content: [{ type: 'text' as const, text: `Error: Could not parse date filter "${raw}". Use ISO 8601 (YYYY-MM-DD), relative expressions (tomorrow, next Monday), or natural dates (March 15).` }],
              isError: true,
            };
          }
          dateFilters[key] = parsed;
        }

        const results = await deps.memoryRecall({
          query,
          maxResults: max_results,
          mode,
          ...dateFilters,
          ...(status !== undefined ? { status } : {}),
        });
        if (results.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No memories found.' }] };
        }
        const lines: string[] = [];
        for (const r of results) {
          const pct = Math.round(r.score * 100);
          // Show signal breakdown: "62% convergence: semantic 58%, bm25 45%"
          // or single-signal: "58% semantic"
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
            meta.push(actionStr);
          }
          if (r.priority) meta.push(`Priority: ${priorityLabel(r.priority)}`);
          if (r.status) meta.push(`Status: ${statusLabel(r.status)}`);
          if (r.completedOn) meta.push(`Completed: ${r.completedOn}`);
          lines.push(`_${meta.join(' | ')}_`);
          lines.push('');
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}

export function registerReviseTool(server: McpServer, deps: McpServerDeps): void {
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
      'further action — a single revise call handles everything. Use lodestone_skip instead',
      'if the occurrence should be skipped without recording a completion.',
      '',
      'Parameters:',
      '  id           \u2014 Memory id (from lodestone_recall or lodestone_orient)',
      '  body         \u2014 New body text (optional)',
      '  confidence   \u2014 New confidence value 0\u20131 (optional)',
      '  context_hint \u2014 New context hint (optional, pass null to clear)',
      '  action_date  \u2014 New action date (optional, pass null to clear). Flexible expressions accepted.',
      '  recurrence   \u2014 New recurrence rule (optional, pass null to clear).',
      '                  Accepted: daily, weekly, biweekly, monthly, yearly,',
      '                  every monday, every weekday, every N days, every N weeks.',
      '  priority     \u2014 New priority (optional, pass null to clear). 1=low, 2=medium, 3=high, 4=critical.',
      '  topic        \u2014 New topic label (optional).',
      '  status       \u2014 New status (optional, pass null to clear): "open", "completed", "cancelled".',
      '                  "completed" auto-fills completed_on=today. "open" clears completed_on.',
      '  completed_on \u2014 New completion date (optional, pass null to clear). Flexible expressions accepted.',
    ].join('\n'),
    {
      id: z.union([z.number().int(), z.string()]).describe('Memory id to update (number or m-prefixed id like "m5")'),
      body: z.string().optional().describe('New body text'),
      confidence: z.number().min(0).max(1).optional().describe('New confidence value 0\u20131'),
      context_hint: z.union([z.string(), z.null()]).optional().describe('New context hint (null to clear)'),
      action_date: z.union([z.string(), z.null()]).optional().describe('New action date (null to clear). Flexible expressions accepted.'),
      recurrence: z.union([z.string(), z.null()]).optional().describe('New recurrence rule (null to clear). Accepted: daily, weekly, biweekly, monthly, yearly, every monday, every weekday, every N days, every N weeks.'),
      priority: z.union([z.number().int().min(1).max(4), z.null()]).optional().describe('New priority (null to clear). 1=low, 2=medium, 3=high, 4=critical.'),
      topic: z.string().optional().describe('New topic label'),
      status: z.union([z.enum(['open', 'completed', 'cancelled']), z.null()]).optional().describe('New status (null to clear). "completed" auto-fills completed_on. "open" clears completed_on.'),
      completed_on: z.union([z.string(), z.null()]).optional().describe('New completion date (null to clear). Flexible expressions accepted.'),
    },
    async ({ id: rawId, body, confidence, context_hint, action_date, recurrence, priority, topic, status, completed_on }) => {
      try {
        deps.notifyActivity?.({ channel: 'memory' });
        const id = PuidManager.resolveMemoryIdParam(rawId);

        // Parse flexible action_date to ISO 8601 (null clears it)
        let parsedActionDate: string | null | undefined;
        if (action_date === null) {
          parsedActionDate = null; // explicitly clear
        } else if (action_date !== undefined) {
          parsedActionDate = parseFlexibleDate(action_date);
          if (!parsedActionDate) {
            return {
              content: [{ type: 'text' as const, text: `Error: Could not parse action_date "${action_date}". Use ISO 8601 (YYYY-MM-DD), relative expressions (tomorrow, next Monday), or natural dates (March 15).` }],
              isError: true,
            };
          }
        }

        // Parse recurrence rule (null clears it)
        let parsedRecurrence: string | null | undefined;
        if (recurrence === null) {
          parsedRecurrence = null; // explicitly clear
        } else if (recurrence !== undefined) {
          parsedRecurrence = parseRecurrence(recurrence);
          if (!parsedRecurrence) {
            return {
              content: [{ type: 'text' as const, text: `Error: Could not parse recurrence "${recurrence}". Accepted: daily, weekly, biweekly, monthly, yearly, every monday, every weekday, every N days, every N weeks.` }],
              isError: true,
            };
          }
        }

        // Parse flexible completed_on (null clears it)
        let parsedCompletedOn: string | null | undefined;
        if (completed_on === null) {
          parsedCompletedOn = null;
        } else if (completed_on !== undefined) {
          parsedCompletedOn = parseFlexibleDate(completed_on);
          if (!parsedCompletedOn) {
            return {
              content: [{ type: 'text' as const, text: `Error: Could not parse completed_on "${completed_on}". Use ISO 8601 (YYYY-MM-DD) or relative expressions (today, yesterday).` }],
              isError: true,
            };
          }
        }

        const reviseResult = await deps.memoryRevise({
          id,
          body,
          confidence,
          contextHint: context_hint,
          actionDate: parsedActionDate,
          recurrence: parsedRecurrence,
          priority,
          topic,
          status,
          completedOn: parsedCompletedOn,
        });
        const warning = body ? memoryBodyWarning(body) : '';
        let msg = `Memory m${id} revised.`;
        if (reviseResult.completionRecordId !== undefined) {
          msg += ` Completion recorded as m${reviseResult.completionRecordId}. Next occurrence: ${reviseResult.nextActionDate}.`;
        }
        return { content: [{ type: 'text' as const, text: msg + warning }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}

export function registerForgetTool(server: McpServer, deps: McpServerDeps): void {
  server.tool(
    'lodestone_forget',
    [
      'Soft-delete a specific memory by id.',
      '',
      'Use when something is definitively wrong, no longer relevant,',
      'or has been superseded by a revised memory.',
      '',
      'The memory is not permanently removed. It is marked deleted and becomes',
      'invisible to recall, orient, agenda, and dedup checks. It can still be',
      'read via lodestone_read (using its m-id), which will show the body alongside',
      'a deletion notice. This preserves reference integrity: any memory that',
      'cross-references this one by m-id will still resolve correctly.',
      '',
      'Parameters:',
      '  id     \u2014 Memory id (from lodestone_recall or lodestone_orient)',
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
        deps.notifyActivity?.({ channel: 'memory' });
        const id = PuidManager.resolveMemoryIdParam(rawId);
        await deps.memoryForget({ id, reason });
        const reasonSuffix = reason ? ` Reason: ${reason}` : '';
        return { content: [{ type: 'text' as const, text: `Memory m${id} soft-deleted.${reasonSuffix}` }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}

export function registerSkipTool(server: McpServer, deps: McpServerDeps): void {
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
        deps.notifyActivity?.({ channel: 'memory' });
        const id = PuidManager.resolveMemoryIdParam(rawId);
        const result = await deps.memorySkip({ id, reason });
        const reasonSuffix = reason ? ` Reason: ${reason}.` : '';
        return { content: [{ type: 'text' as const, text: `Memory m${id} skipped. Next occurrence: ${result.nextActionDate}.${reasonSuffix}` }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}

export function registerOrientTool(server: McpServer, deps: McpServerDeps): void {
  server.tool(
    'lodestone_orient',
    [
      'Return the N most recently updated memories, regardless of query.',
      '',
      'This is the orientation tool \u2014 call it at the start of a conversation,',
      'before there is enough context to form a meaningful recall query,',
      'to ground yourself in recent and active working context.',
      '',
      'Also surfaces memories with action dates in the next 7 days, so upcoming',
      'deadlines and planned actions are visible at conversation start.',
      'Recurring tasks advance their action_date when completed via lodestone_revise',
      '(status: "completed"), not automatically on orient.',
      '',
      'Results show truncated previews. Use lodestone_read with the m-prefixed ID (e.g. "m3") to read the full body.',
      '',
      'Parameters:',
      '  max_results \u2014 Maximum memories to return. Default: 10',
    ].join('\n'),
    {
      max_results: z.number().min(1).max(50).optional().describe('Maximum memories to return. Default: 10'),
    },
    async ({ max_results }) => {
      try {
        deps.notifyActivity?.({ channel: 'memory' });
        const results = await deps.memoryOrient({ maxResults: max_results });
        if (results.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No memories stored yet.' }] };
        }
        const lines: string[] = [];
        for (const r of results) {
          lines.push(`## [m${r.id}] ${r.topic} (confidence: ${r.confidence})`);
          lines.push(truncateMemoryBody(r.body));
          const meta = [`Updated: ${r.updatedAt}`];
          if (r.actionDate) {
            let actionStr = `Action: ${r.actionDate}`;
            if (r.recurrence) actionStr += ` (${r.recurrence})`;
            meta.push(actionStr);
          }
          if (r.priority) meta.push(`Priority: ${priorityLabel(r.priority)}`);
          lines.push(`_${meta.join(' | ')}_`);
          lines.push('');
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}

export function registerAgendaTool(server: McpServer, deps: McpServerDeps): void {
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
      'Use lodestone_orient for recent conversational context; use lodestone_agenda for tasks.',
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
        deps.notifyActivity?.({ channel: 'memory' });

        const range = parseDateRange(when);
        if (!range) {
          return {
            content: [{ type: 'text' as const, text: `Error: Could not parse "when" value "${when}". Use keywords (today, tomorrow, this week, next week, this month, next month, overdue) or a date expression.` }],
            isError: true,
          };
        }

        const result = await deps.memoryAgenda({
          when,
          includeCompleted: include_completed,
          maxResults: max_results,
        });

        const lines: string[] = [];

        // ── Overdue section ──────────────────────────────────────────────
        if (result.overdue.length > 0) {
          lines.push(`## \u26a0\ufe0f Overdue (${result.overdue.length})`);
          lines.push('');
          for (const r of result.overdue) {
            lines.push(formatAgendaItem(r));
          }
          lines.push('> These items are overdue \u2014 consider asking the user what to do with them.');
          lines.push('');
        }

        // ── Upcoming section ─────────────────────────────────────────────
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

        if (lines.length === 0) {
          return { content: [{ type: 'text' as const, text: `Nothing on the agenda for "${when}".` }] };
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}

/** Format a single agenda item as a compact markdown block. */
function formatAgendaItem(r: { id: number; topic: string; body: string; actionDate: string | null; recurrence: string | null; priority: number | null; status: string | null; completedOn: string | null; confidence: number }): string {
  const meta: string[] = [];
  if (r.actionDate) {
    let actionStr = `Action: ${r.actionDate}`;
    if (r.recurrence) actionStr += ` (${r.recurrence})`;
    meta.push(actionStr);
  }
  if (r.priority) meta.push(`Priority: ${priorityLabel(r.priority)}`);
  if (r.status) meta.push(`Status: ${statusLabel(r.status)}`);
  if (r.completedOn) meta.push(`Completed: ${r.completedOn}`);
  const lines = [
    `### [m${r.id}] ${r.topic}`,
    truncateMemoryBody(r.body),
    `_${meta.join(' | ')}_`,
    '',
  ];
  return lines.join('\n');
}
