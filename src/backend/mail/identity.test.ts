import { describe, expect, it } from 'vitest';

import {
  accountHash,
  accountUid,
  isLegacyMirrorFileName,
  mirrorCollisionSuffix,
  mirrorFileName,
} from './identity';

describe('mail identity', () => {
  it('normalises only the host in account UIDs', () => {
    expect(accountUid('IMAP.Example.COM', 993, 'Case.Sensitive')).toBe(
      'imap:imap.example.com:993:Case.Sensitive',
    );
  });

  it('uses stable account hashes and readable timestamped mirror filenames', () => {
    const uid = accountUid('imap.example.com', 993, 'user@example.com');
    const receivedAt = new Date('2026-09-06T12:34:56.789Z');
    expect(accountHash(uid)).toBe('4a4afa1af5d1d4ab0691c75115dead81');
    expect(mirrorFileName('Quarterly results: Q3/Q4?', null, receivedAt)).toBe(
      'Quarterly results- Q3-Q4 -- 2026-09-06 12-34-56Z.md',
    );
    expect(mirrorFileName(null, 'Sender <sender@example.test>', receivedAt)).toBe(
      'sender@example.test -- 2026-09-06 12-34-56Z.md',
    );
    expect(
      mirrorFileName(
        'Quarterly results',
        null,
        receivedAt,
        mirrorCollisionSuffix(uid, 'uid:INBOX:123:456'),
      ),
    ).toBe('Quarterly results -- 2026-09-06 12-34-56Z -- a38352.md');
    expect(mirrorCollisionSuffix(uid, 'uid:INBOX:123:456')).not.toBe(
      mirrorCollisionSuffix(uid, 'uid:INBOX:123:457'),
    );
    expect(isLegacyMirrorFileName('a383522d27c5834a8f9950ba0c7d0029.md')).toBe(true);
    expect(isLegacyMirrorFileName('Quarterly results -- a383522d27c.md')).toBe(false);
  });
});
