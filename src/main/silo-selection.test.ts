import { describe, expect, it, vi } from 'vitest';
import type { SiloManager } from '../backend/silo-manager';
import { selectSilos, siloWarnings, toSiloNames } from './silo-selection';

function fakeManager({
  stopped = false,
  available = true,
  embedding = true,
  watcherState = 'ready',
  progress,
}: {
  stopped?: boolean;
  available?: boolean;
  embedding?: boolean;
  watcherState?: 'ready' | 'indexing';
  progress?: { current: number; total: number };
} = {}): SiloManager {
  return {
    isStopped: stopped,
    isAvailable: available,
    getEmbeddingService: vi.fn(() => (embedding ? {} : null)),
    getStatus: vi.fn(async () => ({ watcherState, reconcileProgress: progress })),
  } as unknown as SiloManager;
}

describe('selectSilos', () => {
  it('selects every running available silo when names are omitted', () => {
    const alpha = fakeManager();
    const managers = new Map<string, SiloManager>([
      ['alpha', alpha],
      ['stopped', fakeManager({ stopped: true })],
      ['unavailable', fakeManager({ available: false })],
    ]);

    expect(selectSilos(managers, undefined)).toEqual([['alpha', alpha]]);
  });

  it('selects named silos in order and deduplicates them', () => {
    const alpha = fakeManager();
    const beta = fakeManager();
    const managers = new Map<string, SiloManager>([
      ['alpha', alpha],
      ['beta', beta],
    ]);

    expect(selectSilos(managers, ['beta', 'alpha', 'beta'])).toEqual([
      ['beta', beta],
      ['alpha', alpha],
    ]);
  });

  it.each([
    ['missing', fakeManager(), 'Silo "missing" not found'],
    ['stopped', fakeManager({ stopped: true }), 'Silo "stopped" is stopped'],
    [
      'unavailable',
      fakeManager({ available: false }),
      'Silo "unavailable" is temporarily unavailable.',
    ],
  ])('rejects a %s silo without returning a partial selection', (name, manager, message) => {
    const managers =
      name === 'missing'
        ? new Map<string, SiloManager>([['alpha', manager]])
        : new Map<string, SiloManager>([[name, manager]]);

    expect(() => selectSilos(managers, [name])).toThrow(message);
  });
});

describe('siloWarnings', () => {
  it('warns about a missing embedding only when the search needs one', async () => {
    const manager = fakeManager({ embedding: false });

    expect(await siloWarnings([['alpha', manager]], false)).toEqual([]);
    expect(await siloWarnings([['alpha', manager]], true)).toEqual([
      'Silo "alpha" is still initializing and not yet searchable.',
    ]);
  });

  it('always reports indexing and includes progress when available', async () => {
    const manager = fakeManager({
      embedding: false,
      watcherState: 'indexing',
      progress: { current: 12, total: 30 },
    });

    expect(await siloWarnings([['alpha', manager]], false)).toEqual([
      'Silo "alpha" is indexing (12 / 30 files) — results may be incomplete.',
    ]);
  });
});

describe('toSiloNames', () => {
  it('normalises valid request-edge values', () => {
    expect(toSiloNames(undefined)).toBeUndefined();
    expect(toSiloNames('alpha')).toEqual(['alpha']);
    expect(toSiloNames(['alpha', 'beta'])).toEqual(['alpha', 'beta']);
  });

  it('rejects malformed request-edge values', () => {
    expect(() => toSiloNames(['alpha', 1])).toThrow('Invalid silo selection');
  });
});
