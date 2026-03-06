import { useState, useEffect, useRef } from 'react';
import {
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleDot,
  CircleCheck,
  CircleAlert,
  CircleMinus,
  Repeat,
  SkipForward,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MemoryStatusValue, PriorityLevel, MemoryRecord } from '../../shared/types';

// ── Helpers ────────────────────────────────────────────────────────────────

export function getTodayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isOverdue(task: MemoryRecord): boolean {
  if (!task.actionDate) return false;
  if (task.status === 'completed' || task.completedOn) return false;
  if (task.status === 'cancelled' || task.status === 'blocked') return false;
  return task.actionDate < getTodayStr();
}

export function formatDate(dateStr: string | null): string {
  if (!dateStr) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr + 'T00:00:00');
  const diffDays = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays === -1) return 'Yesterday';
  const currentYear = new Date().getFullYear();
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() !== currentYear && { year: 'numeric' }),
  });
}

export const STATUS_COLORS: Record<string, string> = {
  open: 'text-amber-400',
  in_progress: 'text-blue-400',
  completed: 'text-emerald-400',
  blocked: 'text-red-400',
  cancelled: 'text-muted-foreground/40',
};

export const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  completed: 'Done',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
};

export const STATUS_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  open: Circle,
  in_progress: CircleDot,
  completed: CircleCheck,
  blocked: CircleAlert,
  cancelled: CircleMinus,
};

export const PRIORITY_DOT_COLORS: Record<number, string> = {
  1: 'bg-muted-foreground/30',
  2: 'bg-sky-400',
  3: 'bg-amber-400',
  4: 'bg-red-400',
};

export const PRIORITY_LABELS: Record<number, string> = {
  1: 'Low',
  2: 'Medium',
  3: 'High',
  4: 'Critical',
};

// ── InlineDropdown ─────────────────────────────────────────────────────────

export function InlineDropdown<T extends string | number>({
  options,
  onSelect,
  onClose,
}: {
  options: { value: T; label: string; className?: string; icon?: React.ReactNode; divider?: boolean }[];
  onSelect: (value: T) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute left-0 top-full mt-0.5 z-50 min-w-[110px] rounded-md border border-border bg-background shadow-md py-1"
    >
      {options.map((opt, i) => (
        <div key={i}>
          {opt.divider && <div className="my-1 border-t border-border/50" />}
          <button
            onMouseDown={(e) => { e.preventDefault(); onSelect(opt.value); onClose(); }}
            className={cn(
              'flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs hover:bg-accent transition-colors',
              opt.className ?? 'text-foreground',
            )}
          >
            {opt.icon}
            {opt.label}
          </button>
        </div>
      ))}
    </div>
  );
}

// ── StatusCell ─────────────────────────────────────────────────────────────

const SKIP_SENTINEL = '__skip__' as unknown as MemoryStatusValue;
const MEMORY_SENTINEL = '__memory__' as unknown as MemoryStatusValue;

function statusIcon(status: MemoryStatusValue | null, className?: string) {
  const Icon = status ? STATUS_ICONS[status] : Circle;
  return <Icon className={className} />;
}

