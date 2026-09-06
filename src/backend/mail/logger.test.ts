import { describe, expect, it, vi } from 'vitest';

import { createMailLogger } from './logger';

describe('mail logger', () => {
  it('adds the account hash and refuses possible email addresses', () => {
    const sink = vi.fn();
    const log = createMailLogger('abc123', sink);
    log('sync-finished', { outcome: 'completed' });
    expect(sink).toHaveBeenCalledWith('sync-finished', {
      account_hash: 'abc123',
      outcome: 'completed',
    });
    expect(() => log('bad', { value: 'user@example.com' })).toThrow(
      'Mail logs must not contain email addresses',
    );
    expect(sink).toHaveBeenCalledTimes(1);
  });
});
