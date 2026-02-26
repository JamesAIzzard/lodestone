import { describe, it, expect } from 'vitest';
import { parseFlexibleDate, parseRecurrence, advanceRecurrence } from './date-parser';

// Use a fixed reference date for deterministic tests: Wednesday, 2026-03-04
const REF = new Date(2026, 2, 4); // March 4, 2026 (Wed)

describe('parseFlexibleDate', () => {
  it('parses ISO 8601 dates', () => {
    expect(parseFlexibleDate('2026-03-15', REF)).toBe('2026-03-15');
    expect(parseFlexibleDate('2026-01-01', REF)).toBe('2026-01-01');
  });

  it('rejects invalid ISO 8601 dates', () => {
    expect(parseFlexibleDate('2026-02-30', REF)).toBeNull();
    expect(parseFlexibleDate('2026-13-01', REF)).toBeNull();
  });

  it('parses "today"', () => {
    expect(parseFlexibleDate('today', REF)).toBe('2026-03-04');
  });

  it('parses "tomorrow"', () => {
    expect(parseFlexibleDate('tomorrow', REF)).toBe('2026-03-05');
  });

  it('parses "yesterday"', () => {
    expect(parseFlexibleDate('yesterday', REF)).toBe('2026-03-03');
  });

  it('parses "end of month"', () => {
    expect(parseFlexibleDate('end of month', REF)).toBe('2026-03-31');
  });

  it('parses "start of month"', () => {
    expect(parseFlexibleDate('start of month', REF)).toBe('2026-03-01');
  });

  it('parses "next week" as next Monday', () => {
    // REF is Wed March 4 → next Monday is March 9
    expect(parseFlexibleDate('next week', REF)).toBe('2026-03-09');
  });

  it('parses "in N days"', () => {
    expect(parseFlexibleDate('in 3 days', REF)).toBe('2026-03-07');
    expect(parseFlexibleDate('in 1 day', REF)).toBe('2026-03-05');
  });

  it('parses "in N weeks"', () => {
    expect(parseFlexibleDate('in 2 weeks', REF)).toBe('2026-03-18');
  });

  it('parses "N days ago"', () => {
    expect(parseFlexibleDate('3 days ago', REF)).toBe('2026-03-01');
  });

  it('parses "next <day>"', () => {
    // REF is Wed → next Friday is March 6
    expect(parseFlexibleDate('next Friday', REF)).toBe('2026-03-06');
    // next Monday is March 9
    expect(parseFlexibleDate('next Monday', REF)).toBe('2026-03-09');
  });

  it('parses "last <day>"', () => {
    // REF is Wed → last Monday is March 2
    expect(parseFlexibleDate('last Monday', REF)).toBe('2026-03-02');
    // last Friday is Feb 27
    expect(parseFlexibleDate('last Friday', REF)).toBe('2026-02-27');
  });

  it('parses bare day name as next occurrence', () => {
    // REF is Wed → "Friday" means this Friday (March 6)
    expect(parseFlexibleDate('Friday', REF)).toBe('2026-03-06');
    // "Monday" means next Monday (March 9)
    expect(parseFlexibleDate('Monday', REF)).toBe('2026-03-09');
  });

  it('parses "Month Day" format', () => {
    expect(parseFlexibleDate('March 15', REF)).toBe('2026-03-15');
    expect(parseFlexibleDate('January 1', REF)).toBe('2026-01-01');
  });

  it('parses "Month Day Year" format', () => {
    expect(parseFlexibleDate('March 15 2026', REF)).toBe('2026-03-15');
    expect(parseFlexibleDate('December 25, 2026', REF)).toBe('2026-12-25');
  });

  it('parses "Day Month Year" format', () => {
    expect(parseFlexibleDate('15 Mar 2026', REF)).toBe('2026-03-15');
    expect(parseFlexibleDate('1 January 2026', REF)).toBe('2026-01-01');
  });

  it('parses abbreviated month names', () => {
    expect(parseFlexibleDate('Jan 15', REF)).toBe('2026-01-15');
    expect(parseFlexibleDate('Sep 1', REF)).toBe('2026-09-01');
  });

  it('is case insensitive', () => {
    expect(parseFlexibleDate('TODAY', REF)).toBe('2026-03-04');
    expect(parseFlexibleDate('Next monday', REF)).toBe('2026-03-09');
    expect(parseFlexibleDate('MARCH 15', REF)).toBe('2026-03-15');
  });

  it('returns null for unparseable input', () => {
    expect(parseFlexibleDate('', REF)).toBeNull();
    expect(parseFlexibleDate('not a date', REF)).toBeNull();
    expect(parseFlexibleDate('42', REF)).toBeNull();
  });

  it('handles "eom" shorthand', () => {
    expect(parseFlexibleDate('eom', REF)).toBe('2026-03-31');
  });
});

// ── Recurrence Parsing ──────────────────────────────────────────────────────

