/**
 * MCP Resources — exposes usage guide documents as MCP resources.
 *
 * Three resources cover the full set of use cases:
 *   lodestone://guide/startup  — session startup pattern
 *   lodestone://guide/memory   — memory, task, and agenda management
 *   lodestone://guide/notes    — knowledge base search, file editing, note conventions
 *
 * Content is hardcoded to avoid filesystem dependencies at runtime.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// ── Guide content ──────────────────────────────────────────────────────

const STARTUP_GUIDE = `# Lodestone Startup Guide

At the start of every conversation, call \`lodestone_orient\` with \`max_results: 10\`. This surfaces the most recently updated memories and any upcoming action-date items (tasks, reminders, recurring habits).

Before answering a question that might relate to past context, use \`lodestone_recall\` with a natural language query to retrieve relevant memories. Check lodestone before falling back to web search for any query that may be covered in James's knowledge base.

Before asking James a question, check memories first in case it has been discussed before.`;

const MEMORY_GUIDE = `# Lodestone Memory Guide

## Storing and Revising Memories

Before storing a new memory, use \`lodestone_recall\` to check whether a related memory already exists; update it with \`lodestone_revise\` rather than creating a duplicate. Periodically as you work on tasks or have chats, call \`lodestone_remember\` to record useful facts, decisions, or context. Keep memory bodies factual and self-contained; they will be read in a future session without the current conversation as context. Use \`lodestone_forget\` to remove anything confirmed wrong or outdated. Because lodestone search is semantic by default, conceptual phrases and natural language work as well as keywords.

## Cross-Referencing

Cross-referencing by m-id is a first-class pattern: embed "see m42" or "related: m7, m15" directly in the body to build a navigable knowledge graph. \`lodestone_read\` on a single m-id returns the full body plus the top-5 related memories by cosine similarity, so cross-references surface automatically during exploration. Memory IDs are stable primary keys and safe to reference.

## Tasks and Agenda

Tasks are stored as memories with an \`action_date\`, \`priority\`, and \`status\`. Use \`lodestone_agenda\` at the start of a work session or when James asks what needs doing. Overdue items surface first.

Recurring tasks use the \`recurrence\` field. They advance explicitly:
- **Complete**: Use \`lodestone_revise\` with \`status: "completed"\`. This creates an immutable completion record and resets the task to open with the next \`action_date\`.
- **Skip**: Use \`lodestone_skip\` to advance one step without recording a completion, optionally with a reason.

When a non-recurring task is done, use \`lodestone_revise\` to set \`status: "completed"\`.

## Reminders

Reminders are memories with an \`action_date\` and optional \`recurrence\`. They appear in \`lodestone_orient\` and \`lodestone_agenda\` output. Always check orient output at the start of a session for any critical or high-priority items due today.`;

const NOTES_GUIDE = `# Lodestone Notes Guide

## Searching and Browsing

Use \`lodestone_search\` for topic or keyword-based queries across silos. The search is semantic by default, so conceptual phrases work as well as keywords. Use \`lodestone_explore\` to browse directory structure when the query is navigational rather than content-based. Use \`lodestone_read\` to retrieve full file content once a result reference is in hand.

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

// ── Registration ───────────────────────────────────────────────────────

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
    'guide-notes',
    'lodestone://guide/notes',
    { description: 'Knowledge base: searching, browsing, file editing, and note-writing conventions.' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: NOTES_GUIDE }],
    }),
  );
}
