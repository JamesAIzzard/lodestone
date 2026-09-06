import { describe, expect, it } from 'vitest';
import { parseDateBound, parseDateWindow } from './date-bounds';

const INVALID_SINCE = 'Invalid since: expected YYYY-MM-DD or an ISO 8601 date-time.';

describe('date bounds', () => {
  it('uses local day edges for date-only values', () => {
    expect(parseDateBound('2026-08-01', 'from')).toBe(new Date(2026, 7, 1).getTime());
    expect(parseDateBound('2026-08-01', 'to')).toBe(new Date(2026, 7, 2).getTime() - 1);
  });

  it('preserves the instant in zoned ISO date-times', () => {
    const value = '2026-08-01T12:34:56.789+02:00';
    expect(parseDateBound(value, 'from')).toBe(Date.parse(value));
    expect(parseDateBound(value, 'to')).toBe(Date.parse(value));
  });

  it('treats unzoned ISO date-times as local time', () => {
    expect(parseDateBound('2026-08-01T12:34:56.789', 'from')).toBe(
      new Date(2026, 7, 1, 12, 34, 56, 789).getTime(),
    );
  });

  it.each(['2026-13-01', 'yesterday', '', '2026-08-01T25:00', '2026-02-30'])(
    'rejects invalid value %j',
    (value) => {
      expect(() => parseDateBound(value, 'from')).toThrow(INVALID_SINCE);
    },
  );

  it('names the invalid upper bound in its error', () => {
    expect(() => parseDateBound('not-a-date', 'to')).toThrow(
      'Invalid until: expected YYYY-MM-DD or an ISO 8601 date-time.',
    );
  });

  it('rejects a since bound later than until', () => {
    expect(() => parseDateWindow('2026-08-02', '2026-08-01')).toThrow(
      'Invalid date window: since must be on or before until.',
    );
  });
});
