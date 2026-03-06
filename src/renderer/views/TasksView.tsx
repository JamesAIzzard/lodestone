import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, AlertCircle, RefreshCw, Cloud, Plus, Trash2, Maximize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  StatusCell,
  PriorityCell,
  DateCell,
  RecurrenceCell,
  isOverdue,
  getTodayStr,
} from '@/components/TaskCells';
import type { MemoryRecord, MemoryStatusValue, PriorityLevel } from '../../shared/types';

// ── Main view ─────────────────────────────────────────────────────────────────

export default function TasksView() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<MemoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [filterPriority, setFilterPriority] = useState<PriorityLevel | 'all'>('all');
  const [editingTopicId, setEditingTopicId] = useState<number | null>(null);
  const [editingTopicValue, setEditingTopicValue] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [newTaskTopic, setNewTaskTopic] = useState('');
  const [pendingCreates, setPendingCreates] = useState<{ key: number; topic: string }[]>([]);
  const pendingKeyRef = useRef(0);
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
    recurrence?: string | null;
    topic?: string;
  }) {
    setTasks(prev => prev.map(t =>
      t.id === id ? { ...t, ...fields, updatedAt: new Date().toISOString() } : t
    ));
    const result = await window.electronAPI?.reviseTask(id, fields as Record<string, unknown>);
    if (!result?.success) {
      loadTasks(showCompletedRef.current);
    } else if (result.nextActionDate) {
      // Recurring task was auto-advanced — reload to show updated date/status
      loadTasks(showCompletedRef.current);
    }
  }

  async function skipTask(id: number) {
    const result = await window.electronAPI?.skipTask(id);
    if (result?.success) {
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

  async function commitCreate() {
    const trimmed = newTaskTopic.trim();
    if (!trimmed) return;
    setIsCreating(false);
    setNewTaskTopic('');
    const key = ++pendingKeyRef.current;
    setPendingCreates(prev => [...prev, { key, topic: trimmed }]);
    await window.electronAPI?.createTask(trimmed);
    setPendingCreates(prev => prev.filter(p => p.key !== key));
    loadTasks(showCompletedRef.current);
  }

  async function deleteTask(id: number) {
    setTasks(prev => prev.filter(t => t.id !== id));
    const result = await window.electronAPI?.deleteTask(id);
    if (!result?.success) loadTasks(showCompletedRef.current);
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

        {!loading && !error && filtered.length === 0 && (
          <p className="text-sm text-muted-foreground">No tasks found.</p>
        )}

        {(isCreating || pendingCreates.length > 0 || filtered.length > 0) && (
          <div className="flex flex-col divide-y divide-border/50">
            {/* Create row */}
            {isCreating && (
              <div className="flex items-center gap-3 py-2.5">
                <div className="w-14 shrink-0" />
                <div className="w-24 shrink-0" />
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
                <div className="w-5 shrink-0" />
                <div className="w-24 shrink-0" />
                <div className="w-10 shrink-0" />
                <div className="w-7 shrink-0" />
                <div className="w-7 shrink-0" />
              </div>
            )}

            {/* Pending create rows */}
            {pendingCreates.map(({ key, topic }) => (
              <div key={key} className="flex items-center gap-3 py-2.5 opacity-50">
                <div className="w-14 shrink-0" />
                <div className="w-24 shrink-0 flex items-center justify-center">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="block truncate text-sm text-muted-foreground italic">{topic}</span>
                </div>
                <div className="w-5 shrink-0" />
                <div className="w-24 shrink-0" />
                <div className="w-10 shrink-0" />
                <div className="w-7 shrink-0" />
                <div className="w-7 shrink-0" />
              </div>
            ))}

            {filtered.map((task) => {
              const overdue = isOverdue(task);
              const isEditingTopic = editingTopicId === task.id;

              return (
                <div
                  key={task.id}
                  className={cn(
                    'group flex items-center gap-3 py-2.5',
                    overdue && '-mx-1 px-1 border-l-2 border-l-amber-500/50',
                  )}
                >
                  {/* UID */}
                  <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground/25 select-all">
                    m{task.id}
                  </span>

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
                    recurrence={task.recurrence}
                  />

                  {/* Recurrence */}
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

                  {/* Expand to detail */}
                  <button
                    onClick={() => navigate(`/tasks/${task.id}`, { state: { task } })}
                    title="Open detail"
                    className="w-7 shrink-0 flex items-center justify-center h-5 rounded text-muted-foreground/0 group-hover:text-muted-foreground/40 hover:!text-foreground transition-colors"
                  >
                    <Maximize2 className="h-3 w-3" />
                  </button>

                  {/* Delete */}
                  <button
                    onClick={() => deleteTask(task.id)}
                    title="Delete task"
                    className="w-7 shrink-0 flex items-center justify-center h-5 rounded text-muted-foreground/0 group-hover:text-muted-foreground/40 hover:!text-red-400 transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
