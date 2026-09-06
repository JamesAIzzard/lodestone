export type DateBoundEdge = 'from' | 'to';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?$/i;

function invalidBound(edge: DateBoundEdge): Error {
  const name = edge === 'from' ? 'since' : 'until';
  return new Error(`Invalid ${name}: expected YYYY-MM-DD or an ISO 8601 date-time.`);
}

function validDateParts(year: number, month: number, day: number): boolean {
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1];
}

function localDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): Date {
  const result = new Date(0);
  result.setFullYear(year, month - 1, day);
  result.setHours(hour, minute, second, millisecond);
  return result;
}

/** Parse one client-facing date bound into an inclusive epoch-millisecond edge. */
export function parseDateBound(value: string, edge: DateBoundEdge): number {
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    const [, yearText, monthText, dayText] = dateOnly;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    if (!validDateParts(year, month, day)) throw invalidBound(edge);

    const start = localDate(year, month, day);
    if (edge === 'from') return start.getTime();
    const nextDay = new Date(start);
    nextDay.setDate(nextDay.getDate() + 1);
    return nextDay.getTime() - 1;
  }

  const dateTime = DATE_TIME.exec(value);
  if (!dateTime) throw invalidBound(edge);

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, zone] =
    dateTime;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText ?? '0');
  const millisecond = Number((fraction ?? '').padEnd(3, '0').slice(0, 3) || '0');

  if (!validDateParts(year, month, day) || hour > 23 || minute > 59 || second > 59) {
    throw invalidBound(edge);
  }

  if (!zone) return localDate(year, month, day, hour, minute, second, millisecond).getTime();

  if (zone.toUpperCase() !== 'Z') {
    const [offsetHour, offsetMinute] = zone.slice(1).split(':').map(Number);
    if (offsetHour > 23 || offsetMinute > 59) throw invalidBound(edge);
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw invalidBound(edge);
  return parsed;
}

/** Parse an optional inclusive date window, rejecting inverted bounds. */
export function parseDateWindow(
  since?: string,
  until?: string,
): { dateFromMs?: number; dateToMs?: number } {
  const dateFromMs = since === undefined ? undefined : parseDateBound(since, 'from');
  const dateToMs = until === undefined ? undefined : parseDateBound(until, 'to');
  if (dateFromMs !== undefined && dateToMs !== undefined && dateFromMs > dateToMs) {
    throw new Error('Invalid date window: since must be on or before until.');
  }
  return { dateFromMs, dateToMs };
}