describe('parseRecurrence', () => {
  it('parses keyword rules', () => {
    expect(parseRecurrence('daily')).toBe('daily');
    expect(parseRecurrence('weekly')).toBe('weekly');
    expect(parseRecurrence('biweekly')).toBe('biweekly');
    expect(parseRecurrence('monthly')).toBe('monthly');
    expect(parseRecurrence('yearly')).toBe('yearly');
  });

  it('parses "every weekday"', () => {
    expect(parseRecurrence('every weekday')).toBe('every weekday');
    expect(parseRecurrence('weekdays')).toBe('every weekday');
  });

  it('parses "every <dayname>" and normalizes', () => {
    expect(parseRecurrence('every Monday')).toBe('every monday');
    expect(parseRecurrence('every fri')).toBe('every friday');
    expect(parseRecurrence('every TUES')).toBe('every tuesday');
  });

  it('parses "every N days/weeks"', () => {
    expect(parseRecurrence('every 3 days')).toBe('every 3 days');
    expect(parseRecurrence('every 2 weeks')).toBe('every 2 weeks');
    expect(parseRecurrence('every 1 day')).toBe('every 1 days');
  });

  it('is case insensitive', () => {
    expect(parseRecurrence('DAILY')).toBe('daily');
    expect(parseRecurrence('Every Monday')).toBe('every monday');
    expect(parseRecurrence('EVERY 5 DAYS')).toBe('every 5 days');
  });

  it('rejects invalid input', () => {
    expect(parseRecurrence('')).toBeNull();
    expect(parseRecurrence('not a rule')).toBeNull();
    expect(parseRecurrence('every 0 days')).toBeNull();
    expect(parseRecurrence('every blurb')).toBeNull();
    expect(parseRecurrence('42')).toBeNull();
  });
});

// ── Recurrence Advancement ──────────────────────────────────────────────────

describe('advanceRecurrence', () => {
  // REF is Wednesday, 2026-03-04

  it('advances daily past today', () => {
    // March 1 is in the past → should advance to March 4
    expect(advanceRecurrence('2026-03-01', 'daily', REF)).toBe('2026-03-04');
  });

  it('keeps future dates unchanged', () => {
    // March 10 is in the future → no change
    expect(advanceRecurrence('2026-03-10', 'daily', REF)).toBe('2026-03-10');
  });

  it('advances weekly', () => {
    // Feb 23 (Mon) + weekly steps: Mar 2, Mar 9 → first >= Mar 4 is Mar 9
    expect(advanceRecurrence('2026-02-23', 'weekly', REF)).toBe('2026-03-09');
  });

  it('advances biweekly', () => {
    // Feb 4 + 14 = Feb 18, + 14 = Mar 4 → lands on today
    expect(advanceRecurrence('2026-02-04', 'biweekly', REF)).toBe('2026-03-04');
  });

  it('advances monthly with day clamping', () => {
    // Jan 31 monthly: Feb → clamped to Feb 28, Mar 28, ... first >= Mar 4 is Mar 28
    // Actually: Jan 31 → Feb 28 (past) → Mar 28 (future, >= Mar 4) ✓
    expect(advanceRecurrence('2026-01-31', 'monthly', REF)).toBe('2026-03-28');
  });

  it('advances yearly with leap year handling', () => {
    // 2024-02-29 yearly: 2025 → Feb 28, 2026 → Feb 28 (past) → 2027 → Feb 28
    // Wait: REF is Mar 4 2026, so Feb 28 2026 is past → advance to Feb 28 2027
    expect(advanceRecurrence('2024-02-29', 'yearly', REF)).toBe('2027-02-28');
  });

  it('advances "every weekday" skipping weekends', () => {
    // March 3 (Tue) is past → advance: Wed Mar 4 (today, >= today) ✓
    expect(advanceRecurrence('2026-03-03', 'every weekday', REF)).toBe('2026-03-04');
    // Friday March 6 → advance from Friday skips Sat/Sun → Monday March 9
    // But Mar 6 is in the future so no advance needed
    expect(advanceRecurrence('2026-03-06', 'every weekday', REF)).toBe('2026-03-06');
  });

  it('advances "every weekday" from Friday past weekend', () => {
    // Feb 27 (Fri) is past → next weekday: Mar 2 (Mon, past) → Mar 3 (Tue, past) → Mar 4 (Wed, today) ✓
    expect(advanceRecurrence('2026-02-27', 'every weekday', REF)).toBe('2026-03-04');
  });

  it('advances "every monday"', () => {
    // Feb 23 (Mon) is past → next Mon: Mar 2 (past) → Mar 9 (future) ✓
    expect(advanceRecurrence('2026-02-23', 'every monday', REF)).toBe('2026-03-09');
  });

  it('advances "every 3 days"', () => {
    // Feb 28 + 3 = Mar 3 (past) + 3 = Mar 6 (future, >= Mar 4) ✓
    expect(advanceRecurrence('2026-02-28', 'every 3 days', REF)).toBe('2026-03-06');
  });

  it('advances "every 2 weeks"', () => {
    // Feb 4 + 14 = Feb 18 (past) + 14 = Mar 4 (today) ✓
    expect(advanceRecurrence('2026-02-04', 'every 2 weeks', REF)).toBe('2026-03-04');
  });

  it('handles far-past dates catching up', () => {
    // Jan 1 daily → should catch up to Mar 4
    expect(advanceRecurrence('2026-01-01', 'daily', REF)).toBe('2026-03-04');
  });

  it('advances monthly from the 15th', () => {
    // Jan 15 monthly → Feb 15 (past) → Mar 15 (future, >= Mar 4) ✓
    expect(advanceRecurrence('2026-01-15', 'monthly', REF)).toBe('2026-03-15');
  });
});
