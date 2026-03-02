/**
 * MCP Resources — exposes usage guide documents as MCP resources.
 *
 * Four resources cover the full set of use cases:
 *   lodestone://guide/startup  — session startup pattern
 *   lodestone://guide/memory   — memory storage, cross-referencing, reminders
 *   lodestone://guide/tasks    — task and agenda management, recurring tasks
 *   lodestone://guide/notes    — knowledge base search, file editing, note conventions
 *
 * Content is hardcoded to avoid filesystem dependencies at runtime.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// ── Guide content ──────────────────────────────────────────────────────

export const STARTUP_GUIDE = `# Lodestone Startup Guide

At the start of every conversation, call \`lodestone_orient\` with \`max_results: 10\`. This surfaces the most recently updated memories and any upcoming action-date items (tasks, reminders, recurring habits).

Memory and knowledge location is the absolute foundation of our workflow. Lodestone is built on a powerful hybrid search algorithm, meaning semantic and keyword-based search are combined for optimal results. Before producing any response, always use \`lodestone_recall\` with a natural language query to retrieve relevant memories, and \`lodestone_search\` to find notes in our knowledge base. Searching for notes will surface related memories alongside, and searching for memories will surface related notes. This memory-first work practice is the absolute foundation of our success. Check lodestone before falling back to web search for any query that may be covered in the user's knowledge base.

## Detailed Guides

Three further guides are available on demand via \`lodestone_guide\`. Fetch the relevant one before undertaking that type of work — do not load all of them at startup.

- **memory** — how to store, revise, and cross-reference memories; reminders. Fetch when storing or managing memories.
- **tasks** — creating tasks, completing, recurring tasks, overdue handling. Fetch when working with the agenda or action-date memories.
- **notes** — searching and browsing silos, editing files, note-writing conventions. Fetch before creating or editing any note in the knowledge base.`;

const MEMORY_GUIDE = `# Lodestone Memory Guide

## Storing and Revising Memories

Before storing a new memory, use \`lodestone_recall\` to check whether a related memory already exists; update it with \`lodestone_revise\` rather than creating a duplicate. Periodically as you work on tasks or have chats, call \`lodestone_remember\` to record useful facts, decisions, or context. Keep memory bodies factual and self-contained; they will be read in a future session without the current conversation as context. Use \`lodestone_forget\` to remove anything confirmed wrong or outdated. Because lodestone search is semantic by default, conceptual phrases and natural language work as well as keywords.

## Cross-Referencing

Cross-referencing by m-id is a first-class pattern: embed "see m42" or "related: m7, m15" directly in the body to build a navigable knowledge graph. \`lodestone_read\` on a single m-id returns the full body plus the top-5 related memories by cosine similarity, so cross-references surface automatically during exploration. Memory IDs are stable primary keys and safe to reference.

## Tasks and Agenda

Tasks are stored as memories with an \`action_date\`, \`priority\`, and \`status\`. Use \`lodestone_agenda\` at the start of a work session or when the user asks what needs doing. Overdue items surface first.

Recurring tasks use the \`recurrence\` field. They advance explicitly:
- **Complete**: Use \`lodestone_revise\` with \`status: "completed"\`. This creates an immutable completion record and resets the task to open with the next \`action_date\`.
- **Skip**: Use \`lodestone_skip\` to advance one step without recording a completion, optionally with a reason.

When a non-recurring task is done, use \`lodestone_revise\` to set \`status: "completed"\`.

## Reminders

Reminders are memories with an \`action_date\` and optional \`recurrence\`. They appear in \`lodestone_orient\` and \`lodestone_agenda\` output. Always check orient output at the start of a session for any critical or high-priority items due today.`;

const NOTES_GUIDE = `# Lodestone Notes Guide

## Searching and Browsing

Use \`lodestone_search\` for topic or keyword-based queries across silos. The search is semantic by default, so conceptual phrases work as well as keywords. Use \`lodestone_explore\` to browse directory structure when the query is navigational rather than content-based. Use \`lodestone_read\` to retrieve full file content once a result reference is in hand.

## Getting the Current Date and Time

Call \`lodestone_get_datetime\` whenever you need an accurate timestamp — for example, when generating note frontmatter or memory entries mid-conversation. It returns the current date and time in a human-readable format including the local timezone (e.g. "Monday 2 March 2026, 14:32 (Europe/London)").

## Editing Files

Use \`lodestone_edit\` with the appropriate operation (\`str_replace\`, \`insert_at_line\`, \`overwrite\`, \`append\`, \`create\`, \`mkdir\`, \`rename\`, \`move\`, or \`delete\`) to create or modify files. Always read a file before editing it. Staleness detection will reject edits if the file has been modified externally since it was last read — when this happens, call \`lodestone_read\` again to update the mental model of the file before retrying. Staleness detection only applies when editing via a puid reference; edits via a raw filepath bypass it.

## Note-Writing Conventions

- Filenames and directory names are generally in CAPS.
- Markdown headings are in CAPS using \`##\` for level 1 and \`###\` for level 2; Obsidian auto-numbers headings so no manual numbering is needed.
- When a heading includes a function or method name, use inline \`code_fence\` syntax rather than caps. Respect the real case of function/method names.
- Equations use MathJax (\`$\` inline, \`$$\` block).
- Terms are explained on first appearance using the blockquote style:

\`\`\`
$$M_f = \\mu \\cdot P \\cdot d_m$$

> Where:
> $M_f$ is the frictional torque (Nm)
> $\\mu$ is the coefficient of friction
> $P$ is the equivalent dynamic bearing load (N)
> $d_m$ is the mean bearing diameter (m)
\`\`\`

- Widely known fundamental equations are wrapped in \`\\boxed{}\`.
- Code uses fenced blocks with language tags; inline code uses backtick syntax.
- Open questions or items requiring review are delimited with \`==\`.
- Comments use \`%%\`.
- Paragraphs are preferred over bullet lists unless a list is genuinely the clearer format.`;


const TASKS_GUIDE = `# Lodestone Tasks & Agenda Guide

## Creating Tasks

Tasks are memories with an \`action_date\`. Create with \`lodestone_remember\`:
- \`action_date\` — when the task is due or actionable (flexible: "tomorrow", "next Monday", "2026-03-15")
- \`priority\` — 1=low, 2=medium, 3=high, 4=critical
- \`status\` — "open" (default on creation)
- \`recurrence\` — for repeating tasks: "daily", "weekly", "every monday", "every 3 days", etc.

Use a short descriptive \`topic\` (e.g. "TASK - Send invoice"). Check \`lodestone_recall\` first to avoid duplicating an existing task.

## Viewing the Agenda

Call \`lodestone_agenda\` at the start of a work session or when James asks what needs doing. It surfaces overdue items first, then upcoming items sorted by priority then date. The \`when\` parameter accepts: "today", "tomorrow", "this week" (default), "next week", "this month", "overdue".

## Completing Tasks

**Non-recurring**: \`lodestone_revise\` with \`status: "completed"\`. Auto-fills \`completed_on\` with today.

**Recurring**: same call — \`lodestone_revise\` with \`status: "completed"\`. This automatically:
1. Creates an immutable completion record referencing the task by m-id.
2. Resets the task to status="open" with \`action_date\` advanced to the next occurrence.

No further action needed after a single revise call.

## Skipping a Recurring Task

Use \`lodestone_skip\` when an occurrence should be skipped without recording a completion (e.g. holiday, postponed). The \`action_date\` advances to the next occurrence. Pass a \`reason\` to append an audit note to the memory body.

## Handling Overdue Items

When reviewing overdue tasks with the user, ask what to do with each one:
- Done: \`lodestone_revise(status: "completed")\`
- No longer relevant this cycle: \`lodestone_skip\`
- Cancelled permanently: \`lodestone_revise(status: "cancelled")\`
- Needs rescheduling: \`lodestone_revise(action_date: "new date")\``;


// ── Registration ───────────────────────────────────────────────────────


const GUIDES = { startup: STARTUP_GUIDE, memory: MEMORY_GUIDE, notes: NOTES_GUIDE, tasks: TASKS_GUIDE } as const;

export function registerGuideTool(server: McpServer): void {
  server.tool(
    'lodestone_guide',
    [
      'Retrieve a detailed usage guide for a part of the Lodestone toolset.',
      '',
      'Call this on demand when you need instructions for a specific capability.',
      'Do not load guides at startup — fetch only when you need them.',
      '',
      'Topics:',
      '  startup — Session startup pattern: when to call orient, recall-first workflow.',
      '  memory  — Memory management: storing, revising, cross-referencing, reminders.',
      '  tasks   — Task and agenda management: creating, completing, recurring, overdue handling.',
      '  notes   — Knowledge base: searching, editing files, note-writing conventions.',
    ].join('\n'),
    {
      topic: z.enum(['startup', 'memory', 'tasks', 'notes']).describe('Guide topic to retrieve.'),
    },
    async ({ topic }) => ({
      content: [{ type: 'text' as const, text: GUIDES[topic] }],
    }),
  );
}


export function registerResources(server: McpServer): void {
  server.resource(
    'guide-startup',
    'lodestone://guide/startup',
    { description: 'Session startup pattern: orient, recall-first, check notes before web search.' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: STARTUP_GUIDE }],
    }),
  );

  server.resource(
    'guide-memory',
    'lodestone://guide/memory',
    { description: 'Memory management: recall-first pattern, storing/revising, tasks, agenda, reminders, recurring habits.' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: MEMORY_GUIDE }],
    }),
  );

  server.resource(
    'guide-tasks',
    'lodestone://guide/tasks',
    { description: 'Task and agenda management: creating tasks, completing, recurring tasks, overdue handling.' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: TASKS_GUIDE }],
    }),
  );

  server.resource(
    'guide-notes',
    'lodestone://guide/notes',
    { description: 'Knowledge base: searching, browsing, file editing, and note-writing conventions.' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: NOTES_GUIDE }],
    }),
  );
}
