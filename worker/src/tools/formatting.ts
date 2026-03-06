/**
 * Formatting helpers for the Worker MCP server.
 *
 * Portable subset of src/backend/mcp/formatting.ts — only includes
 * memory-related formatters. Silo, search result, and explore formatters
 * are omitted (no silo access in the Worker).
 */

import type { PriorityLevel, MemoryStatusValue } from '../shared/types';
import { tokenise } from '../tokeniser';

// ── Date context ─────────────────────────────────────────────────────────────

const FULL_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FULL_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT_MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDateFull(d: Date): string {
  return `${FULL_DAY_NAMES[d.getDay()]} ${d.getDate()} ${FULL_MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

function formatDateShort(d: Date): string {
  return `${FULL_DAY_NAMES[d.getDay()].slice(0, 3)} ${d.getDate()} ${SHORT_MONTH_NAMES[d.getMonth()]}`;
}

function formatTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Return a human-readable datetime string with timezone. */
export function buildDatetime(): string {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${formatDateFull(now)}, ${formatTime(now)} (${tz})`;
}

/**
 * Build a compact date reference line to prepend to orient/agenda output.
 * Anchors the LLM on today's date, current time, and key relative offsets.
 */
export function buildDateContext(): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `\ud83d\udcc5 Today: ${formatDateFull(today)}, ${formatTime(now)} (${tz}) | Yesterday: ${formatDateShort(yesterday)} | Tomorrow: ${formatDateShort(tomorrow)}`;
}

// ── Memory truncation ────────────────────────────────────────────────────────

/** Maximum characters to show in memory previews before truncating. */
export const MEMORY_PREVIEW_CHARS = 200;

/** Truncate a memory body for preview, appending ellipsis if needed. */
export function truncateMemoryBody(body: string, limit: number = MEMORY_PREVIEW_CHARS): string {
  if (body.length <= limit) return body;
  return body.slice(0, limit) + '\u2026';
}

/** Token threshold above which a body length warning is emitted. */
const MEMORY_BODY_WARN_TOKENS = 200;

/** Return a warning string if the memory body exceeds the token threshold, otherwise empty. */
export function memoryBodyWarning(body: string): string {
  const count = tokenise(body).length;
  if (count <= MEMORY_BODY_WARN_TOKENS) return '';
  return `\n\n\u26a0\ufe0f This memory is ${count} tokens \u2014 consider splitting into smaller, atomic memories that reference each other by m-id for better search precision.`;
}

/** Map priority number to human-readable label. */
export function priorityLabel(p: PriorityLevel): string {
  switch (p) {
    case 1: return 'low';
    case 2: return 'medium';
    case 3: return 'high';
    case 4: return 'critical';
  }
}

/** Map status string to a display label. */
export function statusLabel(s: MemoryStatusValue): string {
  switch (s) {
    case 'open': return 'open';
    case 'in_progress': return 'in progress';
    case 'completed': return 'completed \u2713';
    case 'blocked': return 'blocked';
    case 'cancelled': return 'cancelled';
  }
}

// ── Memory ID resolution ────────────────────────────────────────────────────

/** Resolve a memory id parameter that may be a number or m-prefixed string (e.g. "m5"). */
export function resolveMemoryId(id: number | string): number {
  if (typeof id === 'number') return id;
  if (typeof id === 'string' && /^m\d+$/i.test(id)) return parseInt(id.slice(1), 10);
  throw new Error(`Invalid memory id "${id}". Expected a number or m-prefixed id (e.g. "m5").`);
}
