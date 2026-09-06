import { describe, expect, it } from 'vitest';
import type { DirectoryResult, SearchResult } from '../../shared/types';
import {
  EXPLORE_DESCRIPTION,
  formatExploreResults,
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
