/**
 * MCP Resources: exposes usage guide documents as MCP resources.
 *
 * Two resources cover the lodestone-files use cases:
 *   lodestone://guide/startup - session startup pattern
 *   lodestone://guide/notes   - knowledge base search and file editing
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildDatetime } from './formatting';

export type GuideTopic = 'startup' | 'notes';

export interface LlmInstructionsConfig {
  notePath?: string;
}

export type GetLlmInstructionsConfig = () => Promise<LlmInstructionsConfig>;

const STARTUP_TOOL_GUIDE = `# lodestone-files - Startup Guide

Lodestone searches, browses, reads, and edits files in configured silos.

## Key Tools

- \`lodestone_search\` finds files by semantic meaning, keywords, filename, path, or regular expression.
- \`lodestone_explore\` browses indexed directory structures.
- \`lodestone_read\` reads a search result reference or absolute path.
- \`lodestone_edit\` creates, changes, moves, renames, or trashes indexed files.
- \`lodestone_status\` reports silo availability and indexing state.
- \`lodestone_get_datetime\` returns the current local date and time.

\`lodestone_status\` labels each silo with an s reference. \`silo\` on search and explore takes a name or a reference, or an array of them.

Use \`lodestone_search\` or \`lodestone_explore\` to locate material, then \`lodestone_read\` before editing. Every search result carries a date, and \`lodestone_search\` accepts inclusive \`since\` and \`until\` bounds. Omit the query, keeping \`since\` or \`until\`, to list every file in the window newest first with a total count.`;

const MAIL_SILO_GUIDE = `## Mail Silos

Silos named \`Mail: …\` are read-only email mirrors refreshed on a timer. Each search hit is one message and shows its received date; \`since\` and \`until\` filter on that date. To see all mail on a day or in a window, search with \`since\` and \`until\` and no query. Its frontmatter records the sender, recipients, date, folders and attachment names, and \`lodestone_read\` returns the whole message. Attachment names are metadata until you call \`lodestone_read_email_attachment\` with the email reference and its one-based attachment position. Supported attachments are fetched on demand, returned without being indexed or retained, and may be rejected by type or size. Client output limits may also reject long extracted text or images close to 5 MiB. Results may lag the mailbox by up to the sync interval, and \`lodestone_edit\` cannot modify them.`;

const NOTES_TOOL_GUIDE = `# Lodestone Notes Guide

Use \`lodestone_search\` for topic or keyword queries, \`lodestone_explore\` for directory navigation, and \`lodestone_read\` to retrieve the selected note.

Use \`lodestone_edit\` for note changes. Always read a note before editing it. Staleness detection rejects an edit if the file changed externally after it was read. When this happens, read the note again and retry a narrow edit against the refreshed content.`;

function buildInstructionsBootstrap(notePath?: string): string {
  if (notePath) {
    return `## LLM User Instructions

Before substantive work, open the configured instructions note with \`lodestone_read\`:

\`${notePath}\`

Follow its links only as far as the current task requires. More specific project instructions and current source material take precedence.`;
  }

  return `## LLM User Instructions

No instructions note is configured. Use \`lodestone_search\` to look for a likely note containing LLM user instructions before substantive work.`;
}

export async function getGuideText(
  topic: GuideTopic,
  getConfig: GetLlmInstructionsConfig,
): Promise<string> {
  if (topic === 'notes') return NOTES_TOOL_GUIDE;

  const config = await getConfig();
  return `${STARTUP_TOOL_GUIDE}\n\n${MAIL_SILO_GUIDE}\n\n${buildInstructionsBootstrap(config.notePath)}`;
}

export function registerGuideTool(server: McpServer, getConfig: GetLlmInstructionsConfig): void {
  server.tool(
    'lodestone_guide',
    [
      'Retrieve a detailed usage guide for the lodestone-files toolset.',
      '',
      'Call this at the start of a conversation to understand available tools,',
      'or on demand when you need instructions for a specific capability.',
      '',
      'Topics:',
      '  startup - Overview of file search/edit tools.',
      '  notes   - Knowledge base search and editing mechanics.',
    ].join('\n'),
    {
      topic: z.enum(['startup', 'notes']).describe('Guide topic to retrieve.'),
    },
    async ({ topic }) => ({
      content: [{ type: 'text' as const, text: await getGuideText(topic, getConfig) }],
    }),
  );
}

export function registerDateTimeTool(server: McpServer): void {
  server.tool(
    'lodestone_get_datetime',
    'Get the current local date and time, including timezone.',
    async () => ({
      content: [{ type: 'text' as const, text: buildDatetime() }],
    }),
  );
}

export function registerResources(server: McpServer, getConfig: GetLlmInstructionsConfig): void {
  server.resource(
    'guide-startup',
    'lodestone://guide/startup',
    { description: 'Session startup: file search/edit tools.' },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: await getGuideText('startup', getConfig),
        },
      ],
    }),
  );

  server.resource(
    'guide-notes',
    'lodestone://guide/notes',
    {
      description: 'Knowledge base search, browsing, and file editing mechanics.',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: await getGuideText('notes', getConfig),
        },
      ],
    }),
  );
}
