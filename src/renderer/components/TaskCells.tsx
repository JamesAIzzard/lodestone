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
  Folder,
  Repeat,
  SkipForward,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MemoryStatusValue, PriorityLevel, MemoryRecord, ProjectWithCounts } from '../../shared/types';
import { SILO_COLOR_MAP, type SiloColor } from '../../shared/silo-appearance';

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

export function isPastDue(task: MemoryRecord): boolean {
  if (!task.dueDate) return false;
  if (task.status === 'completed' || task.completedOn) return false;
  if (task.status === 'cancelled') return false;
  return task.dueDate < getTodayStr();
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
  1: 'bg-muted-foreground/40',
  2: 'bg-sky-400',
  3: 'bg-amber-400',
};

export const PRIORITY_LABELS: Record<number, string> = {
  1: 'Low',
  2: 'Medium',
  3: 'High',
};

// ── InlineDropdown ─────────────────────────────────────────────────────────

export function InlineDropdown<T extends string | number>({
  options,
  onSelect,
  onClose,
}: {
  options: { value: T; label: string; className?: string; icon?: React.ReactNode; divider?: boolean; keepOpen?: boolean }[];
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
            onMouseDown={(e) => { e.preventDefault(); onSelect(opt.value); if (!opt.keepOpen) onClose(); }}
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

// ── CellDropdown ───────────────────────────────────────────────────────────
// Shared wrapper for all cell popovers: manages open state, renders the
// relative container, and delegates trigger + content via render props.

export function CellDropdown({
  trigger,
  children,
  containerClassName,
}: {
  trigger: (toggle: () => void) => React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  containerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const toggle = () => setOpen(o => !o);
  return (
    <div className={cn('relative shrink-0', containerClassName)}>
      {trigger(toggle)}
      {open && children(close)}
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
    <CellDropdown
      containerClassName="w-12"
      trigger={(toggle) => (
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
            onClick={toggle}
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
      )}
    >
      {(close) => (
        <InlineDropdown
          options={options}
          onSelect={(v) => {
            if (v === SKIP_SENTINEL) onSkip?.();
            else if (v === MEMORY_SENTINEL) onChange(null);
            else onChange(v);
          }}
          onClose={close}
        />
      )}
    </CellDropdown>
  );
}

// ── PriorityCell ───────────────────────────────────────────────────────────

const PRIORITY_NONE = '__none__' as unknown as PriorityLevel;

function PriorityDots({ level }: { level: PriorityLevel | null }) {
  const filled = Math.min(level ?? 0, 3);
  const fillColor = level ? (PRIORITY_DOT_COLORS[Math.min(level, 3)] ?? 'bg-muted-foreground/40') : '';
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3].map(i => (
        <span
          key={i}
          className={cn('h-1.5 w-1.5 rounded-full', i <= filled ? fillColor : 'bg-muted-foreground/15')}
        />
      ))}
    </div>
  );
}

const PRIORITY_OPTIONS: { value: PriorityLevel; label: string; className: string }[] = [
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
  const options = [
    ...PRIORITY_OPTIONS.map(o => ({ ...o, value: o.value as typeof PRIORITY_NONE, icon: <PriorityDots level={o.value} /> })),
    { value: PRIORITY_NONE, label: 'None', className: 'text-muted-foreground/40', icon: <PriorityDots level={null} />, divider: true },
  ];

  return (
    <CellDropdown
      containerClassName="w-6"
      trigger={(toggle) => (
        <button
          onClick={toggle}
          title={value ? PRIORITY_LABELS[value] : 'No priority'}
          className="flex items-center justify-center h-5 w-full rounded border border-transparent hover:border-border/60 transition-colors"
        >
          <PriorityDots level={value} />
        </button>
      )}
    >
      {(close) => (
        <InlineDropdown
          options={options}
          onSelect={(v) => onChange(v === PRIORITY_NONE ? null : v as PriorityLevel)}
          onClose={close}
        />
      )}
    </CellDropdown>
  );
}

// ── CalendarGrid (shared day-picker used by CalendarPicker & DateRangeFilter) ──

