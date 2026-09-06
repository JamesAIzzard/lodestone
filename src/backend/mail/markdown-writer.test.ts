import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';

import { contentHash, renderMirrorFile } from './markdown-writer';
import type { BodyStatus, MirrorInput } from './types';

const cases = [
  ['plain', 'complete', 'Plain body.'],
  ['html', 'complete', 'HTML body [https://example.com].'],
  ['alternative', 'complete', 'Alternative plain body.'],
  ['plain-with-pdf', 'complete', 'Body with attachment.'],
  ['nested-mixed-alternative', 'complete', 'Nested plain body.'],
  ['encrypted', 'encrypted', ''],
  ['unsupported', 'unsupported', ''],
] as const;

describe('renderMirrorFile', () => {
  it.each(cases)('matches the %s golden file', (name, status, bodyText) => {
    const attachments =
      name === 'plain-with-pdf'
        ? [{ name: 'rig-plan.pdf', mime: 'application/pdf', size: 184322 }]
        : name === 'nested-mixed-alternative'
          ? [{ name: 'diagram.png', mime: 'image/png', size: 8123 }]
          : [];
    const actual = renderMirrorFile(makeInput({ bodyStatus: status, bodyText, attachments }));
    expect(actual).toBe(readGolden(name));
  });

  it('quotes hostile headers without allowing frontmatter injection', () => {
    const subject = '# quoted: "value"\nfolders: ["x"]';
    const rendered = renderMirrorFile(
      makeInput({
        headers: { ...baseHeaders, subject, from: 'Izzard, James <james@example.com>' },
      }),
    );
    const parsed = matter(rendered).data;

    expect(parsed.subject).toBe(subject);
    expect(parsed.folders).toEqual(['INBOX']);
    expect(rendered).toBe(readGolden('hostile-headers'));
  });

  it('emits absent scalar and list values explicitly', () => {
    const rendered = renderMirrorFile(
      makeInput({
        headers: {
          ...baseHeaders,
          messageId: null,
          inReplyTo: null,
          references: [],
          subject: null,
          from: null,
          to: [],
          date: null,
        },
      }),
    );
    const parsed = matter(rendered).data;

    expect(parsed).toMatchObject({
      message_id: null,
      in_reply_to: null,
      references: [],
      subject: null,
      from: null,
      to: [],
      date: null,
    });
  });

  it('is byte-identical for the same input and changes when seen changes', () => {
    const input = makeInput();
    const first = renderMirrorFile(input);
    const second = renderMirrorFile(input);
    const changed = renderMirrorFile({ ...input, seen: false });

    expect(second).toBe(first);
    expect(contentHash(second)).toBe(contentHash(first));
    expect(changed).not.toBe(first);
    expect(contentHash(changed)).not.toBe(contentHash(first));
  });

  it('renders generated bodies over 2 MiB and marks truncation exactly once', () => {
    const bodyText = 'x'.repeat(2 * 1024 * 1024 + 1);
    const rendered = renderMirrorFile(makeInput({ bodyText, bodyStatus: 'truncated' }));

    expect(rendered).toContain(bodyText);
    expect(rendered.endsWith('[truncated by Lodestone]\n')).toBe(true);
    expect(rendered.match(/\[truncated by Lodestone\]/g)).toHaveLength(1);
  });

  it('uses LF throughout and ends with exactly one newline', () => {
    const rendered = renderMirrorFile(makeInput({ bodyText: 'one\r\ntwo\r\n' }));
    expect(rendered).not.toContain('\r');
    expect(rendered.endsWith('\n')).toBe(true);
    expect(rendered.endsWith('\n\n')).toBe(false);
  });
});

const baseHeaders: MirrorInput['headers'] = {
  messageId: '<abc@example.com>',
  inReplyTo: '<xyz@example.com>',
  references: ['<xyz@example.com>'],
  subject: 'Thermal rig test plan',
  from: 'Jane Smith <jane@example.com>',
  to: ['James Izzard <james@example.com>'],
  cc: [],
  date: new Date('2026-09-01T09:14:00.987Z'),
};

function makeInput(overrides: Partial<MirrorInput> = {}): MirrorInput {
  return {
    accountUid: 'imap:outlook.office365.com:993:james@example.com',
    messageKey: 'uid:INBOX:1234567:8901',
    headers: baseHeaders,
    bodyText: 'Plain body.',
    bodyMime: 'text/plain',
    bodyStatus: 'complete' as BodyStatus,
    attachments: [],
    receivedAt: new Date('2026-09-01T09:14:07.654Z'),
    folders: ['INBOX'],
    seen: true,
    flagged: false,
    ...overrides,
  };
}

function readGolden(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/${name}.expected.md`, import.meta.url)),
    'utf8',
  );
}
