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
import {
  dispatchExplore,
  dispatchListing,
  dispatchSearch,
  mergeListing,
  type SiloSearchResult,
} from './search-merge';
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

describe('date listing dispatch and merge', () => {
  it('does not need embeddings, skips unavailable managers and sums totals', async () => {
    const first = vi.fn(async () => ({
      total: 2,
      results: [
        {
          filePath: 'C:\\mail\\one.md',
          dateMs: 2000,
          score: 1,
          scoreLabel: 'date',
          signals: { date: 1 },
        },
      ],
    }));
    const second = vi.fn(async () => ({ total: 3, results: [] }));
    const skipped = vi.fn();
    const managers = [
      ['mail', { isAvailable: true, listByDate: first } as unknown as SiloManager],
      ['notes', { isAvailable: true, listByDate: second } as unknown as SiloManager],
      ['offline', { isAvailable: false, listByDate: skipped } as unknown as SiloManager],
    ] as Array<[string, SiloManager]>;

    const listing = await dispatchListing({ dateFromMs: 1000 }, managers);

    expect(listing.total).toBe(5);
    expect(listing.raw).toEqual([
      expect.objectContaining({ siloName: 'mail', filePath: 'C:\\mail\\one.md' }),
    ]);
    expect(first).toHaveBeenCalledWith({ dateFromMs: 1000 });
    expect(skipped).not.toHaveBeenCalled();
  });

  it('orders by date, silo and path before applying the global page', () => {
    const result = (dateMs: number, siloName: string, filePath: string): SiloSearchResult => ({
      filePath,
      siloName,
      dateMs,
      score: 1,
      scoreLabel: 'date',
      signals: { date: 1 },
    });
    const raw = [
      result(1000, 'beta', 'b.md'),
      result(2000, 'beta', 'z.md'),
      result(2000, 'alpha', 'z.md'),
      result(2000, 'alpha', 'a.md'),
    ];

    expect(mergeListing(raw, 1, 2).map((item) => [item.siloName, item.filePath])).toEqual([
      ['alpha', 'z.md'],
      ['beta', 'z.md'],
    ]);
  });
});
