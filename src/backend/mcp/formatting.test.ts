import { describe, expect, it } from 'vitest';
import type { SearchResult } from '../../shared/types';
import { formatSearchResults, SEARCH_DESCRIPTION } from './formatting';
import { PuidManager } from './puid-manager';

function result(dateMs: number | null): SearchResult {
  return {
    filePath: 'C:\\notes\\result.md',
    siloName: 'notes',
    dateMs,
    score: 0.82,
    scoreLabel: 'semantic',
    signals: { semantic: 0.82 },
  };
}

describe('search result formatting', () => {
  it('shows a result date in local time', () => {
    const dateMs = new Date(2025, 11, 21, 7, 15).getTime();

    expect(formatSearchResults([result(dateMs)], new PuidManager())).toContain(
      'Silo: notes | Score: 82% (semantic) | Date: 21 December 2025, 07:15',
    );
  });

  it('omits the date label when the stored date is null', () => {
    expect(formatSearchResults([result(null)], new PuidManager())).not.toContain(' | Date:');
  });

  it('documents the inclusive date bounds and their meaning', () => {
    expect(SEARCH_DESCRIPTION).toContain('since and until');
    expect(SEARCH_DESCRIPTION).toContain('received time');
    expect(SEARCH_DESCRIPTION).toContain('last modified time');
    expect(SEARCH_DESCRIPTION).toContain('lodestone_get_datetime');
  });
});
