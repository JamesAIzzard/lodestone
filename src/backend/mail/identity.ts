import { createHash } from 'node:crypto';

import type { AccountHash, AccountUid, MessageKey } from './types';

export function accountUid(host: string, port: number, username: string): AccountUid {
  return `imap:${host.toLowerCase()}:${port}:${username}`;
}

export function accountHash(uid: AccountUid): AccountHash {
  return sha256(uid).slice(0, 32);
}

export function mirrorFileName(uid: AccountUid, messageKey: MessageKey): string {
  return `${sha256(`${uid}\n${messageKey}`).slice(0, 32)}.md`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
