import { describe, expect, it } from 'vitest';

import fixturesJson from './fixtures/body-structures.json';
import {
  PARTIAL_FETCH_LIMIT,
  chooseBodyPart,
  listAttachments,
  type ImapBodyStructure,
} from './body-part';

const fixtures = fixturesJson as Record<string, ImapBodyStructure>;

describe('chooseBodyPart', () => {
  it.each([
    ['plain', '1', 'text/plain'],
    ['html', '1', 'text/html'],
    ['alternative', '1', 'text/plain'],
    ['plainWithPdf', '1', 'text/plain'],
    ['nestedMixedAlternative', '1.1', 'text/plain'],
  ] as const)('chooses %s as section %s', (fixture, section, mime) => {
    expect(chooseBodyPart(fixtures[fixture])).toMatchObject({ section, mime });
  });

  it('distinguishes encrypted content from unsupported content', () => {
    expect(chooseBodyPart(fixtures.encrypted)).toEqual({ status: 'encrypted' });
    expect(chooseBodyPart(fixtures.noText)).toEqual({ status: 'unsupported' });
  });

  it('ignores text nested beneath an attachment disposition', () => {
    expect(
      chooseBodyPart({
        type: 'message/rfc822',
        disposition: 'attachment',
        childNodes: [{ part: '1.1', type: 'text/plain' }],
      }),
    ).toEqual({ status: 'unsupported' });
  });

  it('prefers plain text within an alternative even when HTML comes first', () => {
    expect(
      chooseBodyPart({
        type: 'multipart/alternative',
        childNodes: [
          { part: '1', type: 'text/html' },
          { part: '2', type: 'text/plain' },
        ],
      }),
    ).toMatchObject({ section: '2', mime: 'text/plain' });
  });

  it('infers nested section numbers when a fixture omits ImapFlow part fields', () => {
    expect(
      chooseBodyPart({
        type: 'multipart/mixed',
        childNodes: [
          {
            type: 'multipart/alternative',
            childNodes: [{ type: 'text/plain' }, { type: 'text/html' }],
          },
        ],
      }),
    ).toMatchObject({ section: '1.1', mime: 'text/plain' });
  });

  it('uses a 2 MiB partial-fetch limit', () => {
    expect(PARTIAL_FETCH_LIMIT).toBe(2_097_152);
  });
});

describe('listAttachments', () => {
  it('lists explicit attachments and named non-text inline parts', () => {
    expect(listAttachments(fixtures.plainWithPdf)).toEqual([
      { name: 'rig-plan.pdf', mime: 'application/pdf', size: 184322 },
    ]);
    expect(listAttachments(fixtures.nestedMixedAlternative)).toEqual([
      { name: 'diagram.png', mime: 'image/png', size: 8123 },
    ]);
  });

  it('keeps null attachment metadata explicit', () => {
    expect(
      listAttachments({
        type: 'multipart/mixed',
        childNodes: [{ type: 'application/zip', disposition: 'attachment' }],
      }),
    ).toEqual([{ name: null, mime: 'application/zip', size: null }]);
  });
});
