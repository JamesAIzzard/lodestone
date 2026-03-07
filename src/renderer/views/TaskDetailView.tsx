import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { ChevronLeft, Loader2, AlertCircle, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TaskBodyEditor } from '@/components/TaskBodyEditor';
import {
  StatusCell,
  PriorityCell,
  DateCell,
  DueDateCell,
  RecurrenceCell,
  ProjectCell,
  isOverdue,
  isPastDue,
  getTodayStr,
} from '@/components/TaskCells';
import type { MemoryRecord, ProjectWithCounts } from '../../shared/types';

// ── Component ──────────────────────────────────────────────────────────────

export default function TaskDetailView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  const [task, setTask] = useState<MemoryRecord | null>(
    (location.state as { task?: MemoryRecord } | null)?.task ?? null,
  );
  const [loading, setLoading] = useState(!task);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isEditingTopic, setIsEditingTopic] = useState(false);
  const [topicValue, setTopicValue] = useState(task?.topic ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [projects, setProjects] = useState<ProjectWithCounts[]>([]);

  const taskRef = useRef(task);
  taskRef.current = task;

  // ── Fetch task if not passed via state ─────────────────────────────────

  const fetchTask = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI?.listTasks({ includeCompleted: true, includeCancelled: true });
      if (!result?.success) {
        setError(result?.error ?? 'Failed to load task');
        return;
      }
      const found = (result.tasks as MemoryRecord[]).find(t => t.id === parseInt(id, 10));
      if (!found) { setError('Task not found'); return; }
      setTask(found);
      setTopicValue(found.topic);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!task) fetchTask();
    else setTopicValue(task.topic);
  }, [task, fetchTask]);

  useEffect(() => {
    window.electronAPI?.listProjects().then(r => { if (r?.success) setProjects(r.projects ?? []); });
  }, []);

  // ── Revise ─────────────────────────────────────────────────────────────

  async function revise(taskId: number, fields: Record<string, unknown>) {
    setSaveError(null);
    setTask(prev => prev ? { ...prev, ...fields, updatedAt: new Date().toISOString() } : prev);
    const result = await window.electronAPI?.reviseTask(taskId, fields);
    if (!result?.success) {
      setSaveError(result?.error ?? 'Save failed');
      fetchTask();
    } else if (result.nextActionDate) {
      // Recurring task was auto-advanced — apply new state locally
      setTask(prev => prev ? {
        ...prev,
        status: 'open' as typeof prev.status,
        completedOn: null,
        actionDate: result.nextActionDate!,
        updatedAt: new Date().toISOString(),
      } : prev);
    }
  }

  async function skipTask() {
    if (!task) return;
    const result = await window.electronAPI?.skipTask(task.id);
    if (result?.success) fetchTask();
  }

  // ── Topic editing ──────────────────────────────────────────────────────

  async function commitTopicEdit() {
    setIsEditingTopic(false);
    const trimmed = topicValue.trim();
    if (trimmed && task && trimmed !== task.topic) {
      await revise(task.id, { topic: trimmed });
    } else if (!trimmed && task) {
      setTopicValue(task.topic);
    }
  }

  // ── Delete ─────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!task) return;
    await window.electronAPI?.deleteTask(task.id);
    navigate('/tasks');
  }

  // ── Render ─────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-6 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading...
      </div>
    );
  }

  if (error || !task) {
    return (
      <div className="px-6 py-8">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Back
        </button>
        <div className="flex items-center gap-2 text-sm text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error ?? 'Task not found'}
        </div>
      </div>
    );
  }

  const overdue = isOverdue(task);

  return (
    <div className="flex flex-col h-full">

      {/* Header */}
      <div className="sticky top-0 z-20 bg-background px-6 pt-6 pb-4 border-b border-border shrink-0">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-5"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Tasks
        </button>

        <div className="mb-4 max-w-2xl">
          {isEditingTopic ? (
            <input
              autoFocus
              value={topicValue}
              onChange={(e) => setTopicValue(e.target.value)}
              onBlur={commitTopicEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTopicEdit();
                if (e.key === 'Escape') { setIsEditingTopic(false); setTopicValue(task.topic); }
              }}
              className="w-full bg-transparent text-xl font-semibold text-foreground border-b border-ring focus:outline-none leading-snug"
            />
          ) : (
            <h1
              onClick={() => setIsEditingTopic(true)}
              className={cn(
                'text-xl font-semibold leading-snug cursor-text',
                task.status === 'completed'
                  ? 'line-through text-muted-foreground/50'
                  : 'text-foreground',
              )}
            >
              {task.topic}
            </h1>
          )}
        </div>

        <div className="flex items-end gap-4">
          <div className="flex flex-col items-center gap-1">
            <span className="text-[9px] uppercase tracking-wide text-muted-foreground/30 leading-none">Status</span>
            <StatusCell
              value={task.status}
              onChange={(v) => revise(task.id, { status: v })}
              isRecurring={!!task.recurrence}
              onSkip={skipTask}
            />
          </div>
          <div className="flex flex-col items-center gap-1">
            <span className="text-[9px] uppercase tracking-wide text-muted-foreground/30 leading-none">Priority</span>
            <PriorityCell
              value={task.priority}
              onChange={(v) => revise(task.id, { priority: v })}
            />
          </div>
          <div className="flex flex-col items-center gap-1">
            <span className="text-[9px] uppercase tracking-wide text-muted-foreground/30 leading-none">Next action</span>
            <DateCell
              value={task.actionDate}
              overdue={overdue}
              onChange={(v) => revise(task.id, { actionDate: v })}
            />
          </div>
          <div className="flex flex-col items-center gap-1">
            <span className="text-[9px] uppercase tracking-wide text-muted-foreground/30 leading-none">Due</span>
            <DueDateCell
              value={task.dueDate}
              pastDue={isPastDue(task)}
              onChange={(v) => revise(task.id, { dueDate: v })}
            />
          </div>
          <div className="flex flex-col items-center gap-1">
            <span className="text-[9px] uppercase tracking-wide text-muted-foreground/30 leading-none">Repeat</span>
            <RecurrenceCell
              value={task.recurrence}
              onChange={(v) => {
                // When setting recurrence on a task without a date, auto-set to today
                if (v && !task.actionDate) {
                  revise(task.id, { recurrence: v, actionDate: getTodayStr() });
                } else {
                  revise(task.id, { recurrence: v });
                }
              }}
            />
          </div>
          <div className="flex flex-col items-center gap-1">
            <span className="text-[9px] uppercase tracking-wide text-muted-foreground/30 leading-none">Project</span>
            <ProjectCell
              value={task.projectId}
              projects={projects}
              onChange={(v) => revise(task.id, { projectId: v })}
            />
          </div>
        </div>
      </div>

      {/* Body editor - full width, fills remaining height */}
      <div className="flex flex-col flex-1 min-h-0 px-6 pt-4 pb-4">
        <TaskBodyEditor
          initialContent={task.body ?? ''}
          onChange={(markdown) => revise(task.id, { body: markdown })}
        />
        {saveError && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-red-400 shrink-0">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {saveError}
          </div>
        )}
      </div>

      {/* Delete */}
      <div className="px-6 pb-5 shrink-0 border-t border-border/30">
        {confirmDelete ? (
          <div className="flex items-center gap-3 pt-4">
            <span className="text-xs text-muted-foreground">Delete this task?</span>
            <button
              onClick={handleDelete}
              className="text-xs text-red-400 hover:text-red-300 transition-colors font-medium"
            >
              Yes, delete
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="flex items-center gap-1.5 pt-4 text-xs text-muted-foreground/40 hover:text-red-400 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete task
          </button>
        )}
      </div>
    </div>
  );
}
