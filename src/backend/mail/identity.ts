import { createHash } from 'node:crypto';

import type { AccountHash, AccountUid, MessageKey } from './types';

export function accountUid(host: string, port: number, username: string): AccountUid {
  return `imap:${host.toLowerCase()}:${port}:${username}`;
}

export function accountHash(uid: AccountUid): AccountHash {
  return sha256(uid).slice(0, 32);
}

export function mirrorFileName(
  subject: string | null,
  sender: string | null,
  receivedAt: Date,
  collisionSuffix?: string,
): string {
  const readable =
    sanitiseFileStem(subject) || sanitiseFileStem(senderAddress(sender)) || 'Unknown sender';
  const timestamp = Number.isNaN(receivedAt.getTime())
    ? 'Unknown date'
    : receivedAt
        .toISOString()
        .replace('T', ' ')
        .replace(/:/g, '-')
        .replace(/\.\d{3}Z$/, 'Z');
  const suffix = collisionSuffix ? ` -- ${collisionSuffix}` : '';
  return `${readable.slice(0, 120).replace(/[ .]+$/g, '') || 'No subject'} -- ${timestamp}${suffix}.md`;
}

export function mirrorCollisionSuffix(uid: AccountUid, messageKey: MessageKey): string {
  return sha256(`${uid}\n${messageKey}`).slice(0, 6);
}

export function isLegacyMirrorFileName(fileName: string): boolean {
  return /^[a-f0-9]{32}\.md$/i.test(fileName);
}

function sanitiseFileStem(value: string | null): string {
  return (value ?? '')
    .trim()
    .split('')
    .map((character) => (character.charCodeAt(0) < 32 ? '-' : character))
    .join('')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .replace(/^[ .-]+|[ .-]+$/g, '');
}

function senderAddress(value: string | null): string | null {
  if (!value) return null;
  return /<([^<>]+)>/.exec(value)?.[1]?.trim() ?? /[^\s<>]+@[^\s<>]+/.exec(value)?.[0] ?? value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
