/**
 * Flexible date parser for memory action dates and recurrence rules.
 *
 * Accepts various date expressions and normalises them to ISO 8601 (YYYY-MM-DD).
 * Used for the `action_date` field on memories and date-range filters in recall.
 *
 * Supported date formats:
 *   - ISO 8601: "2026-03-15"
 *   - Relative: "today", "tomorrow", "yesterday"
 *   - Named days: "Monday", "next Monday", "last Friday"
 *   - Offsets: "in 3 days", "in 2 weeks"
 *   - Month expressions: "end of month", "start of month"
 *   - Natural: "March 15", "15 Mar 2026", "March 15 2026"
 *
 * Supported recurrence rules:
 *   - Keywords: "daily", "weekly", "biweekly", "monthly", "yearly"
 *   - Day-specific: "every monday", "every weekday"
 *   - Intervals: "every 3 days", "every 2 weeks"
 */

// ── Day name mapping ─────────────────────────────────────────────────────────

const DAY_NAMES: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const MONTH_NAMES: Record<string, number> = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Get the next occurrence of a weekday (0=Sun .. 6=Sat) on or after `from`. */
function nextWeekday(from: Date, targetDay: number): Date {
  const d = new Date(from);
  const diff = (targetDay - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + (diff === 0 ? 7 : diff));
  return d;
}

/** Get the most recent past occurrence of a weekday (0=Sun .. 6=Sat) before `from`. */
function lastWeekday(from: Date, targetDay: number): Date {
  const d = new Date(from);
  const diff = (d.getDay() - targetDay + 7) % 7;
  d.setDate(d.getDate() - (diff === 0 ? 7 : diff));
  return d;
}

/** Get the last day of the month for a given date. */
function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

/** Get the first day of the month for a given date. */
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

// ── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse a flexible date expression into ISO 8601 (YYYY-MM-DD).
 *
 * @param input  The date expression to parse.
 * @param now    Reference date for relative expressions (defaults to current date).
 * @returns ISO 8601 date string, or null if the expression cannot be parsed.
 */
export function parseFlexibleDate(input: string, now?: Date): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const ref = now ?? new Date();
  // Work with a clean date (no time component issues)
  const today = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const lower = trimmed.toLowerCase();

  // ── ISO 8601: YYYY-MM-DD ─────────────────────────────────────────────
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    // Validate it's a real date
    const [y, m, d] = trimmed.split('-').map(Number);
    const parsed = new Date(y, m - 1, d);
    if (parsed.getFullYear() === y && parsed.getMonth() === m - 1 && parsed.getDate() === d) {
      return trimmed;
    }
    return null;
  }

  // ── Simple relative keywords ─────────────────────────────────────────
  if (lower === 'today') return formatDate(today);

  if (lower === 'tomorrow') {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return formatDate(d);
  }

  if (lower === 'yesterday') {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    return formatDate(d);
  }

  // ── "end of month" / "start of month" ────────────────────────────────
  if (lower === 'end of month' || lower === 'eom') {
    return formatDate(endOfMonth(today));
  }
  if (lower === 'start of month' || lower === 'som') {
    return formatDate(startOfMonth(today));
  }

  // ── "next week" / "last week" ────────────────────────────────────────
  if (lower === 'next week') {
    return formatDate(nextWeekday(today, 1)); // next Monday
  }
  if (lower === 'last week') {
    return formatDate(lastWeekday(today, 1)); // last Monday
  }

  // ── "in N days/weeks" ────────────────────────────────────────────────
  const inMatch = lower.match(/^in\s+(\d+)\s+(day|days|week|weeks)$/);
  if (inMatch) {
    const n = parseInt(inMatch[1], 10);
    const unit = inMatch[2].startsWith('week') ? 7 : 1;
    const d = new Date(today);
    d.setDate(d.getDate() + n * unit);
    return formatDate(d);
  }

  // ── "N days/weeks ago" ───────────────────────────────────────────────
  const agoMatch = lower.match(/^(\d+)\s+(day|days|week|weeks)\s+ago$/);
  if (agoMatch) {
    const n = parseInt(agoMatch[1], 10);
    const unit = agoMatch[2].startsWith('week') ? 7 : 1;
    const d = new Date(today);
    d.setDate(d.getDate() - n * unit);
    return formatDate(d);
  }

  // ── "next <dayname>" ─────────────────────────────────────────────────
  const nextDayMatch = lower.match(/^next\s+(\w+)$/);
  if (nextDayMatch) {
    const dayNum = DAY_NAMES[nextDayMatch[1]];
    if (dayNum !== undefined) {
      return formatDate(nextWeekday(today, dayNum));
    }
  }

  // ── "last <dayname>" ─────────────────────────────────────────────────
  const lastDayMatch = lower.match(/^last\s+(\w+)$/);
  if (lastDayMatch) {
    const dayNum = DAY_NAMES[lastDayMatch[1]];
    if (dayNum !== undefined) {
      return formatDate(lastWeekday(today, dayNum));
    }
  }

  // ── Bare day name (= next occurrence) ────────────────────────────────
  const bareDayNum = DAY_NAMES[lower];
  if (bareDayNum !== undefined) {
    return formatDate(nextWeekday(today, bareDayNum));
  }

  // ── "Month Day" or "Month Day Year" (e.g. "March 15", "March 15 2026")
  const monthDayMatch = lower.match(/^(\w+)\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?$/);
  if (monthDayMatch) {
    const monthNum = MONTH_NAMES[monthDayMatch[1]];
    if (monthNum !== undefined) {
      const day = parseInt(monthDayMatch[2], 10);
      const year = monthDayMatch[3] ? parseInt(monthDayMatch[3], 10) : today.getFullYear();
      const d = new Date(year, monthNum, day);
      if (d.getMonth() === monthNum && d.getDate() === day) {
        return formatDate(d);
      }
    }
  }

  // ── "Day Month Year" (e.g. "15 Mar 2026", "15 March") ───────────────
  const dayMonthMatch = lower.match(/^(\d{1,2})\s+(\w+)(?:\s+(\d{4}))?$/);
  if (dayMonthMatch) {
    const monthNum = MONTH_NAMES[dayMonthMatch[2]];
    if (monthNum !== undefined) {
      const day = parseInt(dayMonthMatch[1], 10);
      const year = dayMonthMatch[3] ? parseInt(dayMonthMatch[3], 10) : today.getFullYear();
      const d = new Date(year, monthNum, day);
      if (d.getMonth() === monthNum && d.getDate() === day) {
        return formatDate(d);
      }
    }
  }

  return null;
}

