import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, AlertCircle, RefreshCw, Cloud, Plus, Trash2, Merge, Search, X, Calendar, ChevronDown, ChevronLeft, Folder, FolderOpen, Archive, GripVertical } from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import ActionButton from '@/components/ActionButton';
import { cn } from '@/lib/utils';
import {
  StatusCell,
  PriorityCell,
  DateCell,
  DueDateCell,
  RecurrenceCell,
  ProjectCell,
  CalendarGrid,
  isOverdue,
  isPastDue,
  getTodayStr,
  formatDate,
} from '@/components/TaskCells';
import { SILO_COLORS, SILO_COLOR_MAP, type SiloColor } from '../../shared/silo-appearance';
import type { MemoryRecord, MemoryStatusValue, PriorityLevel, ProjectWithCounts } from '../../shared/types';

type SubView = 'tasks' | 'projects';

// ── Toggle switch ─────────────────────────────────────────────────────────────

function ToggleSwitch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none group"
    >
      <span
        className={cn(
          'relative inline-flex h-3.5 w-6 shrink-0 rounded-full border transition-colors',
          checked ? 'bg-foreground/80 border-foreground/80' : 'bg-muted border-border',
        )}
      >
        <span
          className={cn(
            'absolute top-px h-2.5 w-2.5 rounded-full bg-background shadow-sm transition-transform',
            checked ? 'translate-x-[10px]' : 'translate-x-px',
          )}
        />
      </span>
      <span className={cn('transition-colors', checked ? 'text-foreground' : 'text-muted-foreground')}>
        {label}
      </span>
    </button>
  );
}

// ── Date range filter ─────────────────────────────────────────────────────────

type DatePreset = 'all' | 'today' | 'tomorrow' | '7d' | '30d' | 'custom';

