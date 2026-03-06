import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, AlertCircle, RefreshCw, Cloud, Plus, Trash2, Maximize2, Search, X, Calendar, ChevronDown, ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  StatusCell,
  PriorityCell,
  DateCell,
  RecurrenceCell,
  CalendarGrid,
  isOverdue,
  getTodayStr,
  formatDate,
} from '@/components/TaskCells';
import type { MemoryRecord, MemoryStatusValue, PriorityLevel } from '../../shared/types';

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

// ── Main view ─────────────────────────────────────────────────────────────────

export default function TasksView() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<MemoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [showCancelled, setShowCancelled] = useState(false);
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
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<(MemoryRecord & { _score?: number })[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [datePreset, setDatePreset] = useState<DatePreset>('all');
  const [customFrom, setCustomFrom] = useState<string | null>(null);
  const [customTo, setCustomTo] = useState<string | null>(null);

  const loadTasks = useCallback(async (opts: { includeCompleted: boolean; includeCancelled: boolean }) => {
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

  useEffect(() => {
    loadTasks({ includeCompleted: showCompleted, includeCancelled: showCancelled });
    const interval = setInterval(() => loadTasks({ includeCompleted: showCompletedRef.current, includeCancelled: showCancelledRef.current }), 30_000);
    return () => clearInterval(interval);
  }, [showCompleted, showCancelled, loadTasks]);

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

  // Optimistically update a task in both the main list and search results
  function optimisticUpdate(id: number, updater: (t: MemoryRecord) => MemoryRecord) {
    setTasks(prev => prev.map(t => t.id === id ? updater(t) : t));
    setSearchResults(prev => prev?.map(t => t.id === id ? updater(t) : t) ?? null);
  }

  function optimisticRemove(id: number) {
    setTasks(prev => prev.filter(t => t.id !== id));
    setSearchResults(prev => prev?.filter(t => t.id !== id) ?? null);
  }

  async function revise(id: number, fields: {
    status?: MemoryStatusValue | null;
    priority?: PriorityLevel | null;
    actionDate?: string | null;
    recurrence?: string | null;
    topic?: string;
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
      loadTasks({ includeCompleted: showCompletedRef.current, includeCancelled: showCancelledRef.current });
    } else if (result.nextActionDate) {
      // Recurring task was auto-advanced — reload to show updated date/status
      loadTasks({ includeCompleted: showCompletedRef.current, includeCancelled: showCancelledRef.current });
    }
  }

  async function skipTask(id: number) {
    const result = await window.electronAPI?.skipTask(id);
    if (result?.success) {
      loadTasks({ includeCompleted: showCompletedRef.current, includeCancelled: showCancelledRef.current });
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
    await window.electronAPI?.createTask(trimmed);
    setPendingCreates(prev => prev.filter(p => p.key !== key));
    loadTasks({ includeCompleted: showCompletedRef.current, includeCancelled: showCancelledRef.current });
  }

  async function deleteTask(id: number) {
    optimisticRemove(id);
    const result = await window.electronAPI?.deleteTask(id);
    if (!result?.success) loadTasks({ includeCompleted: showCompletedRef.current, includeCancelled: showCancelledRef.current });
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

  const filtered = tasks
    .filter(t =>
      recentlyCompleted.has(t.id) ||
      (t.status != null &&
        (showCompleted || t.status !== 'completed') &&
        (showCancelled || t.status !== 'cancelled') &&
        dateFilter(t))
    )
    .sort((a, b) => {
      const aOver = isOverdue(a);
      const bOver = isOverdue(b);
      if (aOver !== bOver) return aOver ? -1 : 1;
      const aDate = a.actionDate ?? '9999-99-99';
      const bDate = b.actionDate ?? '9999-99-99';
      if (aDate !== bDate) return aDate.localeCompare(bDate);
      return (b.priority ?? 0) - (a.priority ?? 0);
    });

  const isSearching = searchResults !== null;
  const displayTasks = isSearching
    ? searchResults.filter(t =>
        recentlyCompleted.has(t.id) ||
        ((showCompleted || t.status !== 'completed') &&
         (showCancelled || t.status !== 'cancelled') &&
         dateFilter(t)))
    : filtered;
  const overdueCount = filtered.filter(isOverdue).length;
  const noCloudUrl = !loading && error?.includes('No cloud URL');

  return (
    <div>
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-background border-b border-border px-6 pt-6 pb-4">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-lg font-semibold text-foreground">Tasks</h1>
          <div className="flex items-center gap-3">
            {overdueCount > 0 && (
              <span className="inline-flex items-center text-xs font-medium text-amber-400">
                {overdueCount} overdue
              </span>
            )}
            <button
              onClick={() => { setIsCreating(true); setNewTaskTopic(''); }}
              title="New task"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              New task
            </button>
            <button
              onClick={() => loadTasks({ includeCompleted: showCompleted, includeCancelled: showCancelled })}
              disabled={loading}
              title="Refresh"
              className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </button>
          </div>
        </div>

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
        <div className="flex items-center gap-3">
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
      </div>

      {/* Body */}
      <div className="px-6 py-4">
        {loading && tasks.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading tasks…
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

        {!loading && !error && displayTasks.length === 0 && !searching && (
          <p className="text-sm text-muted-foreground">
            {isSearching ? 'No matching tasks.' : 'No tasks found.'}
          </p>
        )}

        {(isCreating || pendingCreates.length > 0 || displayTasks.length > 0) && (
          <div className="flex flex-col divide-y divide-border/50">
            {/* Create row */}
            {isCreating && (
              <div className="flex items-center gap-2 py-2.5">
                <div className="w-10 shrink-0" />
                <div className="w-5 shrink-0" />
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
                <div className="shrink-0 flex items-center gap-1.5">
                  <div className="w-5" /><div className="w-20" /><div className="w-20" /><div className="w-7" />
                </div>
              </div>
            )}

            {/* Pending create rows */}
            {pendingCreates.map(({ key, topic }) => (
              <div key={key} className="flex items-center gap-2 py-2.5 opacity-50">
                <div className="w-10 shrink-0" />
                <div className="w-5 shrink-0" />
                <div className="w-12 shrink-0 flex items-center justify-center">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="block truncate text-sm text-muted-foreground italic">{topic}</span>
                </div>
                <div className="shrink-0 flex items-center gap-1.5">
                  <div className="w-5" /><div className="w-20" /><div className="w-20" /><div className="w-7" />
                </div>
              </div>
            ))}

            {displayTasks.map((task) => {
              const overdue = isOverdue(task);
              const isEditingTopic = editingTopicId === task.id;

              const isGracePeriod = recentlyCompleted.has(task.id);

              return (
                <div
                  key={task.id}
                  className={cn(
                    'group flex items-center gap-2 py-2.5 transition-opacity duration-500',
                    overdue && '-mx-1 px-1 border-l-2 border-l-amber-500/50',
                    isGracePeriod && 'opacity-50',
                  )}
                >
                  {/* UID */}
                  <span className="w-10 shrink-0 h-5 leading-5 text-right text-[11px] tabular-nums text-muted-foreground/25 select-all">
                    m{task.id}
                  </span>

                  {/* Expand to detail */}
                  <button
                    onClick={() => navigate(`/tasks/${task.id}`, { state: { task } })}
                    title="Open detail"
                    className="w-5 shrink-0 flex items-center justify-center h-5 rounded text-muted-foreground/0 group-hover:text-muted-foreground/40 hover:!text-foreground transition-colors"
                  >
                    <Maximize2 className="h-3 w-3" />
                  </button>

                  {/* Status */}
                  <StatusCell
                    value={task.status}
                    onChange={(v) => revise(task.id, { status: v })}
                    isRecurring={!!task.recurrence}
                    onSkip={() => skipTask(task.id)}
                  />

                  {/* Topic */}
                  <div className="flex-1 min-w-0">
                    {isEditingTopic ? (
                      <input
                        autoFocus
                        value={editingTopicValue}
                        onChange={(e) => setEditingTopicValue(e.target.value)}
                        onBlur={() => commitTopicEdit(task.id, editingTopicValue)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitTopicEdit(task.id, editingTopicValue);
                          if (e.key === 'Escape') setEditingTopicId(null);
                        }}
                        className="w-full bg-transparent text-sm text-foreground border-b border-ring focus:outline-none"
                      />
                    ) : (
                      <span
                        onClick={() => startEditTopic(task)}
                        title={task.topic}
                        className={cn(
                          'text-sm cursor-text line-clamp-2',
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
                  <div className="shrink-0 flex items-center gap-1.5">
                    <PriorityCell
                      value={task.priority}
                      onChange={(v) => revise(task.id, { priority: v })}
                    />
                    <DateCell
                      value={task.actionDate}
                      overdue={overdue}
                      onChange={(v) => revise(task.id, { actionDate: v })}
                    />
                    <RecurrenceCell
                      value={task.recurrence}
                      onChange={(v) => {
                        if (v && !task.actionDate) {
                          revise(task.id, { recurrence: v, actionDate: getTodayStr() });
                        } else {
                          revise(task.id, { recurrence: v });
                        }
                      }}
                    />
                    <button
                      onClick={() => deleteTask(task.id)}
                      title="Delete task"
                      className="w-7 flex items-center justify-center h-5 rounded text-muted-foreground/0 group-hover:text-muted-foreground/40 hover:!text-red-400 transition-colors"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