export function CalendarGrid({
  value,
  onSelect,
  showClear = true,
}: {
  value: string | null;
  onSelect: (v: string | null) => void;
  showClear?: boolean;
}) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const initial = value ? new Date(value + 'T00:00:00') : new Date();
  const [year, setYear] = useState(initial.getFullYear());
  const [month, setMonth] = useState(initial.getMonth());

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

  function goToday() {
    const now = new Date();
    setYear(now.getFullYear());
    setMonth(now.getMonth());
  }

  const monthLabel = new Date(year, month).toLocaleString('en-GB', { month: 'long' });

  return (
    <>
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
              onMouseDown={(e) => { e.preventDefault(); onSelect(toStr(d)); }}
              className={cn(
                'h-6 w-full flex items-center justify-center text-[11px] rounded transition-colors',
                toStr(d) === value
                  ? 'bg-primary text-primary-foreground font-semibold'
                  : toStr(d) === todayStr
                    ? 'ring-1 ring-primary/50 text-primary font-medium hover:bg-accent'
                    : 'text-foreground hover:bg-accent',
              )}
            >
              {d}
            </button>
          )
        )}
      </div>

      <div className="mt-2 pt-2 border-t border-border/60 flex items-center gap-2">
        <button
          onMouseDown={(e) => { e.preventDefault(); goToday(); onSelect(todayStr); }}
          className="text-[11px] text-primary hover:text-primary/80 transition-colors py-0.5 font-medium"
        >
          Today
        </button>
        {showClear && value && (
          <button
            onMouseDown={(e) => { e.preventDefault(); onSelect(null); }}
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors py-0.5 ml-auto"
          >
            Clear
          </button>
        )}
      </div>
    </>
  );
}

// ── CalendarPicker (popup wrapper around CalendarGrid) ─────────────────────

