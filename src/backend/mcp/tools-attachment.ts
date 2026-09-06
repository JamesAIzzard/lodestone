import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { readAttachmentContent, AttachmentReadError } from '../mail/attachment-reader';
import type { AttachmentFetchErrorCode } from '../mail/attachment';
import { formatBytes } from './formatting';
import { isPathWithinRoot, PuidManager } from './puid-manager';
import type { McpServerDeps } from './types';

const ATTACHMENT_DEADLINE_MS = 60_000;

export function registerAttachmentTool(
  server: McpServer,
  deps: McpServerDeps,
  puid: PuidManager,
): void {
  server.tool(
    'lodestone_read_email_attachment',
    [
      "Read one attachment from a mirrored email on demand, using the email's r reference and the attachment's one-based position in its frontmatter list.",
      '',
      'Supported: PDF (text extracted), PNG, JPEG, GIF and WebP (returned as images), and text types including HTML (returned as text).',
      'Rejected: other types, encrypted PDFs, attachments over 5 MiB, and extracted text over 512 KiB. Images close to 5 MiB may exceed the client output limit.',
      'The attachment is fetched from the mail server when called and is neither indexed nor retained.',
    ].join('\n'),
    {
      email: z
        .string()
        .regex(/^r\d+$/)
        .describe('Email reference returned by Lodestone search or explore.'),
      attachment: z
        .number()
        .int()
        .min(1)
        .describe('One-based position in the email attachments list.'),
    },
    (args) => readEmailAttachment(args, deps, puid),
  );
}

export async function readEmailAttachment(
  args: { email: string; attachment: number },
  deps: McpServerDeps,
  puid: PuidManager,
): Promise<CallToolResult> {
  const { email, attachment } = args;
  if (!/^r\d+$/.test(email)) {
    return attachmentError('Use an r reference returned by lodestone_search or lodestone_explore.');
  }
  const resolved = puid.resolvePuidRecord(email);
  if (!resolved) {
    return attachmentError(
      `Unknown reference "${email}". It may be from a previous session; search again for a fresh reference.`,
    );
  }
  if ('error' in resolved) return attachmentError(resolved.error);

  let silos;
  try {
    ({ silos } = await deps.silo.status());
  } catch {
    return attachmentError(errorGuidance('protocol', 'protocol'));
  }
  const mailSilo = silos.find(
    (silo) =>
      silo.config.managedBy?.startsWith('mail:') &&
      silo.config.indexedDirectories.some((root) => isPathWithinRoot(resolved.filepath, root)),
  );
  if (!mailSilo)
    return attachmentError('The reference is not a mirrored email; search a Mail silo and retry.');

  deps.notifyActivity?.({ channel: 'silo', siloName: mailSilo.config.name });
  let response;
  try {
    response = await deps.mail.readAttachment({ filepath: resolved.filepath, attachment });
  } catch {
    return attachmentError(errorGuidance('protocol', 'protocol'));
  }
  if (response.kind === 'error')
    return attachmentError(errorGuidance(response.code, response.message));

  try {
    const rendered = await readAttachmentContent(
      {
        bytes: Buffer.from(response.dataBase64, 'base64'),
        mime: response.mime,
        name: response.name,
        charset: response.charset,
        declaredSize: response.size,
      },
      { deadlineMs: ATTACHMENT_DEADLINE_MS },
    );
    const name = sanitiseName(response.name) || '(unnamed)';
    const header = `## ${email} attachment ${attachment}: ${name} (${response.mime}, ${formatBytes(response.size)})`;
    if (rendered.kind === 'image') {
      return {
        content: [
          { type: 'text', text: header },
          { type: 'image', data: rendered.dataBase64, mimeType: rendered.mimeType },
        ],
      };
    }
    const fence = textFence(rendered.text);
    return { content: [{ type: 'text', text: `${header}\n${fence}\n${rendered.text}\n${fence}` }] };
  } catch (error) {
    const code = error instanceof AttachmentReadError ? error.kind : 'unsupported';
    return attachmentError(errorGuidance(code, code));
  }
}

function attachmentError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }] };
}

function errorGuidance(code: AttachmentFetchErrorCode, fallback: string): string {
  const guidance: Record<AttachmentFetchErrorCode, string> = {
    'not-email': 'The reference is not a mirrored email; search a Mail silo and retry.',
    unavailable: 'The mail source is temporarily unavailable; resume or reconnect it and retry.',
    'not-found': 'The email or attachment is no longer available; search again and retry.',
    stale:
      'The mirrored attachment metadata is stale; let the source synchronise, then search again.',
    'too-large':
      'The attachment is too large to return safely; open it with the mail provider instead.',
    encrypted: 'The attachment is encrypted; decrypt it outside Lodestone before reading it.',
    unsupported:
      'The attachment format or content is unsupported; open it with a suitable application instead.',
    auth: 'The mail account requires reauthorisation; reconnect it in Lodestone and retry.',
    transient: 'The mail server is temporarily unavailable; retry later.',
    protocol:
      'The mail server could not complete the read; retry, then inspect the Lodestone log if it persists.',
  };
  return guidance[code] ?? fallback;
}

function textFence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function sanitiseName(name: string | null): string {
  return [...(name ?? '')]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .trim();
}
