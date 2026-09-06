import { createHash } from 'node:crypto';
import { stringify } from 'yaml';

import type { MirrorInput } from './types';

export function renderMirrorFile(input: MirrorInput): string {
  const date = formatDate(input.headers.date);
  const frontmatter = stringify(
    {
      schema: 1,
      account_uid: input.accountUid,
      message_key: input.messageKey,
      message_id: input.headers.messageId,
      in_reply_to: input.headers.inReplyTo,
      references: input.headers.references,
      subject: input.headers.subject,
      from: input.headers.from,
      to: input.headers.to,
      cc: input.headers.cc,
      date,
      received_at: formatDate(input.receivedAt),
      folders: input.folders,
      seen: input.seen,
      flagged: input.flagged,
      attachments: input.attachments.map((attachment) => ({
        name: attachment.name,
        mime: attachment.mime,
        size: attachment.size,
      })),
      body_status: input.bodyStatus,
    },
    {
      blockQuote: false,
      lineWidth: 0,
      nullStr: 'null',
    },
  ).trimEnd();

  const plainHeader = [
    `Subject: ${input.headers.subject ?? ''}`,
    `From: ${input.headers.from ?? ''}`,
    `To: ${input.headers.to.join(', ')}`,
    `Date: ${date ?? ''}`,
  ].join('\n');
  const body = normaliseBody(input.bodyText);
  const bodyWithStatus =
    input.bodyStatus === 'truncated'
      ? [body, '[truncated by Lodestone]'].filter(Boolean).join('\n')
      : body;

  const bodySection = bodyWithStatus ? `\n\n${bodyWithStatus}` : '';
  return `---\n${frontmatter}\n---\n${plainHeader}${bodySection}\n`;
}

export function contentHash(rendered: string): string {
  return createHash('sha256').update(rendered, 'utf8').digest('hex');
}

function formatDate(date: Date | null): string | null {
  if (!date) return null;
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function normaliseBody(body: string): string {
  return body.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
}
