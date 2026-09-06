import { convert } from 'html-to-text';

export function decodeBodyPart(bytes: Uint8Array, encoding: string, charset: string): string {
  const decodedBytes = decodeTransferEncoding(bytes, encoding);
  return normaliseLineEndings(decodeCharset(decodedBytes, charset));
}

export function htmlToText(html: string): string {
  return normaliseLineEndings(
    convert(html, {
      wordwrap: false,
      selectors: [
        { selector: 'a', options: { hideLinkHrefIfSameAsText: false, noAnchorUrl: false } },
        { selector: 'img', format: 'skip' },
        { selector: 'script', format: 'skip' },
        { selector: 'style', format: 'skip' },
      ],
    }),
  );
}

function decodeTransferEncoding(bytes: Uint8Array, encoding: string): Uint8Array {
  switch (encoding.trim().toLowerCase()) {
    case 'base64':
      return Buffer.from(Buffer.from(bytes).toString('ascii').replace(/\s/g, ''), 'base64');
    case 'quoted-printable':
      return decodeQuotedPrintable(bytes);
    default:
      return bytes;
  }
}

function decodeQuotedPrintable(bytes: Uint8Array): Uint8Array {
  const output: number[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x3d && bytes[index + 1] === 0x0d && bytes[index + 2] === 0x0a) {
      index += 2;
    } else if (bytes[index] === 0x3d && bytes[index + 1] === 0x0a) {
      index += 1;
    } else if (bytes[index] === 0x3d && isHexByte(bytes[index + 1], bytes[index + 2])) {
      output.push(Number.parseInt(String.fromCharCode(bytes[index + 1], bytes[index + 2]), 16));
      index += 2;
    } else {
      output.push(bytes[index]);
    }
  }
  return Uint8Array.from(output);
}

function isHexByte(first: number | undefined, second: number | undefined): boolean {
  return first !== undefined && second !== undefined && isHexDigit(first) && isHexDigit(second);
}

function isHexDigit(value: number): boolean {
  return (
    (value >= 0x30 && value <= 0x39) ||
    (value >= 0x41 && value <= 0x46) ||
    (value >= 0x61 && value <= 0x66)
  );
}

function decodeCharset(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

function normaliseLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}
