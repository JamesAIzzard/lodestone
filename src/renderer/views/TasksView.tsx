import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MemoryRecord, MemoryStatusValue, PriorityLevel } from '../../shared/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getTodayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function isOverdue(task: MemoryRecord): boolean {
  if (!task.actionDate) return false;
  if (task.status === 'completed' || task.completedOn) return false;
  if (task.status === 'cancelled') return false;
  return task.actionDate < getTodayStr();
}

function formatDate(dateStr: string | null): string {
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

const STATUS_COLORS: Record<string, string> = {
  open: 'text-blue-400',
  completed: 'text-emerald-400',
  cancelled: 'text-muted-foreground/40',
};

const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  completed: 'Done',
  cancelled: 'Cancelled',
};

const PRIORITY_DOT_COLORS: Record<number, string> = {
  1: 'bg-muted-foreground/30',
  2: 'bg-sky-400',
  3: 'bg-amber-400',
  4: 'bg-red-400',
};

const PRIORITY_LABELS: Record<number, string> = {
  1: 'Low',
  2: 'Medium',
  3: 'High',
  4: 'Critical',
};

// ── Inline edit subcomponents ─────────────────────────────────────────────────

function InlineDropdown<T extends string>({
  options,
  onSelect,
  onClose,
}: {
  options: { value: T; label: string; className?: string }[];
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
      {options.map((opt) => (
        <button
          key={opt.value}
          onMouseDown={(e) => { e.preventDefault(); onSelect(opt.value); onClose(); }}
          className={cn(
            'block w-full px-3 py-1.5 text-left text-xs hover:bg-accent transition-colors',
            opt.className ?? 'text-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function StatusCell({
  value,
  onChange,
}: {
  value: MemoryStatusValue | null;
  onChange: (v: MemoryStatusValue | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = value ? STATUS_LABELS[value] : '—';
  const colorClass = value ? STATUS_COLORS[value] : 'text-muted-foreground/40';

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'h-5 min-w-[52px] rounded px-1.5 text-[11px] font-medium border border-transparent hover:border-border/60 transition-colors text-left',
          colorClass,
        )}
      >
        {label}
      </button>
      {open && (
        <InlineDropdown
          options={[
            { value: '' as MemoryStatusValue, label: '—', className: 'text-muted-foreground/40' },
            { value: 'open', label: 'Open', className: 'text-blue-400' },
            { value: 'completed', label: 'Done', className: 'text-emerald-400' },
            { value: 'cancelled', label: 'Cancelled', className: 'text-muted-foreground/40' },
          ]}
          onSelect={(v) => onChange(v === ('' as MemoryStatusValue) ? null : v)}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function PriorityCell({
  value,
  onChange,
}: {
  value: PriorityLevel | null;
  onChange: (v: PriorityLevel | null) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen(!open)}
        title={value ? PRIORITY_LABELS[value] : 'No priority'}
        className="flex items-center justify-center h-5 w-5 rounded border border-transparent hover:border-border/60 transition-colors"
      >
        {value ? (
          <span className={cn('h-2 w-2 rounded-sm shrink-0', PRIORITY_DOT_COLORS[value])} />
        ) : (
          <span className="h-2 w-2 rounded-sm bg-muted-foreground/20" />
        )}
      </button>
      {open && (
        <InlineDropdown
          options={[
            { value: '' as unknown as PriorityLevel, label: '— None', className: 'text-muted-foreground/40' },
            { value: 4, label: 'Critical', className: 'text-red-400' },
            { value: 3, label: 'High', className: 'text-amber-400' },
            { value: 2, label: 'Medium', className: 'text-sky-400' },
            { value: 1, label: 'Low', className: 'text-muted-foreground/60' },
          ]}
          onSelect={(v) => onChange(v === ('' as unknown as PriorityLevel) ? null : v)}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function DateCell({
  value,
  overdue,
  onChange,
}: {
  value: string | null;
  overdue: boolean;
  onChange: (v: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <input
        type="date"
        autoFocus
        defaultValue={value ?? ''}
        onBlur={(e) => {
          onChange(e.target.value || null);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false);
          if (e.key === 'Enter') {
            onChange((e.target as HTMLInputElement).value || null);
            setEditing(false);
          }
        }}
        className="h-5 w-28 rounded border border-ring bg-background px-1.5 text-[11px] text-foreground focus:outline-none"
      />
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className={cn(
        'h-5 rounded px-1.5 text-[11px] border border-transparent hover:border-border/60 transition-colors shrink-0 tabular-nums',
        overdue ? 'text-amber-400' : value ? 'text-muted-foreground' : 'text-muted-foreground/30',
      )}
    >
      {value ? formatDate(value) : '—'}
    </button>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────

export default function TasksView() {
  const [tasks, setTasks] = useState<MemoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [filterPriority, setFilterPriority] = useState<PriorityLevel | 'all'>('all');
  const [editingTopicId, setEditingTopicId] = useState<number | null>(null);
  const [editingTopicValue, setEditingTopicValue] = useState('');
  const showCompletedRef = useRef(showCompleted);
  showCompletedRef.current = showCompleted;

  const loadTasks = useCallback(async (includeCompleted: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI?.listTasks(includeCompleted);
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
    loadTasks(showCompleted);
    const interval = setInterval(() => loadTasks(showCompletedRef.current), 30_000);
    return () => clearInterval(interval);
  }, [showCompleted, loadTasks]);

  async function revise(id: number, fields: {
    status?: MemoryStatusValue | null;
    priority?: PriorityLevel | null;
    actionDate?: string | null;
    topic?: string;
  }) {
    // Optimistic update
    setTasks(prev => prev.map(t =>
      t.id === id ? { ...t, ...fields, updatedAt: new Date().toISOString() } : t
    ));
    const result = await window.electronAPI?.reviseTask(id, fields as Record<string, unknown>);
    if (!result?.success) {
      loadTasks(showCompletedRef.current);
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

  // ── Filtering & sorting ──────────────────────────────────────────────────

  const filtered = tasks
    .filter(t => filterPriority === 'all' || t.priority === filterPriority)
    .sort((a, b) => {
      const aOver = isOverdue(a);
      const bOver = isOverdue(b);
      if (aOver !== bOver) return aOver ? -1 : 1;
      const aDate = a.actionDate ?? '9999-99-99';
      const bDate = b.actionDate ?? '9999-99-99';
      if (aDate !== bDate) return aDate.localeCompare(bDate);
      return (b.priority ?? 0) - (a.priority ?? 0);
    });

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
              <span className="text-xs font-medium text-amber-400">
                {overdueCount} overdue
              </span>
            )}
            <button
              onClick={() => loadTasks(showCompleted)}
              disabled={loading}
              title="Refresh"
              className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </button>
          </div>
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-3">
          <select
            value={filterPriority}
            onChange={(e) => setFilterPriority(e.target.value === 'all' ? 'all' : parseInt(e.target.value, 10) as PriorityLevel)}
            className="h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">All priorities</option>
            <option value="4">Critical</option>
            <option value="3">High</option>
            <option value="2">Medium</option>
            <option value="1">Low</option>
          </select>

          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showCompleted}
              onChange={(e) => setShowCompleted(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Show completed
          </label>
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
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertCircle className="h-4 w-4 shrink-0" />
            No cloud URL configured. Add one in Settings.
          </div>
        )}

        {!loading && error && !noCloudUrl && (
          <div className="flex items-center gap-2 text-sm text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <p className="text-sm text-muted-foreground">No tasks found.</p>
        )}

        {filtered.length > 0 && (
          <div className="flex flex-col divide-y divide-border/50">
            {filtered.map((task) => {
              const overdue = isOverdue(task);
              const isEditingTopic = editingTopicId === task.id;

              return (
                <div
                  key={task.id}
                  className={cn(
                    'flex items-center gap-3 py-2.5',
                    overdue && '-mx-1 px-1 border-l-2 border-l-amber-500/50',
                  )}
                >
                  {/* Status */}
                  <StatusCell
                    value={task.status}
                    onChange={(v) => revise(task.id, { status: v })}
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
                          'block truncate text-sm cursor-text',
                          task.status === 'completed'
                            ? 'line-through text-muted-foreground/50'
                            : 'text-foreground',
                        )}
                      >
                        {task.topic}
                      </span>
                    )}
                  </div>

                  {/* Priority */}
                  <PriorityCell
                    value={task.priority}
                    onChange={(v) => revise(task.id, { priority: v })}
                  />

                  {/* Action date */}
                  <DateCell
                    value={task.actionDate}
                    overdue={overdue}
                    onChange={(v) => revise(task.id, { actionDate: v })}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
