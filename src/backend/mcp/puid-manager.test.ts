import { describe, expect, it } from 'vitest';
import { PuidManager } from './puid-manager';

describe('silo puids', () => {
  it('assigns sequential references idempotently per silo name', () => {
    const puid = new PuidManager();

    expect(puid.assignSiloPuid('alpha')).toBe('s1');
    expect(puid.assignSiloPuid('beta')).toBe('s2');
    expect(puid.assignSiloPuid('alpha')).toBe('s1');
    expect(puid.resolveSiloPuid('s1')).toBe('alpha');
    expect(puid.resolveSiloPuid('s9')).toBeUndefined();
  });

  it('recognises only complete s-prefixed numeric references', () => {
    expect(PuidManager.isSiloPuid('s12')).toBe(true);
    expect(PuidManager.isSiloPuid('s')).toBe(false);
    expect(PuidManager.isSiloPuid('r1')).toBe(false);
    expect(PuidManager.isSiloPuid('s1x')).toBe(false);
  });
});
