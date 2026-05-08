import { describe, expect, it } from 'vitest';
import {
  CODE_EXTENSIONS,
  DEFAULT_INDEX_EXTENSIONS,
  FILE_TYPES,
  PICKER_EXTENSIONS,
  getFileType,
} from './file-types';

describe('file type registry', () => {
  it('exposes default index extensions from file type metadata', () => {
    expect(DEFAULT_INDEX_EXTENSIONS).toEqual([
      '.md',
      '.txt',
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.py',
      '.rs',
      '.go',
      '.java',
      '.c',
      '.h',
      '.cpp',
      '.hpp',
      '.cs',
      '.rb',
      '.swift',
      '.kt',
    ]);
  });

  it('keeps picker options derived from known file types', () => {
    expect(PICKER_EXTENSIONS).toContain('.pdf');
    expect(PICKER_EXTENSIONS).toContain('.json');
    expect(PICKER_EXTENSIONS).toContain('.toml');
    expect(PICKER_EXTENSIONS).not.toContain('.markdown');
  });

  it('identifies code extensions by processor kind', () => {
    expect(CODE_EXTENSIONS).toContain('.ts');
    expect(CODE_EXTENSIONS).toContain('.py');
    expect(CODE_EXTENSIONS).not.toContain('.md');
    expect(CODE_EXTENSIONS).not.toContain('.pdf');
  });

  it('normalises extension lookups', () => {
    expect(getFileType('TS')?.extension).toBe('.ts');
    expect(getFileType('.PDF')?.processorKind).toBe('pdf');
    expect(getFileType('.unknown')).toBeUndefined();
  });

  it('declares each extension once', () => {
    const extensions = FILE_TYPES.map((type) => type.extension);
    expect(new Set(extensions).size).toBe(extensions.length);
  });
});
