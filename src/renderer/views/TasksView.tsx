import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, AlertCircle, RefreshCw, Cloud, Plus, Search, X, ChevronLeft, Folder, FolderOpen } from 'lucide-react';
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
} from '@dnd-kit/sortable';
import ActionButton from '@/components/ActionButton';
import { cn } from '@/lib/utils';
import { useSessionState } from '@/hooks/use-session-state';
import ToggleSwitch from '@/components/ToggleSwitch';
import DateRangeFilter, { type DatePreset, getDateRange, pickCrossDate } from '@/components/DateRangeFilter';
import { ProjectSearchFilter } from '@/components/ProjectFilters';
import { TaskRowContent, SortableTaskRow, InsertZone, PendingCreateRow, InlineInsertRow } from '@/components/TaskRow';
import ProjectsSubView from '@/components/ProjectsSubView';
import {
  isOverdue,
  getTodayStr,
} from '@/components/TaskCells';
import type { MemoryRecord, MemoryStatusValue, PriorityLevel, ProjectWithCounts } from '../../shared/types';

type SubView = 'tasks' | 'projects';

// ── Week-bucket helpers ───────────────────────────────────────────────────────

type WeekBucket = 'overdue' | 'today' | 'this-week' | 'next-week' | '2-weeks' | '3-weeks' | 'further';

const WEEK_BUCKET_META: Record<WeekBucket, { label: string; borderClass: string; textClass: string }> = {
  'overdue':   { label: 'Overdue',     borderClass: 'border-amber-500/50',   textClass: 'text-amber-500/60' },
  'today':     { label: 'Today',       borderClass: 'border-blue-400/50',    textClass: 'text-blue-400/60' },
  'this-week': { label: 'This week',   borderClass: 'border-blue-500/30',    textClass: 'text-blue-500/40' },
  'next-week': { label: 'Next week',   borderClass: 'border-violet-500/35',  textClass: 'text-violet-500/45' },
  '2-weeks':   { label: '2 weeks out', borderClass: 'border-emerald-500/30', textClass: 'text-emerald-500/40' },
  '3-weeks':   { label: '3 weeks out', borderClass: 'border-orange-500/25',  textClass: 'text-orange-500/35' },
  'further':   { label: 'Further out', borderClass: 'border-slate-500/20',   textClass: 'text-slate-500/30' },
};

/** Return the Monday-based start-of-week for a given Date. */
function startOfWeek(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  const day = copy.getDay(); // 0=Sun
  const diff = day === 0 ? 6 : day - 1; // shift so Monday = 0
  copy.setDate(copy.getDate() - diff);
  return copy;
}

function getWeekBucket(task: MemoryRecord, todayStr: string, thisWeekStart: Date): WeekBucket {
  if (isOverdue(task, todayStr)) return 'overdue';
  const dateStr = task.actionDate ?? todayStr;
  if (dateStr === todayStr) return 'today';
  const d = new Date(dateStr + 'T00:00:00');
  const taskWeekStart = startOfWeek(d);
  const diffWeeks = Math.round((taskWeekStart.getTime() - thisWeekStart.getTime()) / (7 * 864e5));
  if (diffWeeks <= 0) return 'this-week';
  if (diffWeeks === 1) return 'next-week';
  if (diffWeeks === 2) return '2-weeks';
  if (diffWeeks === 3) return '3-weeks';
  return 'further';
}

/** Map each unique action-date to an alternating 0/1 shade for row striping. */
function buildDateShadeMap(tasks: MemoryRecord[]): Map<string, number> {
  const map = new Map<string, number>();
  let shade = 0;
  for (const t of tasks) {
    const d = t.actionDate ?? '';
    if (!map.has(d)) {
      map.set(d, shade);
      shade = shade === 0 ? 1 : 0;
    }
  }
  return map;
}

// ── Main view ─────────────────────────────────────────────────────────────────