// ── Recurrence ──────────────────────────────────────────────────────────────

/** Canonical day names indexed by JS day number (0=Sun). */
const CANONICAL_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Simple recurrence keywords that need no further parsing. */
const RECURRENCE_KEYWORDS = new Set(['daily', 'weekly', 'biweekly', 'monthly', 'yearly']);

/**
 * Parse and normalize a recurrence rule expression.
 *
 * @param input  The recurrence expression to parse.
 * @returns Normalized recurrence string, or null if invalid.
 */
export function parseRecurrence(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();

  // Simple keywords
  if (RECURRENCE_KEYWORDS.has(lower)) return lower;

  // "every weekday"
  if (lower === 'every weekday' || lower === 'weekdays') return 'every weekday';

  // "every <dayname>"
  const everyDayMatch = lower.match(/^every\s+(\w+)$/);
  if (everyDayMatch) {
    const dayNum = DAY_NAMES[everyDayMatch[1]];
    if (dayNum !== undefined) {
      return `every ${CANONICAL_DAYS[dayNum]}`;
    }
  }

  // "every N days/weeks"
  const everyNMatch = lower.match(/^every\s+(\d+)\s+(day|days|week|weeks)$/);
  if (everyNMatch) {
    const n = parseInt(everyNMatch[1], 10);
    if (n <= 0) return null;
    const unit = everyNMatch[2].startsWith('week') ? 'weeks' : 'days';
    return `every ${n} ${unit}`;
  }

  return null;
}

/**
 * Advance a date by one step of the recurrence rule.
 *
 * For monthly: clamps day to end-of-month (e.g. Jan 31 → Feb 28).
 * For yearly: clamps Feb 29 to Feb 28 in non-leap years.
 */
function advanceOneStep(d: Date, rule: string): Date {
  const result = new Date(d);

  if (rule === 'daily') {
    result.setDate(result.getDate() + 1);
    return result;
  }

  if (rule === 'weekly') {
    result.setDate(result.getDate() + 7);
    return result;
  }

  if (rule === 'biweekly') {
    result.setDate(result.getDate() + 14);
    return result;
  }

  if (rule === 'monthly') {
    const origDay = d.getDate();
    result.setMonth(result.getMonth() + 1, 1); // go to 1st of next month
    const maxDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
    result.setDate(Math.min(origDay, maxDay));
    return result;
  }

  if (rule === 'yearly') {
    const origMonth = d.getMonth();
    const origDay = d.getDate();
    result.setFullYear(result.getFullYear() + 1, origMonth, 1);
    const maxDay = new Date(result.getFullYear(), origMonth + 1, 0).getDate();
    result.setDate(Math.min(origDay, maxDay));
    return result;
  }

  if (rule === 'every weekday') {
    result.setDate(result.getDate() + 1);
    while (result.getDay() === 0 || result.getDay() === 6) {
      result.setDate(result.getDate() + 1);
    }
    return result;
  }

  // "every <dayname>"
  const everyDayMatch = rule.match(/^every\s+(\w+)$/);
  if (everyDayMatch) {
    const dayNum = DAY_NAMES[everyDayMatch[1]];
    if (dayNum !== undefined) {
      result.setDate(result.getDate() + 1);
      while (result.getDay() !== dayNum) {
        result.setDate(result.getDate() + 1);
      }
      return result;
    }
  }

  // "every N days/weeks"
  const everyNMatch = rule.match(/^every\s+(\d+)\s+(days|weeks)$/);
  if (everyNMatch) {
    const n = parseInt(everyNMatch[1], 10);
    const mult = everyNMatch[2] === 'weeks' ? 7 : 1;
    result.setDate(result.getDate() + n * mult);
    return result;
  }

  // Fallback: advance by 1 day (shouldn't reach here with valid rules)
  result.setDate(result.getDate() + 1);
  return result;
}

/**
 * Advance a recurring action date to the next valid occurrence >= today.
 *
 * Given a (possibly stale) action date and a recurrence rule, steps forward
 * until the result is on or after `now`. Used by orient() to auto-advance
 * past recurring deadlines.
 *
 * @param actionDate  The current action date (ISO 8601 YYYY-MM-DD).
 * @param rule        Normalized recurrence rule (from parseRecurrence).
 * @param now         Reference date (defaults to current date).
 * @returns The next valid occurrence as ISO 8601 YYYY-MM-DD.
 */
export function advanceRecurrence(actionDate: string, rule: string, now?: Date): string {
  const ref = now ?? new Date();
  const today = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());

  const [y, m, d] = actionDate.split('-').map(Number);
  let current = new Date(y, m - 1, d);

  // Safety: cap iterations to prevent infinite loops on malformed rules
  const MAX_ITERATIONS = 10000;
  let i = 0;

  while (current < today && i < MAX_ITERATIONS) {
    current = advanceOneStep(current, rule);
    i++;
  }

  return formatDate(current);
}
