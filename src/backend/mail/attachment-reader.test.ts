import { describe, expect, it } from 'vitest';

import { MAX_ATTACHMENT_TEXT_BYTES, type AttachmentContent } from './attachment';
import { readAttachmentContent } from './attachment-reader';

describe('readAttachmentContent', () => {
  it('extracts the complete text layer from a PDF', async () => {
    await expect(
      readAttachmentContent(
        content(minimalPdf('Flight LS123 to Porto'), 'application/pdf'),
        deadline(),
      ),
    ).resolves.toEqual({
      kind: 'text',
      text: 'Flight LS123 to Porto',
    });
  });

  it('rejects PDFs without a text layer and incorrect binary signatures', async () => {
    await expect(
      readAttachmentContent(content(minimalPdf(''), 'application/pdf'), deadline()),
    ).rejects.toMatchObject({ kind: 'unsupported' });
    await expect(
      readAttachmentContent(content(Buffer.from('not a png'), 'image/png'), deadline()),
    ).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it.each([
    ['image/png', Buffer.from('89504e470d0a1a0a00000000', 'hex'), 'image/png'],
    ['image/jpeg', Buffer.from('ffd8ffe00000000000000000', 'hex'), 'image/jpeg'],
    ['image/jpg', Buffer.from('ffd8ffe00000000000000000', 'hex'), 'image/jpeg'],
    ['image/gif', Buffer.from('GIF89a......', 'ascii'), 'image/gif'],
    ['image/webp', Buffer.from('RIFF0000WEBP', 'ascii'), 'image/webp'],
  ])('returns %s as an MCP raster image', async (mime, bytes, expectedMime) => {
    await expect(readAttachmentContent(content(bytes, mime), deadline())).resolves.toMatchObject({
      kind: 'image',
      mimeType: expectedMime,
      dataBase64: bytes.toString('base64'),
    });
  });

  it('decodes charsets and converts HTML without executing active content', async () => {
    await expect(
      readAttachmentContent(
        content(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'text/plain', 'iso-8859-1'),
        deadline(),
      ),
    ).resolves.toEqual({ kind: 'text', text: 'café' });
    await expect(
      readAttachmentContent(
        content(Buffer.from('<p>Hello <b>world</b></p><script>bad()</script>'), 'text/html'),
        deadline(),
      ),
    ).resolves.toEqual({ kind: 'text', text: 'Hello world' });
  });

  it.each(['application/json', 'application/xml', 'image/svg+xml'])(
    'returns %s as text',
    async (mime) => {
      await expect(
        readAttachmentContent(content(Buffer.from('plain text'), mime), deadline()),
      ).resolves.toEqual({ kind: 'text', text: 'plain text' });
    },
  );

  it('rejects over-length text and unsupported active or container formats', async () => {
    await expect(
      readAttachmentContent(
        content(Buffer.alloc(MAX_ATTACHMENT_TEXT_BYTES + 1, 0x61), 'text/plain'),
        deadline(),
      ),
    ).rejects.toMatchObject({ kind: 'too-large' });
    for (const mime of [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/zip',
      'application/x-msdownload',
      'message/rfc822',
    ]) {
      await expect(
        readAttachmentContent(content(Buffer.from('text'), mime), deadline()),
      ).rejects.toMatchObject({ kind: 'unsupported' });
    }
  });
});

function content(
  bytes: Uint8Array,
  mime: string,
  charset: string | null = null,
): AttachmentContent {
  return { bytes, mime, name: 'attachment', charset, declaredSize: bytes.byteLength };
}

function deadline(): { deadlineMs: number } {
  return { deadlineMs: 60_000 };
}

function minimalPdf(text: string): Buffer {
  const escaped = text.replace(/[()\\]/g, '\\$&');
  const stream = text ? `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET` : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source, 'binary');
}
