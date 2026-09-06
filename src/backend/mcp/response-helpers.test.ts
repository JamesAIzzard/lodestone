import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { PuidManager } from './puid-manager';
import { resolveSiloRefs } from './response-helpers';

function firstText(result: CallToolResult): string {
  const first = result.content[0];
  return first.type === 'text' ? first.text : '';
}

describe('resolveSiloRefs', () => {
  it('normalises a name or reference to an array of names', () => {
    const puid = new PuidManager();
    puid.assignSiloPuid('alpha');

    expect(resolveSiloRefs('notes', puid)).toEqual(['notes']);
    expect(resolveSiloRefs('s1', puid)).toEqual(['alpha']);
    expect(resolveSiloRefs(undefined, puid)).toBeUndefined();
  });

  it('resolves mixed inputs and deduplicates names in input order', () => {
    const puid = new PuidManager();
    puid.assignSiloPuid('alpha');

    expect(resolveSiloRefs(['notes', 's1', 'notes', 'alpha'], puid)).toEqual(['notes', 'alpha']);
  });

  it('returns the exact error for an unknown reference', () => {
    const result = resolveSiloRefs('s9', new PuidManager()) as CallToolResult;

    expect(firstText(result)).toBe(
      'Error: Unknown silo reference "s9". Use lodestone_status to obtain a fresh reference.',
    );
  });
});
