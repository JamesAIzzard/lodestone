import { useState, useRef } from 'react';
import { Calendar, ChevronDown, ChevronLeft, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useClickOutside } from '@/hooks/use-click-outside';
import { CalendarGrid, getTodayStr, formatDate } from '@/components/TaskCells';

// ── Date utilities ────────────────────────────────────────────────────────────

export type DatePreset = 'all' | 'today' | 'tomorrow' | '7d' | '30d' | 'custom';

export function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  return Math.round(Math.abs(db.getTime() - da.getTime()) / 86400000);
}

/** Auto-pick a date between two bounds: middle if odd gap, earlier if even or no gap. */
export function pickCrossDate(earlier: string, later: string): string {
  const diff = daysBetween(earlier, later);
  if (diff <= 1) return earlier;
  if (diff % 2 === 0) return addDays(earlier, diff / 2);
  return earlier;
}

const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: 'all', label: 'All dates' },
  { value: 'today', label: 'Today' },
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: '7d', label: 'Next 7 days' },
  { value: '30d', label: 'Next 30 days' },
];

export function getDateRange(
  preset: DatePreset,
  customFrom: string | null,
  customTo: string | null,
): { start: string | null; end: string | null } {
  const today = getTodayStr();
  switch (preset) {
    case 'all': return { start: null, end: null };
    case 'today': return { start: today, end: today };
    case 'tomorrow': { const d = addDays(today, 1); return { start: d, end: d }; }
    case '7d': return { start: today, end: addDays(today, 6) };
    case '30d': return { start: today, end: addDays(today, 29) };
    case 'custom': return { start: customFrom, end: customTo };
  }
}

function dateRangeLabel(preset: DatePreset, customFrom: string | null, customTo: string | null): string {
  if (preset !== 'custom') return DATE_PRESETS.find(p => p.value === preset)!.label;
  if (customFrom && customTo) return `${formatDate(customFrom)} – ${formatDate(customTo)}`;
  if (customFrom) return `From ${formatDate(customFrom)}`;
  if (customTo) return `Until ${formatDate(customTo)}`;
  return 'All dates';
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DateRangeFilter({
  preset,
  customFrom,
  customTo,
  onPreset,
  onCustomFrom,
  onCustomTo,
}: {
  preset: DatePreset;
  customFrom: string | null;
  customTo: string | null;
  onPreset: (p: DatePreset) => void;
  onCustomFrom: (v: string | null) => void;
  onCustomTo: (v: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState<'from' | 'to' | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => { setOpen(false); setPicking(null); }, open);

  const label = dateRangeLabel(preset, customFrom, customTo);
  const isActive = preset !== 'all';

  function selectPreset(p: DatePreset) {
    onPreset(p);
    if (p !== 'custom') { onCustomFrom(null); onCustomTo(null); }
    setOpen(false);
    setPicking(null);
  }

  function startPicking(field: 'from' | 'to') {
    setPicking(field);
  }

  function handleDatePick(date: string | null) {
    if (picking === 'from') onCustomFrom(date);
    else onCustomTo(date);
    onPreset('custom');
    setPicking(null);
  }

  const pickingValue = picking === 'from' ? customFrom : customTo;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => { setOpen(!open); setPicking(null); }}
        className={cn(
          'flex items-center gap-1.5 h-6 px-2 rounded-md border text-xs transition-colors',
          isActive
            ? 'border-primary/30 bg-primary/5 text-foreground'
            : 'border-transparent text-muted-foreground hover:text-foreground',
        )}
      >
        <Calendar className="h-3 w-3" />
        <span>{label}</span>
        <ChevronDown className={cn('h-3 w-3 opacity-50 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-56 rounded-md border border-border bg-background shadow-lg select-none">
          {picking ? (
            /* Calendar picker mode */
            <div className="p-3">
              <div className="flex items-center gap-2 mb-3">
                <button
                  onMouseDown={(e) => { e.preventDefault(); setPicking(null); }}
                  className="h-5 w-5 flex items-center justify-center rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="text-xs font-medium text-foreground">
                  {picking === 'from' ? 'From date' : 'To date'}
                </span>
              </div>
              <CalendarGrid
                value={pickingValue}
                onSelect={handleDatePick}
              />
            </div>
          ) : (
            /* Main mode: presets + custom date rows */
            <div>
              <div className="py-1">
                {DATE_PRESETS.map((p) => (
                  <button
                    key={p.value}
                    onMouseDown={(e) => { e.preventDefault(); selectPreset(p.value); }}
                    className={cn(
                      'flex items-center w-full px-3 py-1.5 text-left text-xs transition-colors',
                      preset === p.value
                        ? 'text-foreground font-medium bg-accent/50'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="border-t border-border/50 px-3 py-2 space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-muted-foreground w-8">From</span>
                  <button
                    onMouseDown={(e) => { e.preventDefault(); startPicking('from'); }}
                    className="flex-1 h-6 rounded border border-border/60 px-2 text-[11px] text-left hover:bg-accent transition-colors"
                  >
                    {customFrom ? formatDate(customFrom) : <span className="text-muted-foreground/30">—</span>}
                  </button>
                  {customFrom && (
                    <button
                      onMouseDown={(e) => {
                        e.preventDefault();
                        onCustomFrom(null);
                        if (!customTo) onPreset('all');
                      }}
                      className="h-4 w-4 flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-muted-foreground w-8">To</span>
                  <button
                    onMouseDown={(e) => { e.preventDefault(); startPicking('to'); }}
                    className="flex-1 h-6 rounded border border-border/60 px-2 text-[11px] text-left hover:bg-accent transition-colors"
                  >
                    {customTo ? formatDate(customTo) : <span className="text-muted-foreground/30">—</span>}
                  </button>
                  {customTo && (
                    <button
                      onMouseDown={(e) => {
                        e.preventDefault();
                        onCustomTo(null);
                        if (!customFrom) onPreset('all');
                      }}
                      className="h-4 w-4 flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