export default function TasksView() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<MemoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useSessionState('tasks.showCompleted', false);
  const [showCancelled, setShowCancelled] = useSessionState('tasks.showCancelled', false);
  const [editingTopicId, setEditingTopicId] = useState<number | null>(null);
  const [editingTopicValue, setEditingTopicValue] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [newTaskTopic, setNewTaskTopic] = useState('');
  const [pendingCreates, setPendingCreates] = useState<{ key: number; topic: string; index: number }[]>([]);
  const pendingKeyRef = useRef(0);
  const showCompletedRef = useRef(showCompleted);
  showCompletedRef.current = showCompleted;
  const showCancelledRef = useRef(showCancelled);
  showCancelledRef.current = showCancelled;
  const [recentlyCompleted, setRecentlyCompleted] = useState<Set<number>>(new Set());
  const completionTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const [searchQuery, setSearchQuery] = useSessionState('tasks.searchQuery', '');
  const [searchResults, setSearchResults] = useState<(MemoryRecord & { _score?: number })[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [datePreset, setDatePreset] = useSessionState<DatePreset>('tasks.datePreset', 'all');
  const [customFrom, setCustomFrom] = useSessionState<string | null>('tasks.customFrom', null);
  const [customTo, setCustomTo] = useSessionState<string | null>('tasks.customTo', null);
  const [subView, setSubView] = useState<SubView>('tasks');
  const [newProjectTrigger, setNewProjectTrigger] = useState(0);
  const [projects, setProjects] = useState<ProjectWithCounts[]>([]);
  const [selectedProjectIds, setSelectedProjectIds] = useSessionState<number[]>('tasks.selectedProjectIds', []);

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
      console.error('[TasksView] revise failed for task', id, '— fields:', fields, '— error:', result?.error);
      loadTasks(reloadOpts());
    } else if (result.nextActionDate) {
      // Recurring task was auto-advanced — apply the new state locally
      const existing = completionTimers.current.get(id);
      if (existing) { clearTimeout(existing); completionTimers.current.delete(id); }
      setRecentlyCompleted(prev => { const next = new Set(prev); next.delete(id); return next; });
      optimisticUpdate(id, t => ({
        ...t,
        status: 'open' as MemoryStatusValue,
        completedOn: null,
        actionDate: result.nextActionDate!,
        updatedAt: new Date().toISOString(),
      }));
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
    setPendingCreates(prev => [...prev, { key, topic: trimmed, index: -1 }]);
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

  const todayStr = getTodayStr();
  const filtered = tasks
    .filter(t =>
      recentlyCompleted.has(t.id) ||
      (t.status != null &&
        (showCompleted || t.status !== 'completed') &&
        (showCancelled || t.status !== 'cancelled') &&
        (isOverdue(t, todayStr) || (dateFilter(t) && projectFilter(t))))
    )
    .sort((a, b) => {
      const aOver = isOverdue(a, todayStr);
      const bOver = isOverdue(b, todayStr);
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
         (isOverdue(t, todayStr) || (dateFilter(t) && projectFilter(t)))))
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
  const [insertBlockedFlash, setInsertBlockedFlash] = useState(false);
  const insertBlockedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as number);
  }

  /** Reorder tasks within a single date group and persist positions. */
  async function reorderSameDay(draggedId: number, overId: number, actionDate: string, insertAfter: boolean) {
    const sameDateTasks = displayTasks.filter(t => t.actionDate === actionDate);
    const sameDateTasksReordered = [...sameDateTasks];
    const fromIdx = sameDateTasksReordered.findIndex(t => t.id === draggedId);
    const overIdx = sameDateTasksReordered.findIndex(t => t.id === overId);
    if (fromIdx === -1 || overIdx === -1) return;
    // Place before or after the "over" item depending on drop position
    let toIdx = insertAfter ? overIdx + 1 : overIdx;
    // Removing from fromIdx shifts everything after it left by one
    if (fromIdx < toIdx) toIdx--;
    if (fromIdx === toIdx) return;
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

    // Determine whether the drop landed above or below the "over" item's center
    const translatedRect = active.rect.current.translated;
    const overRect = over.rect;
    let insertAfter = true; // safe default
    if (translatedRect && overRect) {
      const activeCenterY = translatedRect.top + translatedRect.height / 2;
      const overCenterY = overRect.top + overRect.height / 2;
      insertAfter = activeCenterY > overCenterY;
    }

    // Same-day reorder
    if (draggedTask.actionDate === overTask.actionDate) {
      const actionDate = draggedTask.actionDate;
      if (!actionDate) return;
      await reorderSameDay(draggedId, overId, actionDate, insertAfter);
      return;
    }

    // Cross-date drop: auto-pick target date and apply immediately
    if (!draggedTask.actionDate) return;

    // Use the drop target's date — when you drop onto a task, you join its date group
    const targetDate = overTask.actionDate ?? draggedTask.actionDate;

    const targetDateTasks = displayTasks.filter(t => t.actionDate === targetDate && t.id !== draggedId);
    let position: number;
    if (targetDate === overTask.actionDate && targetDateTasks.length > 0) {
      // Dropping into an existing date group — insert at the drop position
      const overIdx = targetDateTasks.findIndex(t => t.id === overId);
      if (overIdx !== -1) {
        const overPos = targetDateTasks[overIdx].dayOrderPosition ?? (overIdx + 1);
        if (insertAfter) {
          const nextPos = overIdx < targetDateTasks.length - 1
            ? (targetDateTasks[overIdx + 1].dayOrderPosition ?? (overIdx + 2))
            : overPos + 2;
          position = (overPos + nextPos) / 2;
        } else {
          const prevPos = overIdx > 0
            ? (targetDateTasks[overIdx - 1].dayOrderPosition ?? overIdx)
            : 0;
          position = (prevPos + overPos) / 2;
        }
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

  function handleInsertClick(index: number, _anchorY: number) {
    // Block when multiple projects are in the filter — ambiguous which to assign
    if (selectedProjectIds.length > 1) {
      clearTimeout(insertBlockedTimer.current);
      setInsertBlockedFlash(true);
      insertBlockedTimer.current = setTimeout(() => setInsertBlockedFlash(false), 3000);
      return;
    }

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
      setInsertAt({ index, date: aboveDate, position: computePosition(aboveTask, belowTask), projectId });
      setInsertTopic('');
    } else if (!aboveDate && belowDate) {
      setInsertAt({ index, date: belowDate, position: computePosition(null, belowTask), projectId });
      setInsertTopic('');
    } else if (aboveDate && !belowDate) {
      setInsertAt({ index, date: aboveDate, position: computePosition(aboveTask, null), projectId });
      setInsertTopic('');
    } else if (aboveDate && belowDate && aboveDate !== belowDate) {
      const date = pickCrossDate(aboveDate, belowDate);
      const dateTasks = displayTasks.filter(t => t.actionDate === date);
      const position = dateTasks.length > 0
        ? Math.max(...dateTasks.map(t => t.dayOrderPosition ?? 0)) + 1
        : 1;
      setInsertAt({ index, date, position, projectId });
      setInsertTopic('');
    } else {
      setInsertAt({ index, date: getTodayStr(), position: 1, projectId });
      setInsertTopic('');
    }
  }

  async function commitInsert() {
    if (!insertAt) return;
    const trimmed = insertTopic.trim();
    if (!trimmed) { setInsertAt(null); return; }
    const { index, date, position, projectId } = insertAt;
    setInsertAt(null);
    setInsertTopic('');
    const key = ++pendingKeyRef.current;
    setPendingCreates(prev => [...prev, { key, topic: trimmed, index }]);
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
              {insertBlockedFlash && (
                <p className="text-[10px] text-amber-500/80 mt-1 ml-2 animate-in fade-in duration-150">
                  Filter to one project to add tasks inline
                </p>
              )}
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
              <div className="flex flex-col">
                {/* Column header row */}
                <div className="flex items-center gap-2 pb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/40 font-medium select-none border-b border-border/30">
                  {!isSearching && <div className="w-4 shrink-0" />}
                  <div className="w-[72px] shrink-0 text-center">Action</div>
                  <div className="w-12 shrink-0 text-center">Status</div>
                  <div className="flex-1 min-w-0">Task</div>
                  <div className="shrink-0 flex items-center gap-1">
                    <div className="w-32 text-left pl-1.5">Project</div>
                    <div className="w-6 text-center">Pri</div>
                    <div className="w-[72px] text-center">Due</div>
                    <div className="w-[72px] text-center">Repeat</div>
                    <div className="w-7" />
                  </div>
                </div>

                {/* Create row */}
                {isCreating && (
                  <div className="flex items-center gap-2 py-2.5">
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
                      <div className="w-32" /><div className="w-6" /><div className="w-[72px]" /><div className="w-[72px]" /><div className="w-7" />
                    </div>
                  </div>
                )}

                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  autoScroll={{
                    canScroll(element) {
                      return element !== document.documentElement && element !== document.body;
                    },
                  }}
                >
                  <SortableContext items={taskIds} strategy={() => null}>
                    {(() => {
                      const dateShade = buildDateShadeMap(displayTasks);

                      // Week-bucket classification for each task
                      const thisWeekStart = startOfWeek(new Date());
                      const showBuckets = !isSearching;
                      const taskBuckets = showBuckets
                        ? displayTasks.map(t => getWeekBucket(t, todayStr, thisWeekStart))
                        : null;

                      const showInsertZones = !isSearching && !activeId && !insertAt;

                      // Build flat elements, inserting week-group labels at bucket boundaries
                      const elements: React.ReactNode[] = [];
                      let currentBucket: WeekBucket | null = null;
                      let groupElements: React.ReactNode[] = [];

                      function flushGroup() {
                        if (groupElements.length === 0) return;
                        if (!showBuckets || !currentBucket) {
                          elements.push(...groupElements);
                          groupElements = [];
                          return;
                        }
                        const meta = WEEK_BUCKET_META[currentBucket];
                        const flushed = [...groupElements];
                        const isOverdueBucket = currentBucket === 'overdue';
                        elements.push(
                          <div
                            key={`wg-${currentBucket}`}
                            className={cn('border-l-2 border-t rounded-tl-sm mt-1.5 pl-2', meta.borderClass)}
                            style={isOverdueBucket ? {
                              backgroundImage: 'repeating-linear-gradient(-45deg, transparent, transparent 8px, rgba(245,158,11,0.04) 8px, rgba(245,158,11,0.04) 16px)',
                            } : undefined}
                          >
                            {/* Week label — right-aligned above the group */}
                            <div className="flex justify-end pr-1 pt-0.5 pb-0.5 select-none">
                              <span className={cn('text-[9px] font-medium tracking-wider uppercase whitespace-nowrap', meta.textClass)}>
                                {meta.label}
                              </span>
                            </div>
                            {flushed}
                          </div>
                        );
                        groupElements = [];
                      }

                      for (let i = 0; i <= displayTasks.length; i++) {
                        const bucket = (taskBuckets && i < displayTasks.length) ? taskBuckets[i] : null;

                        // On bucket boundary, flush previous group
                        if (bucket !== currentBucket) {
                          flushGroup();
                          currentBucket = bucket;
                        }

                        // Pending creates at this position
                        for (const pc of pendingCreates) {
                          if ((pc.index === -1 && i === 0) || pc.index === i) {
                            groupElements.push(<PendingCreateRow key={`pending-${pc.key}`} topic={pc.topic} />);
                          }
                        }

                        // Insert zone or inline creation row at this position
                        if (insertAt?.index === i) {
                          groupElements.push(
                            <InlineInsertRow
                              key="insert-row"
                              date={insertAt.date}
                              topic={insertTopic}
                              onTopicChange={setInsertTopic}
                              onCommit={commitInsert}
                              onCancel={() => { setInsertAt(null); setInsertTopic(''); }}
                            />
                          );
                        } else if (showInsertZones && (i < displayTasks.length || displayTasks.length > 0)) {
                          groupElements.push(
                            <InsertZone key={`iz-${i}`} onInsert={(y) => handleInsertClick(i, y)} />
                          );
                        }

                        // Task row
                        if (i < displayTasks.length) {
                          const task = displayTasks[i];
                          groupElements.push(
                            <SortableTaskRow
                              key={task.id}
                              task={task}
                              stripe={dateShade.get(task.actionDate ?? '') ?? 0}
                              overdue={isOverdue(task, todayStr)}
                              today={todayStr}
                              isEditingTopic={editingTopicId === task.id}
                              editingTopicValue={editingTopicValue}
                              isGracePeriod={recentlyCompleted.has(task.id)}
                              isSearching={isSearching}
                              projects={projects}
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

                      // Flush final group (trailing insert zones land here with
                      // currentBucket=null, so flushGroup pushes them directly)
                      flushGroup();

                      return elements;
                    })()}
                  </SortableContext>
                  <DragOverlay>
                    {activeTask && (
                      <div className="shadow-lg scale-[1.02] bg-background rounded border border-border">
                        <TaskRowContent
                          task={activeTask}
                          stripe={0}
                          overdue={isOverdue(activeTask, todayStr)}
                          today={todayStr}
                          isEditingTopic={false}
                          editingTopicValue=""
                          isGracePeriod={false}
                          isSearching={false}
                          projects={projects}
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
