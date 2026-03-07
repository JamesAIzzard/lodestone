import { useEffect, useRef } from 'react';
import { CalendarGrid, formatDate, getTodayStr } from '@/components/TaskCells';
import { cn } from '@/lib/utils';

/** Info about a pending cross-date drop. */
export interface PendingCrossDateDrop {
  /** The task being moved */
  taskId: number;
  /** The task's original action date */
  fromDate: string;
  /** The date of the task ABOVE the drop position (null if dropped at top) */
  upperDate: string | null;
  /** The date of the task BELOW the drop position (null if dropped at bottom) */
  lowerDate: string | null;
  /** Index within the target date group where the task should be inserted */
  insertIndex: number;
  /** Y coordinate for positioning the popover */
  anchorY: number;
}

/** Generate an array of ISO date strings between start and end (inclusive). */
function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const d = new Date(start + 'T00:00:00');
  const endD = new Date(end + 'T00:00:00');
  while (d <= endD) {
    dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

/** Count calendar days between two date strings. */
function daysBetween(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  return Math.round(Math.abs(db.getTime() - da.getTime()) / 86400000);
}

function dayOfWeek(dateStr: string): string {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short' });
}

export default function DragDatePopover({
  pending,
  onSelect,
  onCancel,
}: {
  pending: PendingCrossDateDrop;
  onSelect: (date: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const today = getTodayStr();

  // Close on outside click or Escape
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onCancel();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    // Delay attaching mousedown to avoid the drop-release closing it immediately
    const mouseTimer = setTimeout(() => document.addEventListener('mousedown', handleMouseDown), 50);
    document.addEventListener('keydown', handleKey);
    return () => {
      clearTimeout(mouseTimer);
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onCancel]);

  // Determine the date range to show
  const minDate = pending.upperDate && pending.lowerDate
    ? (pending.upperDate < pending.lowerDate ? pending.upperDate : pending.lowerDate)
    : pending.upperDate ?? pending.lowerDate ?? today;
  const maxDate = pending.upperDate && pending.lowerDate
    ? (pending.upperDate > pending.lowerDate ? pending.upperDate : pending.lowerDate)
    : pending.upperDate ?? pending.lowerDate ?? today;

  const gap = daysBetween(minDate, maxDate);
  const useCalendar = gap > 7;

  // For the date list mode, generate dates between (exclusive of boundary dates if they match the from/to)
  const dates = useCalendar ? [] : dateRange(minDate, maxDate);

  // Position: anchor near the drop position, offset to the right
  const style: React.CSSProperties = {
    position: 'fixed',
    top: Math.max(80, pending.anchorY - 40),
    right: 24,
    zIndex: 100,
  };

  return (
    <div
      ref={ref}
      style={style}
      className="w-56 rounded-md border border-border bg-background shadow-xl select-none animate-in fade-in-0 slide-in-from-right-2 duration-150"
    >
      <div className="px-3 py-2 border-b border-border/50">
        <p className="text-[11px] text-muted-foreground font-medium">Move to date</p>
      </div>

      {useCalendar ? (
        /* Large gap: full calendar */
        <div className="p-3">
          <CalendarGrid
            value={pending.fromDate}
            onSelect={(v) => { if (v) onSelect(v); }}
            showClear={false}
          />
        </div>
      ) : (
        /* Small gap: date list */
        <div className="py-1 max-h-64 overflow-y-auto">
          {dates.map((d) => {
            const isToday = d === today;
            const isFrom = d === pending.fromDate;
            return (
              <button
                key={d}
                onClick={() => onSelect(d)}
                className={cn(
                  'flex items-center w-full px-3 py-1.5 text-left text-xs transition-colors gap-2',
                  isFrom
                    ? 'text-muted-foreground/40 cursor-default'
                    : 'text-foreground hover:bg-accent cursor-pointer',
                )}
                disabled={isFrom}
              >
                <span className={cn(
                  'w-8 shrink-0 text-[11px] tabular-nums',
                  isToday ? 'text-primary font-semibold' : 'text-muted-foreground',
                )}>
                  {dayOfWeek(d)}
                </span>
                <span className={cn(
                  'flex-1',
                  isToday && 'text-primary font-medium',
                  isFrom && 'line-through',
                )}>
                  {formatDate(d)}
                </span>
                {isFrom && (
                  <span className="text-[10px] text-muted-foreground/30">current</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
