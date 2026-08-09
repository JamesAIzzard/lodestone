import { describe, expect, it } from 'vitest';
import { getInstructionsNoteStatus } from './llm-instructions-note';
import type { SearchResult } from '../../shared/types';

function result(filePath: string): SearchResult {
  return {
    filePath,
    siloName: 'workspace',
    score: 1,
    scoreLabel: 'filepath',
    signals: { filepath: 1 },
  };
}

describe('getInstructionsNoteStatus', () => {
  it('reports unset when no path is configured', () => {
    expect(getInstructionsNoteStatus(undefined, false, [])).toBe('unset');
  });

  it('reports checking before availability results return', () => {
    expect(getInstructionsNoteStatus('C:\\Notes\\Instructions.md', false, [])).toBe('checking');
  });

  it('matches Windows paths without case sensitivity', () => {
    expect(
      getInstructionsNoteStatus('C:\\Notes\\Instructions.md', true, [
        result('c:\\notes\\instructions.md'),
      ]),
    ).toBe('available');
  });

  it('reports unavailable when indexed search cannot find the exact path', () => {
    expect(
      getInstructionsNoteStatus('C:\\Notes\\Instructions.md', true, [
        result('C:\\Notes\\Another Note.md'),
      ]),
    ).toBe('unavailable');
  });
});