export function StatusCell({
  value,
  onChange,
  isRecurring,
  onSkip,
}: {
  value: MemoryStatusValue | null;
  onChange: (v: MemoryStatusValue | null) => void;
  isRecurring?: boolean;
  onSkip?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const colorClass = value ? STATUS_COLORS[value] : 'text-muted-foreground/20';
  const isCompleted = value === 'completed';

  const iconSize = 'h-3.5 w-3.5';

  const options: { value: MemoryStatusValue; label: string; className?: string; icon?: React.ReactNode; divider?: boolean }[] = [
    { value: 'open' as MemoryStatusValue, label: 'Open', className: 'text-amber-400', icon: <Circle className={iconSize} /> },
    { value: 'in_progress' as MemoryStatusValue, label: 'In Progress', className: 'text-blue-400', icon: <CircleDot className={iconSize} /> },
    { value: 'completed' as MemoryStatusValue, label: 'Done', className: 'text-emerald-400', icon: <CircleCheck className={iconSize} /> },
    { value: 'blocked' as MemoryStatusValue, label: 'Blocked', className: 'text-red-400', icon: <CircleAlert className={iconSize} /> },
    ...(isRecurring ? [{ value: SKIP_SENTINEL, label: 'Skip', className: 'text-violet-400', icon: <SkipForward className={iconSize} /> }] : []),
    { value: 'cancelled' as MemoryStatusValue, label: 'Cancelled', className: 'text-muted-foreground/40', icon: <CircleMinus className={iconSize} /> },
    { value: MEMORY_SENTINEL, label: 'Memory', className: 'text-muted-foreground/60', icon: <BookOpen className={iconSize} />, divider: true },
  ];

  function handleQuickToggle() {
    onChange(isCompleted ? 'open' as MemoryStatusValue : 'completed' as MemoryStatusValue);
  }

  return (
    <div className="relative shrink-0 w-12">
      <div className="h-5 flex items-center">
        {/* Left: quick-complete toggle */}
        <button
          onClick={handleQuickToggle}
          title={isCompleted ? 'Reopen' : 'Complete'}
          className={cn(
            'flex items-center justify-center h-full w-6 rounded-l border border-r-0 transition-colors',
            isCompleted
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
              : cn('border-border/40', colorClass, 'hover:text-emerald-400 hover:bg-accent'),
          )}
        >
          {statusIcon(value, 'h-3.5 w-3.5')}
        </button>

        {/* Right: dropdown trigger */}
        <button
          onClick={() => setOpen(!open)}
          title="Change status"
          className={cn(
            'flex items-center justify-center h-full w-5 rounded-r border transition-colors',
            isCompleted
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400/60 hover:text-emerald-400 hover:bg-emerald-500/20'
              : 'border-border/40 text-muted-foreground/30 hover:text-muted-foreground hover:bg-accent',
          )}
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>

      {open && (
        <InlineDropdown
          options={options}
          onSelect={(v) => {
            if (v === SKIP_SENTINEL) onSkip?.();
            else if (v === MEMORY_SENTINEL) onChange(null);
            else onChange(v);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

// ── PriorityCell ───────────────────────────────────────────────────────────

const PRIORITY_NONE = '__none__' as unknown as PriorityLevel;

function priorityDot(level: PriorityLevel | null, size = 'h-2 w-2') {
  return <span className={cn(size, 'rounded-sm shrink-0', level ? PRIORITY_DOT_COLORS[level] : 'bg-muted-foreground/20')} />;
}

const PRIORITY_OPTIONS: { value: PriorityLevel; label: string; className: string }[] = [
  { value: 4 as PriorityLevel, label: 'Critical', className: 'text-red-400' },
  { value: 3 as PriorityLevel, label: 'High', className: 'text-amber-400' },
  { value: 2 as PriorityLevel, label: 'Medium', className: 'text-sky-400' },
  { value: 1 as PriorityLevel, label: 'Low', className: 'text-muted-foreground/60' },
];

export function PriorityCell({
  value,
  onChange,
}: {
  value: PriorityLevel | null;
  onChange: (v: PriorityLevel | null) => void;
}) {
  const [open, setOpen] = useState(false);

  const options = [
    { value: PRIORITY_NONE, label: 'None', className: 'text-muted-foreground/40', icon: priorityDot(null) },
    ...PRIORITY_OPTIONS.map(o => ({ ...o, value: o.value as typeof PRIORITY_NONE, icon: priorityDot(o.value) })),
  ];

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen(!open)}
        title={value ? PRIORITY_LABELS[value] : 'No priority'}
        className="flex items-center justify-center h-5 w-5 rounded border border-transparent hover:border-border/60 transition-colors"
      >
        {priorityDot(value)}
      </button>
      {open && (
        <InlineDropdown
          options={options}
          onSelect={(v) => onChange(v === PRIORITY_NONE ? null : v as PriorityLevel)}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

// ── CalendarPicker ─────────────────────────────────────────────────────────

export function CalendarPicker({
  value,
  onSelect,
  onClose,
}: {
  value: string | null;
  onSelect: (v: string | null) => void;
  onClose: () => void;
}) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const initial = value ? new Date(value + 'T00:00:00') : new Date();
  const [year, setYear] = useState(initial.getFullYear());
  const [month, setMonth] = useState(initial.getMonth());
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [onClose]);

  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  function toStr(d: number) {
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  function prev() {
    if (month === 0) { setYear(y => y - 1); setMonth(11); }
    else setMonth(m => m - 1);
  }

  function next() {
    if (month === 11) { setYear(y => y + 1); setMonth(0); }
    else setMonth(m => m + 1);
  }

  const monthLabel = new Date(year, month).toLocaleString('en-GB', { month: 'long' });

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-1 z-50 w-56 rounded-md border border-border bg-background shadow-lg p-3 select-none"
    >
      <div className="flex items-center justify-between mb-2">
        <button
          onMouseDown={(e) => { e.preventDefault(); prev(); }}
          className="h-6 w-6 flex items-center justify-center rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <span className="text-xs font-medium text-foreground">{monthLabel} {year}</span>
        <button
          onMouseDown={(e) => { e.preventDefault(); next(); }}
          className="h-6 w-6 flex items-center justify-center rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-7 mb-1">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <div key={i} className="h-6 flex items-center justify-center text-[10px] text-muted-foreground/40 font-medium">
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-y-0.5">
        {cells.map((d, i) =>
          d === null ? <div key={i} /> : (
            <button
              key={i}
              onMouseDown={(e) => { e.preventDefault(); onSelect(toStr(d)); onClose(); }}
              className={cn(
                'h-6 w-full flex items-center justify-center text-[11px] rounded transition-colors',
                toStr(d) === value
                  ? 'bg-primary text-primary-foreground font-semibold'
                  : toStr(d) === todayStr
                    ? 'text-primary font-medium hover:bg-accent'
                    : 'text-foreground hover:bg-accent',
              )}
            >
              {d}
            </button>
          )
        )}
      </div>

      {value && (
        <div className="mt-2 pt-2 border-t border-border/60">
          <button
            onMouseDown={(e) => { e.preventDefault(); onSelect(null); onClose(); }}
            className="w-full text-[11px] text-muted-foreground hover:text-foreground transition-colors py-0.5 rounded hover:bg-accent"
          >
            Clear date
          </button>
        </div>
      )}
    </div>
  );
}

// ── DateCell ───────────────────────────────────────────────────────────────

export function DateCell({
  value,
  overdue,
  onChange,
}: {
  value: string | null;
  overdue: boolean;
  onChange: (v: string | null) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative shrink-0 w-20">
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'h-5 w-full rounded px-1.5 text-[11px] border border-transparent hover:border-border/60 transition-colors tabular-nums flex items-center justify-center',
          overdue ? 'text-amber-400' : value ? 'text-muted-foreground' : 'text-muted-foreground/30',
        )}
      >
        {value ? formatDate(value) : '—'}
      </button>
      {open && (
        <CalendarPicker
          value={value}
          onSelect={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

// ── RecurrenceCell ─────────────────────────────────────────────────────────

const RECURRENCE_NONE = '__none__';
const RECURRENCE_CUSTOM = '__custom__';

const RECURRENCE_PRESETS: { value: string; label: string; className: string }[] = [
  { value: RECURRENCE_NONE, label: '— None', className: 'text-muted-foreground/40' },
  { value: 'daily', label: 'Daily', className: 'text-violet-400' },
  { value: 'weekly', label: 'Weekly', className: 'text-violet-400' },
  { value: 'biweekly', label: 'Biweekly', className: 'text-violet-400' },
  { value: 'monthly', label: 'Monthly', className: 'text-violet-400' },
  { value: 'yearly', label: 'Yearly', className: 'text-violet-400' },
  { value: RECURRENCE_CUSTOM, label: 'Custom\u2026', className: 'text-muted-foreground' },
];

function formatRecurrenceLabel(value: string | null): string {
  if (!value) return '—';
  const preset = RECURRENCE_PRESETS.find(p => p.value === value);
  if (preset) return preset.label;
  // Capitalize first letter of custom values like "every monday"
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function RecurrenceCell({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const [customValue, setCustomValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (customMode && inputRef.current) inputRef.current.focus();
  }, [customMode]);

  function handlePresetSelect(v: string) {
    if (v === RECURRENCE_NONE) {
      onChange(null);
    } else if (v === RECURRENCE_CUSTOM) {
      setCustomMode(true);
      setCustomValue('');
    } else {
      onChange(v);
    }
  }

  function commitCustom() {
    const trimmed = customValue.trim().toLowerCase();
    if (trimmed) onChange(trimmed);
    setCustomMode(false);
    setCustomValue('');
    setOpen(false);
  }

  const label = formatRecurrenceLabel(value);

  return (
    <div className="relative shrink-0 w-20">
      <button
        onClick={() => { setOpen(!open); setCustomMode(false); }}
        className={cn(
          'h-5 w-full rounded px-1.5 text-[11px] border border-transparent hover:border-border/60 transition-colors flex items-center gap-1',
          value ? 'text-violet-400' : 'text-muted-foreground/30',
        )}
      >
        <Repeat className="h-2.5 w-2.5 shrink-0" />
        <span className="truncate">{label}</span>
      </button>
      {open && !customMode && (
        <InlineDropdown
          options={RECURRENCE_PRESETS}
          onSelect={handlePresetSelect}
          onClose={() => setOpen(false)}
        />
      )}
      {open && customMode && (
        <CustomRecurrenceInput
          value={customValue}
          inputRef={inputRef}
          onChange={setCustomValue}
          onCommit={commitCustom}
          onClose={() => { setCustomMode(false); setOpen(false); }}
        />
      )}
    </div>
  );
}

function CustomRecurrenceInput({
  value,
  inputRef,
  onChange,
  onCommit,
  onClose,
}: {
  value: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onChange: (v: string) => void;
  onCommit: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute left-0 top-full mt-0.5 z-50 min-w-[180px] rounded-md border border-border bg-background shadow-md p-2"
    >
      <p className="text-[10px] text-muted-foreground/60 mb-1.5">
        e.g. every 3 days, every monday
      </p>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); onCommit(); }
          if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        }}
        className="w-full h-6 px-2 text-xs rounded border border-border bg-background text-foreground outline-none focus:border-primary/60"
        placeholder="every 2 weeks"
      />
    </div>
  );
}
