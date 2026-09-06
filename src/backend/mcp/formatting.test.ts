import { describe, expect, it } from 'vitest';
import type { DirectoryResult, SearchResult } from '../../shared/types';
import {
  EXPLORE_DESCRIPTION,
  formatExploreResults,
  formatListingHeader,
  formatSearchResults,
  SEARCH_DESCRIPTION,
} from './formatting';
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
      'Silo: notes (s1) | Score: 82% (semantic) | Date: 21 December 2025, 07:15',
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
    expect(SEARCH_DESCRIPTION).toContain('Omit query');
    expect(SEARCH_DESCRIPTION).toContain('offset');
  });

  it('omits scores for date listing results without changing ranked results', () => {
    const puid = new PuidManager();
    const dateMs = new Date(2025, 11, 21, 7, 15).getTime();
    const listingResult = {
      ...result(dateMs),
      score: 1,
      scoreLabel: 'date',
      signals: { date: 1 },
    };

    expect(formatSearchResults([listingResult], puid)).toContain(
      'Silo: notes (s1) | Date: 21 December 2025, 07:15',
    );
    expect(formatSearchResults([listingResult], puid)).not.toContain('Score:');
    expect(formatSearchResults([result(dateMs)], puid)).toContain('Score: 82% (semantic)');
  });
});

describe('listing header formatting', () => {
  it('formats an empty two-sided window', () => {
    expect(formatListingHeader(0, 0, 0, '2026-08-01', '2026-08-31')).toBe(
      'No files dated 2026-08-01 to 2026-08-31.',
    );
  });

  it('formats an offset past the total with a since-only window', () => {
    expect(formatListingHeader(312, 0, 400, '2026-08-01')).toBe(
      '312 files dated on or after 2026-08-01; none at offset 400.',
    );
  });

  it('formats a complete until-only window', () => {
    expect(formatListingHeader(12, 12, 0, undefined, '2026-08-31')).toBe(
      '12 files dated on or before 2026-08-31, newest first.',
    );
  });

  it('formats a partial page with the next offset', () => {
    expect(formatListingHeader(312, 50, 50, '2026-08-01', '2026-08-31')).toBe(
      '312 files dated 2026-08-01 to 2026-08-31, showing 51\u2013100, newest first. Pass offset: 100 for the next page.',
    );
  });
});

describe('silo reference formatting', () => {
  it('uses the same reference in search and explore output', () => {
    const puid = new PuidManager();
    const directory: DirectoryResult = {
      dirPath: 'C:\\notes',
      dirName: 'notes',
      siloName: 'notes',
      score: 1,
      scoreSource: 'segment',
      axes: { segment: { best: 1, bestSignal: 'exact', signals: { exact: 1 } } },
      fileCount: 1,
      subdirCount: 0,
      depth: 0,
      children: [],
    };

    expect(formatSearchResults([result(null)], puid)).toContain('Silo: notes (s1)');
    expect(formatExploreResults([directory], false, puid)).toContain('Silo: notes (s1)');
  });

  it('documents silo names, references, and arrays for both tools', () => {
    for (const description of [SEARCH_DESCRIPTION, EXPLORE_DESCRIPTION]) {
      expect(description).toContain('s-references');
      expect(description).toContain('names or references');
      expect(description).toContain('array');
    }
  });
});