export function CalendarPicker({
  value,
  onSelect,
  onClose,
}: {
  value: string | null;
  onSelect: (v: string | null) => void;
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
      className="absolute right-0 top-full mt-1 z-50 w-56 rounded-md border border-border bg-background shadow-lg p-3 select-none"
    >
      <CalendarGrid
        value={value}
        onSelect={(v) => { onSelect(v); onClose(); }}
      />
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
  return (
    <CellDropdown containerClassName="w-[72px]" trigger={(toggle) => (
      <button
        onClick={toggle}
        className={cn(
          'h-5 w-full rounded px-1.5 text-[11px] border border-transparent hover:border-border/60 transition-colors tabular-nums flex items-center justify-center',
          overdue ? 'text-amber-400' : value ? 'text-muted-foreground' : 'text-muted-foreground/30',
        )}
      >
        {value ? formatDate(value) : '—'}
      </button>
    )}>
      {(close) => <CalendarPicker value={value} onSelect={onChange} onClose={close} />}
    </CellDropdown>
  );
}

// ── DueDateCell ───────────────────────────────────────────────────────────

export function DueDateCell({
  value,
  pastDue,
  onChange,
}: {
  value: string | null;
  pastDue: boolean;
  onChange: (v: string | null) => void;
}) {
  return (
    <CellDropdown containerClassName="w-[72px]" trigger={(toggle) => (
      <button
        onClick={toggle}
        className={cn(
          'h-5 w-full rounded px-1.5 text-[11px] border border-transparent hover:border-border/60 transition-colors tabular-nums flex items-center justify-center',
          pastDue ? 'text-red-400' : value ? 'text-muted-foreground' : 'text-muted-foreground/30',
        )}
      >
        {value ? formatDate(value) : '\u2014'}
      </button>
    )}>
      {(close) => <CalendarPicker value={value} onSelect={onChange} onClose={close} />}
    </CellDropdown>
  );
}

// ── RecurrenceCell ─────────────────────────────────────────────────────────

const RECURRENCE_NONE = '__none__';
const RECURRENCE_CUSTOM = '__custom__';

const RECURRENCE_PRESETS: { value: string; label: string; className: string; divider?: boolean; keepOpen?: boolean }[] = [
  { value: 'daily', label: 'Daily', className: 'text-violet-400' },
  { value: 'weekly', label: 'Weekly', className: 'text-violet-400' },
  { value: 'biweekly', label: 'Biweekly', className: 'text-violet-400' },
  { value: 'monthly', label: 'Monthly', className: 'text-violet-400' },
  { value: 'yearly', label: 'Yearly', className: 'text-violet-400' },
  { value: RECURRENCE_CUSTOM, label: 'Custom\u2026', className: 'text-muted-foreground', keepOpen: true },
  { value: RECURRENCE_NONE, label: 'None', className: 'text-muted-foreground/40', divider: true },
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
  const [customMode, setCustomMode] = useState(false);
  const [customValue, setCustomValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (customMode && inputRef.current) inputRef.current.focus();
  }, [customMode]);

  function handlePresetSelect(v: string) {
    if (v === RECURRENCE_NONE) onChange(null);
    else if (v === RECURRENCE_CUSTOM) { setCustomMode(true); setCustomValue(''); }
    else onChange(v);
  }

  function commitCustom(close: () => void) {
    const trimmed = customValue.trim().toLowerCase();
    if (trimmed) onChange(trimmed);
    setCustomMode(false);
    setCustomValue('');
    close();
  }

  const label = formatRecurrenceLabel(value);

  return (
    <CellDropdown
      containerClassName="w-[72px]"
      trigger={(toggle) => (
        <button
          onClick={() => { toggle(); setCustomMode(false); }}
          className={cn(
            'h-5 w-full rounded px-1.5 text-[11px] border border-transparent hover:border-border/60 transition-colors flex items-center gap-1',
            value ? 'text-violet-400' : 'text-muted-foreground/30',
          )}
        >
          <Repeat className="h-2.5 w-2.5 shrink-0" />
          <span className="truncate">{label}</span>
        </button>
      )}
    >
      {(close) => customMode
        ? (
          <CustomRecurrenceInput
            value={customValue}
            inputRef={inputRef}
            onChange={setCustomValue}
            onCommit={() => commitCustom(close)}
            onClose={() => { setCustomMode(false); close(); }}
          />
        ) : (
          <InlineDropdown
            options={RECURRENCE_PRESETS}
            onSelect={handlePresetSelect}
            onClose={close}
          />
        )
      }
    </CellDropdown>
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

// ── ProjectCell ────────────────────────────────────────────────────────────

const PROJECT_NONE = '__none__';

function projectIcon(color: string, size = 'h-3.5 w-3.5') {
  const mapping = SILO_COLOR_MAP[color as SiloColor];
  return <Folder className={cn(size, 'shrink-0', mapping?.text ?? 'text-muted-foreground/40')} />;
}

export function ProjectCell({
  value,
  projects,
  onChange,
}: {
  value: number | null;
  projects: ProjectWithCounts[];
  onChange: (projectId: number | null) => void;
}) {
  const current = value ? projects.find(p => p.id === value) : null;

  const options = [
    ...projects.map(p => ({
      value: String(p.id),
      label: p.name,
      className: SILO_COLOR_MAP[p.color as SiloColor]?.text ?? 'text-foreground',
      icon: projectIcon(p.color),
    })),
    { value: PROJECT_NONE, label: 'None', className: 'text-muted-foreground/40', icon: projectIcon(''), divider: true },
  ];

  return (
    <CellDropdown
      containerClassName="w-24"
      trigger={(toggle) => (
        <button
          onClick={toggle}
          className={cn(
            'h-5 w-full rounded px-1.5 text-[11px] border border-transparent hover:border-border/60 transition-colors flex items-center gap-1.5 truncate',
            current ? (SILO_COLOR_MAP[current.color as SiloColor]?.text ?? 'text-foreground') : 'text-muted-foreground/30',
          )}
        >
          {current && projectIcon(current.color)}
          <span className="truncate">{current?.name ?? '—'}</span>
        </button>
      )}
    >
      {(close) => (
        <InlineDropdown
          options={options}
          onSelect={(v) => onChange(v === PROJECT_NONE ? null : parseInt(v, 10))}
          onClose={close}
        />
      )}
    </CellDropdown>
  );
}
