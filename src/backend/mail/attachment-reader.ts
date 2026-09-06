import { extractPdf } from '../extractors/pdf';
import { decodeBodyPart, htmlToText } from './decode';
import { MAX_ATTACHMENT_TEXT_BYTES, type AttachmentContent } from './attachment';

export type AttachmentReadResult =
  | { kind: 'text'; text: string }
  | { kind: 'image'; dataBase64: string; mimeType: string };

export type AttachmentReadErrorKind = 'unsupported' | 'encrypted' | 'too-large';

export class AttachmentReadError extends Error {
  constructor(
    public readonly kind: AttachmentReadErrorKind,
    options?: ErrorOptions,
  ) {
    super(kind, options);
    this.name = 'AttachmentReadError';
  }
}

export async function readAttachmentContent(
  content: AttachmentContent,
  options: { deadlineMs: number },
): Promise<AttachmentReadResult> {
  const mime = normaliseMime(content.mime);
  if (mime === 'application/pdf') return readPdf(content.bytes, options.deadlineMs);
  if (isRasterMime(mime)) return readRaster(content.bytes, mime);
  if (isTextMime(mime)) {
    const decoded = decodeBodyPart(content.bytes, '8bit', content.charset ?? 'utf-8');
    const text = mime === 'text/html' ? htmlToText(decoded) : decoded;
    assertTextSize(text);
    return { kind: 'text', text };
  }
  throw new AttachmentReadError('unsupported');
}

async function readPdf(bytes: Uint8Array, deadlineMs: number): Promise<AttachmentReadResult> {
  if (!hasPdfSignature(bytes)) throw new AttachmentReadError('unsupported');
  const deadline = Date.now() + deadlineMs;
  try {
    const extracted = await extractPdf(Buffer.from(bytes), () => Date.now() >= deadline);
    if (Date.now() >= deadline) throw new AttachmentReadError('too-large');
    assertTextSize(extracted.body);
    return { kind: 'text', text: extracted.body };
  } catch (error) {
    if (error instanceof AttachmentReadError) throw error;
    const details = errorDetails(error);
    if (/password|PasswordException/i.test(details)) {
      throw new AttachmentReadError('encrypted', { cause: error });
    }
    if (/cancel/i.test(details) || Date.now() >= deadline) {
      throw new AttachmentReadError('too-large', { cause: error });
    }
    throw new AttachmentReadError('unsupported', { cause: error });
  }
}

function readRaster(bytes: Uint8Array, mime: RasterMime): AttachmentReadResult {
  if (!hasRasterSignature(bytes, mime)) throw new AttachmentReadError('unsupported');
  return { kind: 'image', dataBase64: Buffer.from(bytes).toString('base64'), mimeType: mime };
}

type RasterMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

function normaliseMime(value: string): string {
  const mime = value.trim().toLowerCase();
  return mime === 'image/jpg' ? 'image/jpeg' : mime;
}

function isRasterMime(mime: string): mime is RasterMime {
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime);
}

function isTextMime(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'image/svg+xml'
  );
}

function hasPdfSignature(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 5)).toString('ascii') === '%PDF-';
}

function hasRasterSignature(bytes: Uint8Array, mime: RasterMime): boolean {
  const head = Buffer.from(bytes.subarray(0, 12));
  if (mime === 'image/png')
    return head.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (mime === 'image/jpeg') return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (mime === 'image/gif')
    return ['GIF87a', 'GIF89a'].includes(head.subarray(0, 6).toString('ascii'));
  return (
    head.subarray(0, 4).toString('ascii') === 'RIFF' &&
    head.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

function assertTextSize(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > MAX_ATTACHMENT_TEXT_BYTES) {
    throw new AttachmentReadError('too-large');
  }
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause ? ` ${errorDetails(error.cause)}` : '';
    return `${error.name} ${error.message}${cause}`;
  }
  return String(error);
}
