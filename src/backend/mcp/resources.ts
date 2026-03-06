/**
 * MCP Resources — exposes usage guide documents as MCP resources.
 *
 * Two resources cover the lodestone-files use cases:
 *   lodestone://guide/startup  — session startup pattern (files server)
 *   lodestone://guide/notes    — knowledge base search, file editing, note conventions
 *
 * Memory and task guides are served by the lodestone-memory server (Worker).
 * Content is hardcoded to avoid filesystem dependencies at runtime.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// ── Guide content ──────────────────────────────────────────────────────

export const STARTUP_GUIDE = `# lodestone-files — Startup Guide

This is the file search and editing server. Use it to search indexed silos, browse directories, read files, and edit notes in the knowledge base.

## Key Tools

- **\`lodestone_search\`** — hybrid search across indexed files (semantic, BM25, regex, filepath modes).
- **\`lodestone_explore\`** — browse directory structures with d-puid references.
- **\`lodestone_read\`** — read file contents by r-puid or absolute path.
- **\`lodestone_edit\`** — create, modify, rename, move, or delete files.
- **\`lodestone_status\`** — check silo index status.

## Memory Server

Memory tools (\`lodestone_remember\`, \`lodestone_recall\`, \`lodestone_read\`, \`lodestone_agenda\`, etc.) are available on the separate **lodestone-memory** server. Use \`lodestone_recall\` alongside \`lodestone_search\` for comprehensive information retrieval across both memories and files.

## Detailed Guide

One further guide is available via \`lodestone_guide\`. Fetch it before creating or editing notes.

- **notes** — searching and browsing silos, editing files, note-writing conventions.`;

const NOTES_GUIDE = `# Lodestone Notes Guide

## Searching and Browsing

Use \`lodestone_search\` for topic or keyword-based queries across silos. The search is semantic by default, so conceptual phrases work as well as keywords. Use \`lodestone_explore\` to browse directory structure when the query is navigational rather than content-based. Use \`lodestone_read\` to retrieve full file content once a result reference is in hand.

## Getting the Current Date and Time

Call \`lodestone_get_datetime\` (on the lodestone-memory server) whenever you need an accurate timestamp — for example, when generating note frontmatter or memory entries mid-conversation. It returns the current date and time in a human-readable format including the local timezone (e.g. "Monday 2 March 2026, 14:32 (Europe/London)").

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

const GUIDES = { startup: STARTUP_GUIDE, notes: NOTES_GUIDE } as const;

export function registerGuideTool(server: McpServer): void {
  server.tool(
    'lodestone_guide',
    [
      'Retrieve a detailed usage guide for the lodestone-files toolset.',
      '',
      'Call this at the start of a conversation to understand available tools,',
      'or on demand when you need instructions for a specific capability.',
      '',
      'Topics:',
      '  startup — Overview of file search/edit tools and integration with lodestone-memory.',
      '  notes   — Knowledge base: searching, editing files, note-writing conventions.',
    ].join('\n'),
    {
      topic: z.enum(['startup', 'notes']).describe('Guide topic to retrieve.'),
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
    { description: 'Session startup: file search/edit tools and integration with lodestone-memory.' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: STARTUP_GUIDE }],
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
