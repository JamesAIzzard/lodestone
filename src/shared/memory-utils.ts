/**
 * Shared memory utility functions — pure, portable, no Node.js/Electron deps.
 *
 * These functions are used by both the desktop MemoryManager and will be
 * reused by the Cloudflare Worker in the Task & Memory migration (Phase 1).
 */

import type { MemoryStatusValue } from './types';

// ── Date Formatting ─────────────────────────────────────────────────────────

/** Format a Date as ISO 8601 date string (YYYY-MM-DD). */
export function formatDateISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── Status / CompletedOn Sync ───────────────────────────────────────────────

/**
 * Sync status and completedOn so they stay consistent:
 *   - completedOn set         → status forced to 'completed'
 *   - status='completed'      → completedOn auto-filled to today if not provided
 *   - status='open'           → completedOn cleared to null
 *   - completedOn=null        → status cleared to null (if not explicitly set)
 */
export function syncStatusAndCompletedOn(
  status: MemoryStatusValue | null | undefined,
  completedOn: string | null | undefined,
): { status: MemoryStatusValue | null | undefined; completedOn: string | null | undefined } {
  const today = formatDateISO(new Date());
  let s = status;
  let co = completedOn;

  if (co !== undefined && co !== null) {
    // completedOn being set → must be completed
    s = 'completed';
  } else if (s === 'completed') {
    // status=completed but no completedOn provided → auto-fill today
    if (co === undefined) co = today;
  } else if (s === 'open') {
    // Reopening → clear completedOn
    co = null;
  } else if (co === null && s === undefined) {
    // Clearing completedOn without setting status → clear status too
    s = null;
  }

  return { status: s, completedOn: co };
}
