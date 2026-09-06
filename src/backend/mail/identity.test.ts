import { describe, expect, it } from 'vitest';

import { accountHash, accountUid, mirrorFileName } from './identity';

describe('mail identity', () => {
  it('normalises only the host in account UIDs', () => {
    expect(accountUid('IMAP.Example.COM', 993, 'Case.Sensitive')).toBe(
      'imap:imap.example.com:993:Case.Sensitive',
    );
  });

  it('uses stable truncated SHA-256 hashes', () => {
    const uid = accountUid('imap.example.com', 993, 'user@example.com');
    expect(accountHash(uid)).toBe('4a4afa1af5d1d4ab0691c75115dead81');
    expect(mirrorFileName(uid, 'uid:INBOX:123:456')).toBe('a383522d27c5834a8f9950ba0c7d0029.md');
    expect(mirrorFileName(uid, 'uid:INBOX:123:456')).not.toBe(
      mirrorFileName(uid, 'uid:INBOX:123:457'),
    );
  });
});
