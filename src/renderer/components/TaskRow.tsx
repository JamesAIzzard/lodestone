import { useState, useRef } from 'react';
import { Plus, Trash2, GripVertical, Loader2 } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@/lib/utils';
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
  formatDate,
} from '@/components/TaskCells';
import type { MemoryRecord, ProjectWithCounts } from '../../shared/types';

// ── Props ─────────────────────────────────────────────────────────────────────

export interface TaskRowProps {
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

// ── Task row content ──────────────────────────────────────────────────────────

export function TaskRowContent({
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
          onClick={(e) => { e.stopPropagation(); if (!isDragging) onNavigate(task.id, task); }}
          className="w-4 shrink-0 flex items-center justify-center cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-40 hover:!opacity-70 transition-opacity"
        >
          <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
      )}

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
            onClick={(e) => { e.stopPropagation(); onNavigate(task.id, task); }}
            onDoubleClick={(e) => { e.stopPropagation(); onStartEditTopic(task); }}
            title={task.topic}
            className={cn(
              'text-sm cursor-pointer line-clamp-3 hover:underline',
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

// ── Sortable wrapper ──────────────────────────────────────────────────────────

export function SortableTaskRow(props: TaskRowProps) {
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

export function InsertZone({ onInsert }: { onInsert: (anchorY: number) => void }) {
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

// ── Pending create row ────────────────────────────────────────────────────────

export function PendingCreateRow({ topic }: { topic: string }) {
  return (
    <div className="flex items-center gap-2 py-2.5 opacity-50">
      <div className="w-4 shrink-0" />
      <div className="w-[72px] shrink-0" />
      <div className="w-12 shrink-0 flex items-center justify-center">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <span className="block truncate text-sm text-muted-foreground italic">{topic}</span>
      </div>
      <div className="shrink-0 flex items-center gap-1">
        <div className="w-32" /><div className="w-6" /><div className="w-[72px]" /><div className="w-[72px]" /><div className="w-7" />
      </div>
    </div>
  );
}

// ── Inline insert row ─────────────────────────────────────────────────────────

export function InlineInsertRow({
  date,
  topic,
  onTopicChange,
  onCommit,
  onCancel,
}: {
  date: string;
  topic: string;
  onTopicChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-2 py-2.5 -mx-2 px-2 rounded bg-primary/5 border border-primary/20">
      <div className="w-4 shrink-0" />
      <div className="w-[72px] shrink-0 text-center">
        <span className="text-[11px] text-primary/60">{formatDate(date)}</span>
      </div>
      <div className="w-12 shrink-0" />
      <div className="flex-1 min-w-0">
        <input
          autoFocus
          placeholder="New task…"
          value={topic}
          onChange={(e) => onTopicChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCommit();
            if (e.key === 'Escape') onCancel();
          }}
          onBlur={() => { if (!topic.trim()) onCancel(); }}
          className="w-full bg-transparent text-sm text-foreground border-b border-primary/30 focus:outline-none placeholder:text-muted-foreground/30"
        />
      </div>
      <div className="shrink-0 flex items-center gap-1">
        <div className="w-32" /><div className="w-6" /><div className="w-[72px]" /><div className="w-[72px]" /><div className="w-7" />
      </div>
    </div>
  );
}
