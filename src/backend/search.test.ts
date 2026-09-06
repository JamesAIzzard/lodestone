import { describe, expect, it, vi } from 'vitest';

const signals = vi.hoisted(() => {
  const withScore = (name: string, score: number) => ({
    name,
    scoreAll: vi.fn(() => ({
      scores: new Map([['0:mail/message.md', score]]),
      hints: new Map(),
    })),
  });
  const empty = (name: string) => ({
    name,
    scoreAll: () => ({ scores: new Map(), hints: new Map() }),
  });
  return {
    semantic: withScore('semantic', 0.8),
    filepath: withScore('filepath', 0.9),
    bm25: empty('bm25'),
    regex: empty('regex'),
  };
});

vi.mock('./scorers/semantic-signal', () => ({ semanticSignal: signals.semantic }));
vi.mock('./scorers/bm25-signal', () => ({ bm25Signal: signals.bm25 }));
vi.mock('./scorers/filepath-signal', () => ({ filepathSignal: signals.filepath }));
vi.mock('./scorers/regex-signal', () => ({ regexSignal: signals.regex }));

import { search } from './search';
import { dispatchExplore, dispatchSearch } from './search-merge';
import type { SiloManager } from './silo-manager';

describe('search silo policies', () => {
  const unusedDb = {
    prepare: () => ({
      all: (...storedKeys: string[]) =>
        storedKeys.map((stored_key) => ({ stored_key, date_ms: 1234 })),
    }),
  } as unknown as Parameters<typeof search>[0];

  it('omits the filepath signal when path search is disabled', () => {
    const results = search(unusedDb, [1], {
      query: 'message',
      mode: 'hybrid',
      supportsPathSearch: false,
    });

    expect(results).toHaveLength(1);
    expect(results[0].signals).toEqual({ semantic: 0.8 });
  });

  it('returns no results in filepath mode when path search is disabled', () => {
    expect(
      search(unusedDb, [], {
        query: 'message',
        mode: 'filepath',
        supportsPathSearch: false,
      }),
    ).toEqual([]);
  });

  it('passes date bounds to every signal through the shared context', () => {
    search(unusedDb, [1], {
      query: 'message',
      mode: 'semantic',
      dateFromMs: 1000,
      dateToMs: 2000,
    });

    expect(signals.semantic.scoreAll).toHaveBeenLastCalledWith(
      expect.objectContaining({ dateFromMs: 1000, dateToMs: 2000 }),
    );
  });

  it('does not dispatch search or explore calls to an unavailable manager', async () => {
    const searchManager = vi.fn();
    const exploreManager = vi.fn();
    const manager = {
      isAvailable: false,
      search: searchManager,
      exploreDirectories: exploreManager,
    } as unknown as SiloManager;

    await expect(
      dispatchSearch({ query: 'message', mode: 'filepath' }, [['mail', manager]], null),
    ).resolves.toEqual([]);
    await expect(dispatchExplore({ query: 'mail' }, [['mail', manager]])).resolves.toEqual([]);
    expect(searchManager).not.toHaveBeenCalled();
    expect(exploreManager).not.toHaveBeenCalled();
  });
});
