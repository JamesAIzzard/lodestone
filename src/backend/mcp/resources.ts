/**
 * MCP Resources: exposes the startup usage guide as a tool and a resource.
 *
 *   lodestone://guide/startup - tools, configured silos, mail mechanics, and
 *                               where to find the user's LLM instructions note
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SiloStatus } from '../../shared/types';
import { buildDatetime } from './formatting';

export interface LlmInstructionsConfig {
  notePath?: string;
}

export type GetLlmInstructionsConfig = () => Promise<LlmInstructionsConfig>;
export type GetSilos = () => Promise<{ silos: SiloStatus[] }>;

export interface GuideDeps {
  getLlmInstructionsConfig: GetLlmInstructionsConfig;
  getSilos: GetSilos;
}

const STARTUP_TOOL_GUIDE = `# lodestone-files - Startup Guide

Lodestone searches, browses, reads, and edits files in configured silos.

## Key Tools

- \`lodestone_search\` finds files by semantic meaning, keywords, filename, path, or regular expression.
- \`lodestone_explore\` browses indexed directory structures.
- \`lodestone_read\` reads a search result reference or absolute path.
- \`lodestone_edit\` creates, changes, moves, renames, or trashes indexed files.
- \`lodestone_status\` lists silos with their descriptions, s references, and indexing state.
- \`lodestone_get_datetime\` returns the current local date and time.

Use \`lodestone_search\` or \`lodestone_explore\` to locate material, then \`lodestone_read\` before editing. Every search result carries a date, and \`lodestone_search\` accepts inclusive \`since\` and \`until\` bounds; with no query it lists everything in that window. \`silo\` on search and explore takes a silo name or s reference, or an array of them.`;

const MAIL_SILO_GUIDE = `## Mail Silos

Mail silos are read-only mirrors of an email account, refreshed on a timer. Results may lag the mailbox by up to the sync interval, and \`lodestone_edit\` cannot modify them. Each search hit is one message dated by its received time. Its frontmatter records the sender, recipients, date, folders and attachment names, and \`lodestone_read\` returns the whole message. Attachment names are metadata until you call \`lodestone_read_email_attachment\`.`;

function isMailSilo(silo: SiloStatus): boolean {
  return silo.config.managedBy?.startsWith('mail:') ?? false;
}

function buildSiloSection(silos: SiloStatus[] | null): string {
  if (silos === null) return '## Silos\n\nThe silo list is unavailable; call `lodestone_status`.';
  if (silos.length === 0) return '## Silos\n\nNo silos are configured.';

  const lines = silos.map((silo) => {
    const flags: string[] = [];
    if (isMailSilo(silo)) flags.push('mail');
    if (silo.config.readOnly) flags.push('read-only');
    const suffix = flags.length > 0 ? ` (${flags.join(', ')})` : '';
    const description = (silo.config.contentDescription ?? '').trim();
    const head = `- \`${silo.config.name}\`${suffix}`;
    return description ? `${head}: ${description}` : head;
  });
  return `## Silos\n\n${lines.join('\n')}`;
}

function buildInstructionsBootstrap(notePath?: string): string {
  if (notePath) {
    return `## LLM User Instructions

Before substantive work, read the configured instructions note with \`lodestone_read\`:

\`${notePath}\``;
  }

  return `## LLM User Instructions

No instructions note is configured. Use \`lodestone_search\` to look for a likely note containing LLM user instructions before substantive work.`;
}

async function loadSilos(getSilos: GetSilos): Promise<SiloStatus[] | null> {
  try {
    return (await getSilos()).silos;
  } catch {
    return null;
  }
}

export async function getStartupGuide(deps: GuideDeps): Promise<string> {
  const [config, silos] = await Promise.all([
    deps.getLlmInstructionsConfig(),
    loadSilos(deps.getSilos),
  ]);

  const sections = [STARTUP_TOOL_GUIDE, buildSiloSection(silos)];
  if (silos === null || silos.some(isMailSilo)) sections.push(MAIL_SILO_GUIDE);
  sections.push(buildInstructionsBootstrap(config.notePath));
  return sections.join('\n\n');
}

export function registerGuideTool(server: McpServer, deps: GuideDeps): void {
  server.tool(
    'lodestone_guide',
    [
      'Retrieve the usage guide for the lodestone-files toolset: the available tools,',
      "the configured silos with their descriptions, mail silo mechanics, and where to find the user's LLM instructions note.",
      '',
      'Call this at the start of a conversation.',
    ].join('\n'),
    {
      topic: z
        .enum(['startup'])
        .optional()
        .describe('Guide topic. Only `startup` exists and it may be omitted.'),
    },
    async () => ({
      content: [{ type: 'text' as const, text: await getStartupGuide(deps) }],
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

export function registerResources(server: McpServer, deps: GuideDeps): void {
  server.resource(
    'guide-startup',
    'lodestone://guide/startup',
    {
      description:
        "Session startup: tools, configured silos, mail mechanics, and the user's LLM instructions note.",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: await getStartupGuide(deps),
        },
      ],
    }),
  );
}