function addDays(dateStr: string, n: number): string {
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
function pickCrossDate(earlier: string, later: string): string {
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

function getDateRange(
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

function DateRangeFilter({
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
  const internalClick = useRef(false);

  useEffect(() => {
    if (!open) return;
    function handleMouseDown() {
      if (internalClick.current) { internalClick.current = false; return; }
      setOpen(false);
      setPicking(null);
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [open]);

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
    <div ref={ref} className="relative" onMouseDown={() => { internalClick.current = true; }}>
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

// ── Levenshtein distance ──────────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Best fuzzy score of query against a project name (lower = better match). */
function fuzzyScore(query: string, name: string): number {
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  if (n.includes(q)) return 0; // substring match is best
  let best = Infinity;
  // Compare against name prefixes of varying lengths (handles typos + missed/extra chars)
  for (let len = Math.max(1, q.length - 1); len <= Math.min(n.length, q.length + 2); len++) {
    best = Math.min(best, levenshtein(q, n.slice(0, len)));
  }
  // Also compare against each word in compound names (e.g. "cellular-origins")
  for (const word of n.split(/[\s\-_]+/)) {
    if (word.length < 2) continue;
    for (let len = Math.max(1, q.length - 1); len <= Math.min(word.length, q.length + 2); len++) {
      best = Math.min(best, levenshtein(q, word.slice(0, len)));
    }
  }
  return best;
}

// ── Project search filter (multi-select with pills) ──────────────────────────

function projectIcon(color: string, size = 'h-3.5 w-3.5') {
  const mapping = SILO_COLOR_MAP[color as SiloColor];
  return <Folder className={cn(size, 'shrink-0', mapping?.text ?? 'text-muted-foreground/40')} />;
}

function ProjectSearchFilter({
  projects,
  selectedIds,
  onChange,
}: {
  projects: ProjectWithCounts[];
  selectedIds: number[];
  onChange: (ids: number[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const internalClick = useRef(false);

  // Close dropdown on outside click
  useEffect(() => {
    if (!focused) return;
    function handleMouseDown() {
      if (internalClick.current) { internalClick.current = false; return; }
      setFocused(false);
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [focused]);

  // Fuzzy search: score unselected projects and keep close matches
  const q = query.trim();
  const unselected = projects.filter(p => !selectedIds.includes(p.id));
  const suggestions = q
    ? unselected
        .map(p => ({ ...p, dist: fuzzyScore(q, p.name) }))
        .filter(p => p.dist <= Math.max(2, Math.ceil(q.length * 0.4)))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 8)
    : unselected.slice(0, 8);

  const showDropdown = focused && (suggestions.length > 0 || q);

  function addProject(id: number) {
    onChange([...selectedIds, id]);
    setQuery('');
    inputRef.current?.focus();
  }

  function removeProject(id: number) {
    onChange(selectedIds.filter(x => x !== id));
  }

  const selectedProjects = selectedIds.map(id => projects.find(p => p.id === id)).filter(Boolean) as ProjectWithCounts[];

  if (selectedIds.length === 0 && !focused) {
    // Collapsed state: styled to align with the DateRangeFilter button above (same px-2 + border)
    return (
      <button
        onClick={() => { setFocused(true); setTimeout(() => inputRef.current?.focus(), 0); }}
        className="flex items-center gap-1.5 h-6 px-2 rounded-md border border-transparent text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors"
      >
        <FolderOpen className="h-3 w-3" />
        Filter by project…
      </button>
    );
  }

  return (
    <div ref={containerRef} className="relative" onMouseDown={() => { internalClick.current = true; }}>
      <div className="flex items-center gap-1.5 flex-wrap min-h-[26px] pl-2">
        {/* Selected pills */}
        {selectedProjects.map(p => {
          const colorMap = SILO_COLOR_MAP[p.color as SiloColor];
          return (
            <span
              key={p.id}
              className={cn(
                'inline-flex items-center gap-1 h-[22px] pl-1.5 pr-1 rounded-full text-[11px] font-medium border transition-colors',
                colorMap?.bgSoft ?? 'bg-muted',
                colorMap?.border ?? 'border-border/50',
                colorMap?.text ?? 'text-foreground',
              )}
            >
              {projectIcon(p.color, 'h-3 w-3')}
              <span className="max-w-[100px] truncate">{p.name}</span>
              <button
                onClick={(e) => { e.stopPropagation(); removeProject(p.id); }}
                className="h-3.5 w-3.5 flex items-center justify-center rounded-full hover:bg-foreground/10 transition-colors ml-0.5"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          );
        })}

        {/* Search input */}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setQuery(''); setFocused(false); inputRef.current?.blur(); }
            if (e.key === 'Backspace' && !query && selectedIds.length > 0) {
              removeProject(selectedIds[selectedIds.length - 1]);
            }
            if (e.key === 'Enter' && suggestions.length > 0) {
              e.preventDefault();
              addProject(suggestions[0].id);
            }
          }}
          placeholder={selectedIds.length > 0 ? 'Add project…' : 'Search projects…'}
          className="h-[22px] min-w-[80px] flex-1 bg-transparent text-[11px] text-foreground placeholder:text-muted-foreground/30 focus:outline-none"
        />

        {/* Clear all */}
        {selectedIds.length > 0 && (
          <button
            onClick={() => { onChange([]); setQuery(''); }}
            className="h-4 w-4 flex items-center justify-center rounded-sm text-muted-foreground/40 hover:text-foreground transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Dropdown */}
      {showDropdown && (
        <div className="absolute left-0 top-full mt-1 z-50 w-56 rounded-md border border-border bg-background shadow-lg py-1 max-h-48 overflow-y-auto">
          {suggestions.length === 0 && q && (
            <div className="px-3 py-2 text-[11px] text-muted-foreground">
              No matching projects
            </div>
          )}
          {suggestions.map((p) => (
            <button
              key={p.id}
              onMouseDown={(e) => { e.preventDefault(); addProject(p.id); }}
              className="flex items-center w-full px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors gap-2"
            >
              {projectIcon(p.color)}
              <span className="truncate flex-1">{p.name}</span>
              <span className="text-muted-foreground/30 tabular-nums text-[11px]">{p.openCount}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ArchivedProjectSearch({
  onUnarchive,
}: {
  onUnarchive: (id: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [archivedProjects, setArchivedProjects] = useState<ProjectWithCounts[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const internalClick = useRef(false);

  // Close dropdown on outside click
  useEffect(() => {
    if (!focused) return;
    function handleMouseDown() {
      if (internalClick.current) { internalClick.current = false; return; }
      setFocused(false);
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [focused]);

  // Load archived projects when opened
  useEffect(() => {
    if (!focused) return;
    (async () => {
      const res = await window.electronAPI?.listProjects({ includeArchived: true });
      if (res?.success) {
        setArchivedProjects(res.projects.filter((p: ProjectWithCounts) => p.archivedAt !== null));
      }
    })();
  }, [focused]);

  const q = query.trim();
  const suggestions = q
    ? archivedProjects
        .map(p => ({ ...p, dist: fuzzyScore(q, p.name) }))
        .filter(p => p.dist <= Math.max(2, Math.ceil(q.length * 0.4)))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 8)
    : archivedProjects.slice(0, 8);

  const showDropdown = focused && (suggestions.length > 0 || q || archivedProjects.length === 0);

  function handleUnarchive(id: number) {
    setArchivedProjects(prev => prev.filter(p => p.id !== id));
    onUnarchive(id);
    if (archivedProjects.length <= 1) {
      setFocused(false);
      setQuery('');
    }
  }

  if (!focused) {
    return (
      <button
        onClick={() => { setFocused(true); setTimeout(() => inputRef.current?.focus(), 0); }}
        className="flex items-center gap-1.5 h-6 px-2 rounded-md border border-transparent text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors"
      >
        <Archive className="h-3 w-3" />
        Unarchive a project…
      </button>
    );
  }

  return (
    <div ref={containerRef} className="relative" onMouseDown={() => { internalClick.current = true; }}>
      <div className="flex items-center gap-1.5 min-h-[26px] pl-2">
        <Archive className="h-3 w-3 text-muted-foreground/50 shrink-0" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setQuery(''); setFocused(false); inputRef.current?.blur(); }
          }}
          placeholder="Search archived projects…"
          className="h-[22px] min-w-[80px] flex-1 bg-transparent text-[11px] text-foreground placeholder:text-muted-foreground/30 focus:outline-none"
        />
      </div>

      {/* Dropdown */}
      {showDropdown && (
        <div className="absolute left-0 top-full mt-1 z-50 w-64 rounded-md border border-border bg-background shadow-lg py-1 max-h-48 overflow-y-auto">
          {archivedProjects.length === 0 && (
            <div className="px-3 py-2 text-[11px] text-muted-foreground">
              No archived projects
            </div>
          )}
          {suggestions.length === 0 && q && archivedProjects.length > 0 && (
            <div className="px-3 py-2 text-[11px] text-muted-foreground">
              No matching projects
            </div>
          )}
          {suggestions.map((p) => (
            <div
              key={p.id}
              className="flex items-center w-full px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent transition-colors gap-2"
            >
              {projectIcon(p.color)}
              <span className="truncate flex-1">{p.name}</span>
              <button
                onMouseDown={(e) => { e.preventDefault(); handleUnarchive(p.id); }}
                className="text-[11px] text-purple-400 hover:text-purple-300 transition-colors font-medium shrink-0"
              >
                Unarchive
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Sortable task row ─────────────────────────────────────────────────────────

interface TaskRowProps {
  task: MemoryRecord;
  stripe: number;
  overdue: boolean;
  isEditingTopic: boolean;
  editingTopicValue: string;
  isGracePeriod: boolean;
  isSearching: boolean;
  projects: ProjectWithCounts[];
  showCompleted: boolean;
  onNavigate: (id: number, task: MemoryRecord) => void;
  onRevise: (id: number, fields: Record<string, unknown>) => void;
  onDelete: (id: number) => void;
  onSkip: (id: number) => void;
  onStartEditTopic: (task: MemoryRecord) => void;
  onTopicChange: (value: string) => void;
  onCommitTopicEdit: (id: number, value: string) => void;
  onCancelTopicEdit: () => void;
}

function TaskRowContent({
  task, stripe, overdue, isEditingTopic, editingTopicValue, isGracePeriod,
  isSearching, projects, onNavigate, onRevise, onDelete, onSkip,
  onStartEditTopic, onTopicChange, onCommitTopicEdit, onCancelTopicEdit,
  dragHandleProps, isDragging,
}: TaskRowProps & { dragHandleProps?: Record<string, unknown>; isDragging?: boolean }) {
  return (
    <div
      className={cn(
        'group flex items-center gap-2 py-2.5 -mx-2 px-2 rounded transition-opacity duration-500',
        !isDragging && 'cursor-pointer',
        stripe === 1 && 'bg-muted/30',
        overdue && 'border-l-2 border-l-amber-500/50',
        isGracePeriod && 'opacity-50',
        isDragging && 'opacity-30 border border-dashed border-border',
      )}
      onClick={(e) => {
        if (isDragging) return;
        if (!(e.target as HTMLElement).closest('button, input, [role="button"], [data-drag-handle]')) {
          onNavigate(task.id, task);
        }
      }}
    >
      {/* Drag handle */}
      {!isSearching && (
        <div
          data-drag-handle
          {...dragHandleProps}
          className="w-4 shrink-0 flex items-center justify-center cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-40 hover:!opacity-70 transition-opacity"
        >
          <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
      )}

      {/* UID */}
      <button
        onClick={(e) => { e.stopPropagation(); onNavigate(task.id, task); }}
        title="Open detail"
        className="w-10 shrink-0 h-5 flex items-center justify-end text-[11px] tabular-nums text-muted-foreground/20 group-hover:text-primary/60 hover:!text-primary transition-colors cursor-pointer"
      >
        m{task.id}
      </button>

      {/* Action date */}
      <DateCell
        value={task.actionDate}
        overdue={overdue}
        onChange={(v) => onRevise(task.id, { actionDate: v })}
      />

      {/* Status */}
      <StatusCell
        value={task.status}
        onChange={(v) => onRevise(task.id, { status: v })}
        isRecurring={!!task.recurrence}
        onSkip={() => onSkip(task.id)}
      />

      {/* Topic */}
      <div className="flex-1 min-w-0">
        {isEditingTopic ? (
          <input
            autoFocus
            value={editingTopicValue}
            onChange={(e) => onTopicChange(e.target.value)}
            onBlur={() => onCommitTopicEdit(task.id, editingTopicValue)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onCommitTopicEdit(task.id, editingTopicValue);
              if (e.key === 'Escape') onCancelTopicEdit();
            }}
            className="w-full bg-transparent text-sm text-foreground border-b border-ring focus:outline-none"
          />
        ) : (
          <span
            onClick={(e) => { e.stopPropagation(); onStartEditTopic(task); }}
            title={task.topic}
            className={cn(
              'text-sm cursor-text line-clamp-3',
              task.status === 'completed'
                ? 'line-through text-muted-foreground/50'
                : 'text-foreground',
            )}
          >
            {task.topic}
          </span>
        )}
      </div>

      {/* Right-side controls */}
      <div className="shrink-0 flex items-center gap-1">
        <ProjectCell
          value={task.projectId}
          projects={projects}
          onChange={(v) => onRevise(task.id, { projectId: v })}
        />
        <PriorityCell
          value={task.priority}
          onChange={(v) => onRevise(task.id, { priority: v })}
        />
        <DueDateCell
          value={task.dueDate}
          pastDue={isPastDue(task)}
          onChange={(v) => onRevise(task.id, { dueDate: v })}
        />
        <RecurrenceCell
          value={task.recurrence}
          onChange={(v) => {
            if (v && !task.actionDate) {
              onRevise(task.id, { recurrence: v, actionDate: getTodayStr() });
            } else {
              onRevise(task.id, { recurrence: v });
            }
          }}
        />
        <button
          onClick={() => onDelete(task.id)}
          title="Delete task"
          className="w-7 flex items-center justify-center h-5 rounded text-muted-foreground/0 group-hover:text-muted-foreground/40 hover:!text-red-400 transition-colors"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function SortableTaskRow(props: TaskRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} data-task-id={props.task.id}>
      <TaskRowContent
        {...props}
        dragHandleProps={listeners}
        isDragging={isDragging}
      />
    </div>
  );
}

// ── Insert zone (hover between rows to insert task) ──────────────────────────

function InsertZone({ onInsert }: { onInsert: (anchorY: number) => void }) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const zoneRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={zoneRef} className="relative" style={{ height: 0 }}>
      <div
        className="absolute inset-x-0 -top-[6px] h-3 z-[5]"
        onMouseEnter={() => { timerRef.current = setTimeout(() => setVisible(true), 150); }}
        onMouseLeave={() => { clearTimeout(timerRef.current); setVisible(false); }}
      >
        <div className={cn(
          'absolute inset-x-2 top-1/2 -translate-y-1/2 flex items-center gap-1 transition-opacity duration-100',
          visible ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}>
          <div className="flex-1 h-px bg-primary/30" />
          <button
            onClick={(e) => {
              e.stopPropagation();
              setVisible(false);
              onInsert(zoneRef.current?.getBoundingClientRect().top ?? 200);
            }}
            className="shrink-0 h-3 w-3 rounded-full bg-primary/15 hover:bg-primary/30 flex items-center justify-center transition-colors"
          >
            <Plus className="h-2 w-2 text-primary/60" />
          </button>
          <div className="flex-1 h-px bg-primary/30" />
        </div>
      </div>
    </div>
  );
}

// ── Session-persistent filter helpers ────────────────────────────────────────

function readSession<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    return raw !== null ? (JSON.parse(raw) as T) : fallback;
  } catch { return fallback; }
}

function writeSession<T>(key: string, value: T): void {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

// ── Main view ─────────────────────────────────────────────────────────────────

export default function TasksView() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<MemoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(() => readSession('tasks.showCompleted', false));
  const [showCancelled, setShowCancelled] = useState(() => readSession('tasks.showCancelled', false));
  const [editingTopicId, setEditingTopicId] = useState<number | null>(null);
  const [editingTopicValue, setEditingTopicValue] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [newTaskTopic, setNewTaskTopic] = useState('');
  const [pendingCreates, setPendingCreates] = useState<{ key: number; topic: string }[]>([]);
  const pendingKeyRef = useRef(0);
  const showCompletedRef = useRef(showCompleted);
  showCompletedRef.current = showCompleted;
  const showCancelledRef = useRef(showCancelled);
  showCancelledRef.current = showCancelled;
  const [recentlyCompleted, setRecentlyCompleted] = useState<Set<number>>(new Set());
  const completionTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const [searchQuery, setSearchQuery] = useState(() => readSession('tasks.searchQuery', ''));
  const [searchResults, setSearchResults] = useState<(MemoryRecord & { _score?: number })[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [datePreset, setDatePreset] = useState<DatePreset>(() => readSession('tasks.datePreset', 'all'));
  const [customFrom, setCustomFrom] = useState<string | null>(() => readSession('tasks.customFrom', null));
  const [customTo, setCustomTo] = useState<string | null>(() => readSession('tasks.customTo', null));
  const [subView, setSubView] = useState<SubView>('tasks');
  const [newProjectTrigger, setNewProjectTrigger] = useState(0);
  const [projects, setProjects] = useState<ProjectWithCounts[]>([]);
  const [selectedProjectIds, setSelectedProjectIds] = useState<number[]>(() => readSession('tasks.selectedProjectIds', []));

  const loadProjects = useCallback(async () => {
    try {
      const result = await window.electronAPI?.listProjects();
      if (result?.success) setProjects(result.projects ?? []);
    } catch { /* ignore */ }
  }, []);

  const loadTasks = useCallback(async (opts: { includeCompleted: boolean; includeCancelled: boolean; projectId?: number }) => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI?.listTasks(opts);
      if (!result || !result.success) {
        setError(result?.error ?? 'Failed to load tasks');
      } else {
        setTasks(result.tasks);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // When exactly one project is selected, filter server-side; otherwise filter client-side
  const serverProjectId = selectedProjectIds.length === 1 ? selectedProjectIds[0] : undefined;

  useEffect(() => {
    loadTasks({ includeCompleted: showCompleted, includeCancelled: showCancelled, projectId: serverProjectId });
    const interval = setInterval(() => loadTasks({ includeCompleted: showCompletedRef.current, includeCancelled: showCancelledRef.current, projectId: serverProjectId }), 30_000);
    return () => clearInterval(interval);
  }, [showCompleted, showCancelled, serverProjectId, loadTasks]);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  // Debounced search
  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    const q = searchQuery.trim();
    if (!q) { setSearchResults(null); setSearching(false); return; }
    setSearching(true);
    searchDebounce.current = setTimeout(async () => {
      try {
        const result = await window.electronAPI?.searchTasks(q);
        if (result?.success) {
          setSearchResults(result.tasks);
        } else {
          console.warn('Task search failed:', result?.error);
          setSearchResults(null);
        }
      } catch (err) {
        console.warn('Task search error:', err);
        setSearchResults(null);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => { if (searchDebounce.current) clearTimeout(searchDebounce.current); };
  }, [searchQuery]);

  // Cleanup completion timers on unmount
  useEffect(() => {
    const timers = completionTimers.current;
    return () => { for (const t of timers.values()) clearTimeout(t); };
  }, []);

  // Persist filter state across navigation
  useEffect(() => { writeSession('tasks.showCompleted', showCompleted); }, [showCompleted]);
  useEffect(() => { writeSession('tasks.showCancelled', showCancelled); }, [showCancelled]);
  useEffect(() => { writeSession('tasks.searchQuery', searchQuery); }, [searchQuery]);
  useEffect(() => { writeSession('tasks.datePreset', datePreset); }, [datePreset]);
  useEffect(() => { writeSession('tasks.customFrom', customFrom); }, [customFrom]);
  useEffect(() => { writeSession('tasks.customTo', customTo); }, [customTo]);
  useEffect(() => { writeSession('tasks.selectedProjectIds', selectedProjectIds); }, [selectedProjectIds]);

  // Optimistically update a task in both the main list and search results
  function optimisticUpdate(id: number, updater: (t: MemoryRecord) => MemoryRecord) {
    setTasks(prev => prev.map(t => t.id === id ? updater(t) : t));
    setSearchResults(prev => prev?.map(t => t.id === id ? updater(t) : t) ?? null);
  }

  function optimisticRemove(id: number) {
    setTasks(prev => prev.filter(t => t.id !== id));
    setSearchResults(prev => prev?.filter(t => t.id !== id) ?? null);
  }

  function reloadOpts() {
    return { includeCompleted: showCompletedRef.current, includeCancelled: showCancelledRef.current, projectId: serverProjectId };
  }

  async function revise(id: number, fields: {
    status?: MemoryStatusValue | null;
    priority?: PriorityLevel | null;
    actionDate?: string | null;
    dueDate?: string | null;
    recurrence?: string | null;
    topic?: string;
    projectId?: number | null;
  }) {
    optimisticUpdate(id, t => ({ ...t, ...fields, updatedAt: new Date().toISOString() }));

    // Grace period: keep disappearing tasks visible briefly for undo
    const willDisappear =
      (fields.status === 'completed' && !showCompletedRef.current) ||
      fields.status === null; // converted to memory — no longer a task
    if (willDisappear) {
      const existing = completionTimers.current.get(id);
      if (existing) clearTimeout(existing);
      setRecentlyCompleted(prev => new Set(prev).add(id));
      completionTimers.current.set(id, setTimeout(() => {
        setRecentlyCompleted(prev => { const next = new Set(prev); next.delete(id); return next; });
        completionTimers.current.delete(id);
      }, 10_000));
    } else if (fields.status && fields.status !== 'completed') {
      // Undo / status change — cancel timer and remove from grace set immediately
      const existing = completionTimers.current.get(id);
      if (existing) { clearTimeout(existing); completionTimers.current.delete(id); }
      setRecentlyCompleted(prev => { const next = new Set(prev); next.delete(id); return next; });
    }

    const result = await window.electronAPI?.reviseTask(id, fields as Record<string, unknown>);
    if (!result?.success) {
      loadTasks(reloadOpts());
    } else if (result.nextActionDate) {
      // Recurring task was auto-advanced — reload to show updated date/status
      loadTasks(reloadOpts());
    }
    // If projectId changed, refresh project counts
    if (fields.projectId !== undefined) loadProjects();
  }

  async function skipTask(id: number) {
    const result = await window.electronAPI?.skipTask(id);
    if (result?.success) {
      loadTasks(reloadOpts());
    }
  }

  function startEditTopic(task: MemoryRecord) {
    setEditingTopicId(task.id);
    setEditingTopicValue(task.topic);
  }

  async function commitTopicEdit(id: number, value: string) {
    setEditingTopicId(null);
    const trimmed = value.trim();
    if (trimmed) await revise(id, { topic: trimmed });
  }

  async function commitCreate() {
    const trimmed = newTaskTopic.trim();
    if (!trimmed) return;
    setIsCreating(false);
    setNewTaskTopic('');
    const key = ++pendingKeyRef.current;
    setPendingCreates(prev => [...prev, { key, topic: trimmed }]);
    await window.electronAPI?.createTask(trimmed, selectedProjectIds.length === 1 ? selectedProjectIds[0] : undefined);
    setPendingCreates(prev => prev.filter(p => p.key !== key));
    loadTasks(reloadOpts());
    if (selectedProjectIds.length > 0) loadProjects();
  }

  async function deleteTask(id: number) {
    optimisticRemove(id);
    const result = await window.electronAPI?.deleteTask(id);
    if (!result?.success) loadTasks(reloadOpts());
    loadProjects();
  }

  // ── Filtering & sorting ──────────────────────────────────────────────────

  const { start: rangeStart, end: rangeEnd } = getDateRange(datePreset, customFrom, customTo);
  const dateFilter = (t: MemoryRecord) => {
    if (!rangeStart && !rangeEnd) return true;
    if (!t.actionDate) return false;
    if (rangeStart && t.actionDate < rangeStart) return false;
    if (rangeEnd && t.actionDate > rangeEnd) return false;
    return true;
  };

  // Client-side project filter (used when 0 or 2+ projects selected; single-project is server-side)
  const projectFilter = (t: MemoryRecord) => {
    if (selectedProjectIds.length <= 1) return true; // 0 = all, 1 = server-filtered
    return t.projectId != null && selectedProjectIds.includes(t.projectId);
  };

  const filtered = tasks
    .filter(t =>
      recentlyCompleted.has(t.id) ||
      (t.status != null &&
        (showCompleted || t.status !== 'completed') &&
        (showCancelled || t.status !== 'cancelled') &&
        dateFilter(t) &&
        projectFilter(t))
    )
    .sort((a, b) => {
      const aOver = isOverdue(a);
      const bOver = isOverdue(b);
      if (aOver !== bOver) return aOver ? -1 : 1;
      const aDate = a.actionDate ?? '9999-99-99';
      const bDate = b.actionDate ?? '9999-99-99';
      if (aDate !== bDate) return aDate.localeCompare(bDate);
      // Within same date: manual position first, then priority fallback
      const aPos = a.dayOrderPosition;
      const bPos = b.dayOrderPosition;
      if (aPos != null && bPos != null) return aPos - bPos;
      if (aPos != null) return -1;
      if (bPos != null) return 1;
      return (b.priority ?? 0) - (a.priority ?? 0);
    });

  const isSearching = searchResults !== null;
  const displayTasks = isSearching
    ? searchResults.filter(t =>
        recentlyCompleted.has(t.id) ||
        ((showCompleted || t.status !== 'completed') &&
         (showCancelled || t.status !== 'cancelled') &&
         dateFilter(t) &&
         projectFilter(t)))
    : filtered;
  const noCloudUrl = !loading && error?.includes('No cloud URL');

  // ── Drag-to-reorder ─────────────────────────────────────────────────────
  const [activeId, setActiveId] = useState<number | null>(null);
  const activeTask = activeId != null ? displayTasks.find(t => t.id === activeId) ?? null : null;
  const taskIds = useMemo(() => displayTasks.map(t => t.id), [displayTasks]);
  // ── Contextual insertion ──────────────────────────────────────────────
  const [insertAt, setInsertAt] = useState<{
    index: number;
    date: string;
    position: number;
    projectId?: number;
  } | null>(null);
  const [insertTopic, setInsertTopic] = useState('');

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as number);
  }

  /** Reorder tasks within a single date group and persist positions. */
  async function reorderSameDay(draggedId: number, overId: number, actionDate: string) {
    const sameDateTasks = displayTasks.filter(t => t.actionDate === actionDate);
    const sameDateTasksReordered = [...sameDateTasks];
    const fromIdx = sameDateTasksReordered.findIndex(t => t.id === draggedId);
    const toIdx = sameDateTasksReordered.findIndex(t => t.id === overId);
    if (fromIdx === -1 || toIdx === -1) return;
    const [moved] = sameDateTasksReordered.splice(fromIdx, 1);
    sameDateTasksReordered.splice(toIdx, 0, moved);

    const updates = sameDateTasksReordered.map((t, i) => ({ id: t.id, position: i + 1 }));

    // Optimistic update
    const posMap = new Map(updates.map(u => [u.id, u.position]));
    setTasks(prev => prev.map(t => {
      const pos = posMap.get(t.id);
      return pos !== undefined ? { ...t, dayOrderPosition: pos } : t;
    }));
    setSearchResults(prev => prev?.map(t => {
      const pos = posMap.get(t.id);
      return pos !== undefined ? { ...t, dayOrderPosition: pos } : t;
    }) ?? null);

    await Promise.all(
      updates.map(u => window.electronAPI?.updateDayOrder(u.id, actionDate, u.position)),
    );
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const draggedId = active.id as number;
    const overId = over.id as number;
    const draggedTask = displayTasks.find(t => t.id === draggedId);
    const overTask = displayTasks.find(t => t.id === overId);
    if (!draggedTask || !overTask) return;

    // Same-day reorder
    if (draggedTask.actionDate === overTask.actionDate) {
      const actionDate = draggedTask.actionDate;
      if (!actionDate) return;
      await reorderSameDay(draggedId, overId, actionDate);
      return;
    }

    // Cross-date drop: auto-pick target date and apply immediately
    if (!draggedTask.actionDate) return;
    const overIndex = displayTasks.findIndex(t => t.id === overId);

    // Determine upper/lower dates around the drop position
    const upperTask = overIndex > 0 ? displayTasks[overIndex - 1] : null;
    const lowerTask = displayTasks[overIndex]; // the task we dropped onto
    const upperDate = upperTask?.actionDate ?? null;
    const lowerDate = lowerTask?.actionDate ?? null;

    // Auto-pick target date from the boundary
    let targetDate: string;
    if (upperDate && lowerDate) {
      targetDate = pickCrossDate(upperDate, lowerDate);
    } else {
      targetDate = overTask.actionDate ?? draggedTask.actionDate;
    }

    // Compute position on the target date
    const targetDateTasks = displayTasks.filter(t => t.actionDate === targetDate && t.id !== draggedId);
    let position: number;
    if (targetDate === overTask.actionDate && targetDateTasks.length > 0) {
      // Dropping into an existing date group — insert at the drop position
      const overIdx = targetDateTasks.findIndex(t => t.id === overId);
      if (overIdx !== -1) {
        const overPos = targetDateTasks[overIdx].dayOrderPosition ?? (overIdx + 1);
        const prevPos = overIdx > 0
          ? (targetDateTasks[overIdx - 1].dayOrderPosition ?? overIdx)
          : 0;
        position = (prevPos + overPos) / 2;
      } else {
        position = targetDateTasks.length + 1;
      }
    } else {
      position = targetDateTasks.length > 0
        ? Math.max(...targetDateTasks.map(t => t.dayOrderPosition ?? 0)) + 1
        : 1;
    }

    // Optimistic update
    optimisticUpdate(draggedId, t => ({
      ...t,
      actionDate: targetDate,
      dayOrderPosition: position,
      updatedAt: new Date().toISOString(),
    }));

    // Persist: update action date, then set day order on new date
    const revResult = await window.electronAPI?.reviseTask(draggedId, { actionDate: targetDate });
    if (revResult?.success) {
      await window.electronAPI?.updateDayOrder(draggedId, targetDate, position);
    }
    loadTasks(reloadOpts());
  }

  // ── Contextual insertion handlers ──────────────────────────────────────

  function handleInsertClick(index: number, anchorY: number) {
    // Clear conflicting state
    setIsCreating(false);
    setNewTaskTopic('');

    const aboveTask = index > 0 ? displayTasks[index - 1] : null;
    const belowTask = index < displayTasks.length ? displayTasks[index] : null;
    const aboveDate = aboveTask?.actionDate ?? null;
    const belowDate = belowTask?.actionDate ?? null;
    const projectId = selectedProjectIds.length === 1 ? selectedProjectIds[0] : undefined;

    function computePosition(above: MemoryRecord | null, below: MemoryRecord | null): number {
      const aPos = above?.dayOrderPosition;
      const bPos = below?.dayOrderPosition;
      if (aPos != null && bPos != null) return (aPos + bPos) / 2;
      if (aPos != null) return aPos + 1;
      if (bPos != null) return Math.max(0, bPos - 1);
      return 1;
    }

    if (aboveDate && belowDate && aboveDate === belowDate) {
      // Same date — use it directly
      setInsertAt({ index, date: aboveDate, position: computePosition(aboveTask, belowTask), projectId });
      setInsertTopic('');
    } else if (!aboveDate && belowDate) {
      // Top of list
      setInsertAt({ index, date: belowDate, position: computePosition(null, belowTask), projectId });
      setInsertTopic('');
    } else if (aboveDate && !belowDate) {
      // Bottom of list
      setInsertAt({ index, date: aboveDate, position: computePosition(aboveTask, null), projectId });
      setInsertTopic('');
    } else if (aboveDate && belowDate && aboveDate !== belowDate) {
      // Cross-date boundary — auto-pick date
      const date = pickCrossDate(aboveDate, belowDate);
      const dateTasks = displayTasks.filter(t => t.actionDate === date);
      const position = dateTasks.length > 0
        ? Math.max(...dateTasks.map(t => t.dayOrderPosition ?? 0)) + 1
        : 1;
      setInsertAt({ index, date, position, projectId });
      setInsertTopic('');
    } else {
      // No tasks
      setInsertAt({ index, date: getTodayStr(), position: 1, projectId });
      setInsertTopic('');
    }
  }

  async function commitInsert() {
    if (!insertAt) return;
    const trimmed = insertTopic.trim();
    if (!trimmed) { setInsertAt(null); return; }
    const { date, position, projectId } = insertAt;
    setInsertAt(null);
    setInsertTopic('');
    const key = ++pendingKeyRef.current;
    setPendingCreates(prev => [...prev, { key, topic: trimmed }]);
    const result = await window.electronAPI?.createTask(trimmed, projectId) as { success?: boolean; id?: number } | undefined;
    if (result?.success && result.id) {
      const today = getTodayStr();
      if (date !== today) {
        await window.electronAPI?.reviseTask(result.id, { actionDate: date });
      }
      await window.electronAPI?.updateDayOrder(result.id, date, position);
    }
    setPendingCreates(prev => prev.filter(p => p.key !== key));
    loadTasks(reloadOpts());
    if (projectId) loadProjects();
  }

  return (
    <div>
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-background border-b border-border px-6 pt-6 pb-4">
        {subView === 'projects' && (
          <button
            onClick={() => setSubView('tasks')}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-3"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Tasks
          </button>
        )}
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-lg font-semibold text-foreground">{subView === 'projects' ? 'Projects' : 'Tasks'}</h1>
          <div className="flex items-center gap-3">
            {subView === 'tasks' && (
              <ActionButton
                icon={<Plus className="h-3.5 w-3.5" />}
                label="New task"
                onClick={() => { setIsCreating(true); setNewTaskTopic(''); setInsertAt(null); }}
              />
            )}
            {subView === 'projects' && (
              <ActionButton
                icon={<Plus className="h-3.5 w-3.5" />}
                label="New project"
                onClick={() => setNewProjectTrigger(n => n + 1)}
              />
            )}
            <ActionButton
              icon={subView === 'projects'
                ? <FolderOpen className="h-3.5 w-3.5" />
                : <Folder className="h-3.5 w-3.5" />}
              title="Manage projects"
              onClick={() => setSubView(subView === 'projects' ? 'tasks' : 'projects')}
              className={subView === 'projects' ? 'text-foreground' : undefined}
            />
            <ActionButton
              icon={<RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />}
              title="Refresh"
              onClick={() => { loadTasks(reloadOpts()); loadProjects(); }}
              disabled={loading}
            />
          </div>
        </div>

        {subView === 'tasks' && (
          <>
            {/* Search */}
            <div className="relative mb-3">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/40" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setSearchQuery(''); }}
                placeholder="Search tasks…"
                className="w-full h-8 rounded-md border border-input bg-background pl-8 pr-8 text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
              />
              {(searchQuery || searching) && (
                <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                  {searching && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery('')}
                      className="h-4 w-4 flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Filters */}
            <div className="flex items-center gap-3 flex-wrap">
              <DateRangeFilter
                preset={datePreset}
                customFrom={customFrom}
                customTo={customTo}
                onPreset={setDatePreset}
                onCustomFrom={setCustomFrom}
                onCustomTo={setCustomTo}
              />
              <ToggleSwitch checked={showCompleted} onChange={setShowCompleted} label="Completed" />
              <ToggleSwitch checked={showCancelled} onChange={setShowCancelled} label="Cancelled" />
            </div>

            {/* Project filter */}
            <div className="mt-2">
              <ProjectSearchFilter
                projects={projects}
                selectedIds={selectedProjectIds}
                onChange={setSelectedProjectIds}
              />
            </div>
          </>
        )}
      </div>

      {/* Body */}
      <div className="px-6 py-4">
        {loading && tasks.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        )}

        {!loading && noCloudUrl && (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <Cloud className="h-8 w-8 text-muted-foreground/30" />
            <div>
              <p className="text-sm font-medium text-foreground mb-1">Cloud memories not connected</p>
              <p className="text-xs text-muted-foreground max-w-[260px]">
                Tasks are stored in Lodestone's cloud memory service. Configure your Worker URL to get started.
              </p>
            </div>
            <button
              onClick={() => navigate('/settings')}
              className="mt-1 h-7 rounded-md border border-input bg-background px-3 text-xs text-foreground hover:bg-accent transition-colors"
            >
              Go to Settings
            </button>
          </div>
        )}

        {!loading && error && !noCloudUrl && (
          <div className="flex items-center gap-2 text-sm text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {/* ── Tasks sub-view ─────────────────────────────────────── */}
        {subView === 'tasks' && !noCloudUrl && (
          <>
            {!loading && !error && displayTasks.length === 0 && !searching && (
              <p className="text-sm text-muted-foreground">
                {isSearching ? 'No matching tasks.' : 'No tasks found.'}
              </p>
            )}

            {(isCreating || pendingCreates.length > 0 || displayTasks.length > 0) && (
              <div className="flex flex-col divide-y divide-border/50">
                {/* Column header row */}
                <div className="flex items-center gap-2 pb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/40 font-medium select-none border-b border-border/30">
                  {!isSearching && <div className="w-4 shrink-0" />}
                  <div className="w-10 shrink-0" />
                  <div className="w-[72px] shrink-0 text-center">Action</div>
                  <div className="w-12 shrink-0 text-center">Status</div>
                  <div className="flex-1 min-w-0">Task</div>
                  <div className="shrink-0 flex items-center gap-1">
                    <div className="w-24 text-center">Project</div>
                    <div className="w-6 text-center">Pri</div>
                    <div className="w-[72px] text-center">Due</div>
                    <div className="w-[72px] text-center">Repeat</div>
                    <div className="w-7" />
                  </div>
                </div>

                {/* Create row */}
                {isCreating && (
                  <div className="flex items-center gap-2 py-2.5">
                    <div className="w-10 shrink-0" />
                    <div className="w-[72px] shrink-0" />
                    <div className="w-12 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <input
                        autoFocus
                        placeholder="New task…"
                        value={newTaskTopic}
                        onChange={(e) => setNewTaskTopic(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitCreate();
                          if (e.key === 'Escape') { setIsCreating(false); setNewTaskTopic(''); }
                        }}
                        onBlur={() => { if (!newTaskTopic.trim()) { setIsCreating(false); setNewTaskTopic(''); } }}
                        className="w-full bg-transparent text-sm text-foreground border-b border-ring focus:outline-none placeholder:text-muted-foreground/30"
                      />
                    </div>
                    <div className="shrink-0 flex items-center gap-1">
                      <div className="w-24" /><div className="w-6" /><div className="w-[72px]" /><div className="w-[72px]" /><div className="w-7" />
                    </div>
                  </div>
                )}

                {/* Pending create rows */}
                {pendingCreates.map(({ key, topic }) => (
                  <div key={key} className="flex items-center gap-2 py-2.5 opacity-50">
                    <div className="w-10 shrink-0" />
                    <div className="w-[72px] shrink-0" />
                    <div className="w-12 shrink-0 flex items-center justify-center">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="block truncate text-sm text-muted-foreground italic">{topic}</span>
                    </div>
                    <div className="shrink-0 flex items-center gap-1">
                      <div className="w-24" /><div className="w-6" /><div className="w-[72px]" /><div className="w-[72px]" /><div className="w-7" />
                    </div>
                  </div>
                ))}

                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
                    {(() => {
                      // Build a shade map: unique sorted dates → alternating 0/1
                      const uniqueDates: string[] = [];
                      const seen = new Set<string>();
                      for (const t of displayTasks) {
                        const d = t.actionDate ?? '';
                        if (!seen.has(d)) { seen.add(d); uniqueDates.push(d); }
                      }
                      const dateShade = new Map<string, number>();
                      let shade = 0;
                      for (const d of uniqueDates) {
                        dateShade.set(d, shade);
                        shade = shade === 0 ? 1 : 0;
                      }

                      const showInsertZones = !isSearching && !activeId && !insertAt;
                      const elements: React.ReactNode[] = [];

                      function renderInsertRow() {
                        if (!insertAt) return null;
                        return (
                          <div key="insert-row" className="flex items-center gap-2 py-2.5 -mx-2 px-2 rounded bg-primary/5 border border-primary/20">
                            <div className="w-4 shrink-0" />
                            <div className="w-10 shrink-0" />
                            <div className="w-[72px] shrink-0 text-center">
                              <span className="text-[11px] text-primary/60">{formatDate(insertAt.date)}</span>
                            </div>
                            <div className="w-12 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <input
                                autoFocus
                                placeholder="New task…"
                                value={insertTopic}
                                onChange={(e) => setInsertTopic(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') commitInsert();
                                  if (e.key === 'Escape') { setInsertAt(null); setInsertTopic(''); }
                                }}
                                onBlur={() => { if (!insertTopic.trim()) { setInsertAt(null); setInsertTopic(''); } }}
                                className="w-full bg-transparent text-sm text-foreground border-b border-primary/30 focus:outline-none placeholder:text-muted-foreground/30"
                              />
                            </div>
                            <div className="shrink-0 flex items-center gap-1">
                              <div className="w-24" /><div className="w-6" /><div className="w-[72px]" /><div className="w-[72px]" /><div className="w-7" />
                            </div>
                          </div>
                        );
                      }

                      for (let i = 0; i <= displayTasks.length; i++) {
                        // Insert zone or inline creation row at this position
                        if (insertAt?.index === i) {
                          elements.push(renderInsertRow());
                        } else if (showInsertZones && (i < displayTasks.length || displayTasks.length > 0)) {
                          elements.push(
                            <InsertZone key={`iz-${i}`} onInsert={(y) => handleInsertClick(i, y)} />
                          );
                        }

                        // Task row
                        if (i < displayTasks.length) {
                          const task = displayTasks[i];
                          elements.push(
                            <SortableTaskRow
                              key={task.id}
                              task={task}
                              stripe={dateShade.get(task.actionDate ?? '') ?? 0}
                              overdue={isOverdue(task)}
                              isEditingTopic={editingTopicId === task.id}
                              editingTopicValue={editingTopicValue}
                              isGracePeriod={recentlyCompleted.has(task.id)}
                              isSearching={isSearching}
                              projects={projects}
                              showCompleted={showCompleted}
                              onNavigate={(id, t) => navigate(`/tasks/${id}`, { state: { task: t } })}
                              onRevise={(id, fields) => revise(id, fields)}
                              onDelete={deleteTask}
                              onSkip={skipTask}
                              onStartEditTopic={startEditTopic}
                              onTopicChange={setEditingTopicValue}
                              onCommitTopicEdit={commitTopicEdit}
                              onCancelTopicEdit={() => setEditingTopicId(null)}
                            />
                          );
                        }
                      }

                      return elements;
                    })()}
                  </SortableContext>
                  <DragOverlay>
                    {activeTask && (
                      <div className="shadow-lg scale-[1.02] bg-background rounded border border-border">
                        <TaskRowContent
                          task={activeTask}
                          stripe={0}
                          overdue={isOverdue(activeTask)}
                          isEditingTopic={false}
                          editingTopicValue=""
                          isGracePeriod={false}
                          isSearching={false}
                          projects={projects}
                          showCompleted={showCompleted}
                          onNavigate={() => {}}
                          onRevise={() => {}}
                          onDelete={() => {}}
                          onSkip={() => {}}
                          onStartEditTopic={() => {}}
                          onTopicChange={() => {}}
                          onCommitTopicEdit={() => {}}
                          onCancelTopicEdit={() => {}}
                        />
                      </div>
                    )}
                  </DragOverlay>
                </DndContext>

              </div>
            )}
          </>
        )}

        {/* ── Projects sub-view ──────────────────────────────────── */}
        {subView === 'projects' && !noCloudUrl && !error && (
          <ProjectsSubView projects={projects} onRefresh={() => { loadProjects(); loadTasks(reloadOpts()); }} createTrigger={newProjectTrigger} />
        )}
      </div>
    </div>
  );
}

// ── Projects sub-view (inline within Tasks) ───────────────────────────────────

function ProjectsSubView({
  projects,
  onRefresh,
  createTrigger = 0,
}: {
  projects: ProjectWithCounts[];
  onRefresh: () => void;
  createTrigger?: number;
}) {
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [openColorId, setOpenColorId] = useState<number | null>(null);
  const [editingNameId, setEditingNameId] = useState<number | null>(null);
  const [editingNameValue, setEditingNameValue] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [confirmMergeId, setConfirmMergeId] = useState<number | null>(null);
  const [confirmArchiveId, setConfirmArchiveId] = useState<number | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState<number | null>(null);
  const colorPopoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (createTrigger > 0) { setIsCreating(true); setNewName(''); }
  }, [createTrigger]);

  // Close color popover on outside click
  useEffect(() => {
    if (openColorId === null) return;
    function onDown(e: MouseEvent) {
      if (colorPopoverRef.current && !colorPopoverRef.current.contains(e.target as Node)) {
        setOpenColorId(null);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openColorId]);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setIsCreating(false);
    setNewName('');
    await window.electronAPI?.createProject(name);
    onRefresh();
  }

  async function handleColorChange(id: number, color: SiloColor) {
    setOpenColorId(null);
    await window.electronAPI?.updateProject(id, { color });
    onRefresh();
  }


  async function handleRename(project: ProjectWithCounts) {
    setEditingNameId(null);
    const trimmed = editingNameValue.trim();
    if (!trimmed || trimmed === project.name) return;
    await window.electronAPI?.updateProject(project.id, { name: trimmed });
    onRefresh();
  }

  async function handleDelete(id: number) {
    setConfirmDeleteId(null);
    await window.electronAPI?.deleteProject(id);
    onRefresh();
  }

  async function handleMerge(sourceId: number) {
    if (!mergeTargetId) return;
    setConfirmMergeId(null);
    setMergeTargetId(null);
    await window.electronAPI?.mergeProjects(sourceId, mergeTargetId);
    onRefresh();
  }

  async function handleArchive(id: number) {
    setConfirmArchiveId(null);
    await window.electronAPI?.archiveProject(id);
    onRefresh();
  }

  async function handleUnarchive(id: number) {
    await window.electronAPI?.unarchiveProject(id);
    onRefresh();
  }

  return (
    <div>
      <div className="mb-4">
        <p className="text-xs text-muted-foreground">{projects.length} project{projects.length !== 1 ? 's' : ''}</p>
        <div className="mt-2">
          <ArchivedProjectSearch onUnarchive={handleUnarchive} />
        </div>
      </div>

      {isCreating && (
        <div className="flex items-center gap-2 mb-3 p-3 rounded-lg border border-border/50">
          <input
            autoFocus
            placeholder="Project name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate();
              if (e.key === 'Escape') { setIsCreating(false); setNewName(''); }
            }}
            onBlur={() => { if (!newName.trim()) { setIsCreating(false); setNewName(''); } }}
            className="flex-1 bg-transparent text-sm text-foreground border-b border-ring focus:outline-none placeholder:text-muted-foreground/30"
          />
        </div>
      )}

      {projects.length === 0 && !isCreating && (
        <p className="text-sm text-muted-foreground">No projects yet.</p>
      )}

      <div className="flex flex-col divide-y divide-border/50">
        {projects.map((p) => {
          const total = p.openCount + p.completedCount;
          const pct = total > 0 ? Math.round((p.completedCount / total) * 100) : 0;
          const colorMap = SILO_COLOR_MAP[p.color as SiloColor];
          const isColorOpen = openColorId === p.id;
          const isDeleting = confirmDeleteId === p.id;
          const isMerging = confirmMergeId === p.id;
          const isArchiving = confirmArchiveId === p.id;
          const mergeTargets = projects.filter(q => q.id !== p.id);

          return (
            <div key={p.id} className="group py-3">
              {/* Main row */}
              <div className="flex items-center gap-3">
                {/* Folder icon — opens inline colour picker */}
                <div className="relative" ref={isColorOpen ? colorPopoverRef : undefined}>
                  <button
                    onClick={() => setOpenColorId(isColorOpen ? null : p.id)}
                    title="Change colour"
                    className="p-0.5 rounded transition-colors hover:bg-accent"
                  >
                    <Folder className={cn('h-4 w-4 shrink-0', SILO_COLOR_MAP[p.color as SiloColor]?.text ?? 'text-blue-500')} />
                  </button>
                  {isColorOpen && (
                    <div className="absolute left-0 top-6 z-20 flex items-center gap-1.5 flex-wrap p-2 rounded-lg border border-border bg-popover shadow-lg w-max">
                      {SILO_COLORS.map((c) => {
                        const map = SILO_COLOR_MAP[c];
                        return (
                          <button
                            key={c}
                            onClick={() => handleColorChange(p.id, c)}
                            className={cn(
                              'h-5 w-5 rounded-full transition-all',
                              map.dot,
                              p.color === c
                                ? 'ring-2 ring-offset-2 ring-offset-background ring-foreground/40 scale-110'
                                : 'opacity-60 hover:opacity-100',
                            )}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Name (inline editable) */}
                {editingNameId === p.id ? (
                  <input
                    autoFocus
                    value={editingNameValue}
                    onChange={(e) => setEditingNameValue(e.target.value)}
                    onBlur={() => handleRename(p)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRename(p);
                      if (e.key === 'Escape') { setEditingNameId(null); }
                    }}
                    className="flex-1 min-w-0 bg-transparent text-sm font-medium text-foreground border-b border-ring focus:outline-none"
                  />
                ) : (
                  <span
                    onClick={() => { setEditingNameId(p.id); setEditingNameValue(p.name); }}
                    className="flex-1 min-w-0 text-sm font-medium text-foreground truncate cursor-text"
                  >
                    {p.name}
                  </span>
                )}

                {/* Progress */}
                <div className="flex items-center gap-2 shrink-0">
                  <div className="w-20 h-1.5 rounded-full bg-border/40 overflow-hidden">
                    <div
                      className={cn('h-full rounded-full transition-all', colorMap?.dot ?? 'bg-blue-500')}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-[11px] tabular-nums text-muted-foreground w-16 text-right">
                    {p.completedCount}/{total} done
                  </span>
                </div>

                {/* Action buttons (visible on row hover) */}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  {mergeTargets.length > 0 && (
                    <button
                      onClick={() => { setConfirmMergeId(p.id); setMergeTargetId(null); setConfirmDeleteId(null); setConfirmArchiveId(null); }}
                      title="Merge into another project"
                      className="p-1 rounded text-muted-foreground/40 hover:text-amber-400 transition-colors"
                    >
                      <Merge className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    onClick={() => { setConfirmArchiveId(p.id); setConfirmDeleteId(null); setConfirmMergeId(null); }}
                    title="Archive project"
                    className="p-1 rounded text-muted-foreground/40 hover:text-purple-400 transition-colors"
                  >
                    <Archive className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => { setConfirmDeleteId(p.id); setConfirmMergeId(null); setConfirmArchiveId(null); }}
                    title="Delete project"
                    className="p-1 rounded text-muted-foreground/40 hover:text-red-400 transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {/* Delete confirmation (inline expand) */}
              {isDeleting && (
                <div className="flex items-center gap-3 mt-2 pl-7">
                  <span className="text-xs text-muted-foreground">
                    Delete "{p.name}"?{total > 0 ? ` ${total} task${total !== 1 ? 's' : ''} will become unassigned.` : ''}
                  </span>
                  <button
                    onClick={() => handleDelete(p.id)}
                    className="text-xs text-red-400 hover:text-red-300 transition-colors font-medium"
                  >
                    Yes, delete
                  </button>
                  <button
                    onClick={() => setConfirmDeleteId(null)}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}

              {/* Merge confirmation (inline expand) */}
              {isMerging && (
                <div className="flex items-center gap-3 mt-2 pl-7 flex-wrap">
                  <span className="text-xs text-muted-foreground">Merge into:</span>
                  <select
                    value={mergeTargetId ?? ''}
                    onChange={(e) => setMergeTargetId(e.target.value ? parseInt(e.target.value, 10) : null)}
                    className="h-6 rounded border border-border bg-background px-2 text-xs text-foreground"
                  >
                    <option value="">Select project…</option>
                    {mergeTargets.map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => handleMerge(p.id)}
                    disabled={!mergeTargetId}
                    className="text-xs text-amber-400 hover:text-amber-300 transition-colors font-medium disabled:opacity-30"
                  >
                    Merge ({total} tasks)
                  </button>
                  <button
                    onClick={() => { setConfirmMergeId(null); setMergeTargetId(null); }}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}

              {/* Archive confirmation (inline expand) */}
              {isArchiving && (
                <div className="flex items-center gap-3 mt-2 pl-7">
                  <span className="text-xs text-muted-foreground">
                    Archive "{p.name}"?{total > 0 ? ' Tasks will be hidden from recall & agenda.' : ''}
                  </span>
                  <button
                    onClick={() => handleArchive(p.id)}
                    className="text-xs text-purple-400 hover:text-purple-300 transition-colors font-medium"
                  >
                    Yes, archive
                  </button>
                  <button
                    onClick={() => setConfirmArchiveId(null)}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

    </div>
  );
}
