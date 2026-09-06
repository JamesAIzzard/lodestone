import { describe, expect, it } from 'vitest';
import type { SignalContext } from './signal';
import { passesFileFilters } from './signal';

function context(overrides: Partial<SignalContext> = {}): SignalContext {
  return {
    db: {} as SignalContext['db'],
    query: 'query',
    queryVector: [],
    queryTokens: ['query'],
    filePatternRe: null,
    maxResults: 10,
    ...overrides,
  };
}

describe('passesFileFilters', () => {
  it('applies path and pattern filters to the relative file path', () => {
    expect(passesFileFilters(context({ startPath: '0:notes/' }), '0:notes/a.md', null)).toBe(true);
    expect(passesFileFilters(context({ startPath: '0:notes/' }), '0:other/a.md', null)).toBe(false);
    expect(
      passesFileFilters(context({ filePatternRe: /^notes\/.*\.md$/ }), '0:notes/a.md', null),
    ).toBe(true);
    expect(
      passesFileFilters(context({ filePatternRe: /^notes\/.*\.md$/ }), '0:notes/a.txt', null),
    ).toBe(false);
  });

  it('treats both date bounds as inclusive', () => {
    const ctx = context({ dateFromMs: 1000, dateToMs: 2000 });

    expect(passesFileFilters(ctx, '0:a.md', 1000)).toBe(true);
    expect(passesFileFilters(ctx, '0:a.md', 2000)).toBe(true);
    expect(passesFileFilters(ctx, '0:a.md', 999)).toBe(false);
    expect(passesFileFilters(ctx, '0:a.md', 2001)).toBe(false);
  });

  it('excludes null dates only when a date bound is present', () => {
    expect(passesFileFilters(context(), '0:a.md', null)).toBe(true);
    expect(passesFileFilters(context({ dateFromMs: 1000 }), '0:a.md', null)).toBe(false);
    expect(passesFileFilters(context({ dateToMs: 2000 }), '0:a.md', null)).toBe(false);
  });

  it('combines every active filter', () => {
    const ctx = context({
      startPath: '0:notes/',
      filePatternRe: /\.md$/,
      dateFromMs: 1000,
      dateToMs: 2000,
    });

    expect(passesFileFilters(ctx, '0:notes/a.md', 1500)).toBe(true);
    expect(passesFileFilters(ctx, '0:other/a.md', 1500)).toBe(false);
    expect(passesFileFilters(ctx, '0:notes/a.txt', 1500)).toBe(false);
    expect(passesFileFilters(ctx, '0:notes/a.md', 2500)).toBe(false);
  });
});
