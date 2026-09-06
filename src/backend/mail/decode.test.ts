import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { decodeBodyPart, htmlToText } from './decode';

describe('decodeBodyPart', () => {
  it.each([
    ['7bit', Buffer.from('line one\r\nline two'), 'line one\nline two'],
    ['8bit', Buffer.from('caf\u00e9', 'latin1'), 'caf\u00e9'],
    ['binary', Buffer.from('raw\rbytes', 'latin1'), 'raw\nbytes'],
    ['quoted-printable', Buffer.from('caf=E9=\r\n!'), 'caf\u00e9!'],
    ['base64', Buffer.from('Y2Fm6Q=='), 'caf\u00e9'],
  ])('decodes %s transfer encoding', (encoding, bytes, expected) => {
    expect(decodeBodyPart(bytes, encoding, 'iso-8859-1')).toBe(expected);
  });

  it('falls back to latin1 for an unknown charset', () => {
    expect(decodeBodyPart(Buffer.from([0xe9]), '8bit', 'x-unknown-charset')).toBe('\u00e9');
  });
});

describe('htmlToText', () => {
  it('preserves links and nested quotations while dropping executable and remote elements', () => {
    const fixture = readFileSync(
      fileURLToPath(new URL('./fixtures/tracking-message.html', import.meta.url)),
      'utf8',
    );
    const text = htmlToText(fixture);

    expect(text).toContain('Hello plan owner [https://example.com/plan].');
    expect(text).toContain('> First level');
    expect(text).toContain('> > Second level');
    expect(text).not.toContain('tracker.example');
    expect(text).not.toContain('stealSecrets');
    expect(text).not.toContain('color: red');
  });
});
