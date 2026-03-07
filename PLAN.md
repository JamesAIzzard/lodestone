# Plan: Drag to Reorder Tasks

## Overview

Implement drag-to-reorder for the task list, where dragging a task changes its `action_date` and/or within-day position. The list order _is_ the schedule — no dependency graph needed.

This plan also mandates that every memory with a non-null `status` must have an `action_date` (defaulting to creation date), and introduces a `day_order` table for manual within-day sequencing.

## Current State

- **No drag-and-drop** libraries or code exist
- **No `day_order` table** — tasks sorted by `action_date ASC`, `priority DESC`
- **`due_date`** is fully implemented (migration 0003)
- **`action_date` is optional** — tasks can have `status` without `action_date`
- **UI stack**: React 19, Tailwind CSS 4, Radix UI, Lucide icons
- **Task rows**: `TasksView.tsx` (1479 lines), cells in `TaskCells.tsx` (709 lines)
- **Visual grouping**: alternating date-stripe backgrounds, no explicit date headers
- **CalendarGrid/CalendarPicker** components already exist in TaskCells.tsx
- **State**: component-level React hooks, no global state manager

---

## Phase 0 — Prerequisites

_Enforce that all tasks have an action_date. Without this, drag-to-reorder has undefined behavior for unscheduled tasks._

### 0.1 Migration: Mandate action_date for tasks

**`worker/migrations/0005_mandate_action_date.sql`** (new):
```sql
-- Backfill: any memory with a status but no action_date gets today's date
UPDATE memories
SET action_date = strftime('%Y-%m-%d', 'now'),
    updated_at  = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status IS NOT NULL
  AND action_date IS NULL
  AND deleted_at IS NULL;
```

> **Note**: We cannot add a SQL CHECK constraint because knowledge memories (status IS NULL) legitimately have no action_date. The constraint is enforced in application code.

### 0.2 Enforce in worker application code

**`worker/src/d1-memory-service.ts`**:
- In `remember()`: when `status` is non-null and `actionDate` is null, default `actionDate` to today (`new Date().toISOString().slice(0, 10)`).
- In `revise()`: if updating `status` from null to non-null and `actionDate` is still null, default to today. If clearing `actionDate` to null and `status` is non-null, reject with an error message.

**`worker/src/tools/memory.ts`**:
- Update `lodestone_remember` tool description to state that tasks (memories with status) always have an action_date, defaulting to today.
- Update `lodestone_revise` tool description similarly.

### 0.3 Enforce in desktop REST handler

**`worker/src/auth-handler.ts`**:
- `POST /tasks`: if `actionDate` is not provided, default to today.
- `PATCH /tasks/:id`: if setting `status` to non-null and the task has no `actionDate`, default to today. If clearing `actionDate`, reject if `status` is non-null.

### 0.4 Enforce in desktop UI

**`src/renderer/views/TasksView.tsx`**:
- The "create task" flow already opens an inline row. Ensure `actionDate` defaults to today when creating.
- When a user clears the action date cell on a task that has a status, show a warning or prevent it.

### Files modified
- `worker/migrations/0005_mandate_action_date.sql` (new)
- `worker/src/d1-memory-service.ts`
- `worker/src/tools/memory.ts`
- `worker/src/auth-handler.ts`
- `src/renderer/views/TasksView.tsx`

---

## Phase 1 — day_order Table & Backend

_Create the within-day ordering mechanism. This is a sparse table — rows only exist when the user explicitly drags._

### 1.1 Migration: day_order table

**`worker/migrations/0006_day_order.sql`** (new):
```sql
CREATE TABLE day_order (
  memory_id   INTEGER NOT NULL,
  action_date TEXT    NOT NULL,
  position    REAL    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (memory_id, action_date),
  FOREIGN KEY (memory_id) REFERENCES memories(id)
);

CREATE INDEX idx_day_order_date ON day_order(action_date);
```

> **Why REAL for position?** Fractional indexing. When inserting between position 1.0 and 2.0, use 1.5. This avoids renumbering on every drag. If precision degrades after many reorders, a periodic renumber (1.0, 2.0, 3.0...) can be triggered.

### 1.2 Write functions

**`worker/src/d1/write.ts`** — add:
- `upsertDayOrder(db, memoryId, actionDate, position)` — INSERT OR REPLACE into day_order.
- `deleteDayOrder(db, memoryId, actionDate?)` — remove day_order entry. Called when a task's action_date changes (old date entry cleaned up).
- `rebalanceDayOrder(db, actionDate)` — reset positions to integers (1.0, 2.0, ...) for a given date. Called when fractional precision gets too small (gap < 0.001).

### 1.3 Read functions

**`worker/src/d1/read.ts`** — modify `getAllTasks`:
```sql
SELECT m.*, do.position AS day_order_position
FROM memories m
LEFT JOIN day_order do ON do.memory_id = m.id AND do.action_date = m.action_date
WHERE m.deleted_at IS NULL
  AND m.status IS NOT NULL
ORDER BY
  CASE WHEN m.action_date IS NULL THEN 1 ELSE 0 END,
  m.action_date ASC,
  CASE WHEN do.position IS NOT NULL THEN 0 ELSE 1 END,
  do.position ASC,
  COALESCE(m.priority, 0) DESC
```

Sort order: action_date ASC → manual position ASC (if set) → priority DESC (fallback).

### 1.4 REST endpoints

**`worker/src/auth-handler.ts`** — add:
- `PUT /tasks/:id/day-order` — body: `{ actionDate: string, position: number }`. Upserts day_order for the given task.
- `DELETE /tasks/:id/day-order` — removes day_order entry for the task.
- Modify `PATCH /tasks/:id` — when `actionDate` changes, delete the old day_order entry (the task is now at the end of its new date group by default).

### 1.5 Add to MemoryRecord type

**`worker/src/shared/types.ts`** and **`src/shared/types.ts`**:
- Add `dayOrderPosition: number | null` to `MemoryRecord`.

### 1.6 IPC + Preload

**`src/preload.ts`** — expose:
- `updateDayOrder(taskId: number, actionDate: string, position: number)`
- `deleteDayOrder(taskId: number)`

**`src/main/ipc-handlers.ts`** — add handlers for `tasks:update-day-order` and `tasks:delete-day-order`.

### 1.7 Client-side sorting

**`src/renderer/views/TasksView.tsx`** — update the sort comparator:
```typescript
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
})
```

### Files modified
- `worker/migrations/0006_day_order.sql` (new)
- `worker/src/d1/write.ts`
- `worker/src/d1/read.ts`
- `worker/src/d1/helpers.ts` (map day_order_position)
- `worker/src/auth-handler.ts`
- `worker/src/shared/types.ts`
- `src/shared/types.ts`
- `src/preload.ts`
- `src/main/ipc-handlers.ts`
- `src/renderer/views/TasksView.tsx`

---

## Phase 2 — Core Drag & Drop

_Add drag handles and same-day reordering. This is the simplest drag interaction — no date changes, just within-day position updates._

### 2.1 Install @dnd-kit

```bash
npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

**Why @dnd-kit?** Modern React DnD library, actively maintained, supports keyboard accessibility, touch devices, and custom drag overlays. Tree-shakeable. React 19 compatible.

### 2.2 Add drag handle to task rows

**`src/renderer/views/TasksView.tsx`**:
- Add a `GripVertical` icon (from lucide-react) as the leftmost element of each task row, before the UID button.
- Width: `w-5`, visible on hover (`opacity-0 group-hover:opacity-100`), cursor: `grab`.
- The handle is the drag activator (only the handle starts a drag, not the whole row).

### 2.3 Wrap task list in DnD context

**`src/renderer/views/TasksView.tsx`** or new **`src/renderer/components/DraggableTaskList.tsx`**:

```
<DndContext onDragStart onDragOver onDragEnd sensors collisionDetection>
  <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
    {displayTasks.map(task => (
      <SortableTaskRow key={task.id} task={task} ... />
    ))}
  </SortableContext>
  <DragOverlay>
    <TaskRowPreview task={activeTask} />
  </DragOverlay>
</DndContext>
```

- **Sensors**: pointer sensor (with activation distance of 5px to distinguish from click), keyboard sensor.
- **Collision detection**: `closestCenter` strategy.
- **DragOverlay**: a lightweight clone of the task row, rendered at the cursor during drag. The original row shows a placeholder (faded/border-dashed).

### 2.4 Same-day reordering logic

**`onDragEnd` handler**:
1. Determine the source task and its drop position.
2. Find the task above and below the drop position.
3. If both neighbours have the same `actionDate` as the dragged task → same-day reorder:
   - Compute new `position` as midpoint of neighbours' positions (fractional indexing).
   - If a neighbour has no `dayOrderPosition`, assign sequential positions to the whole day group first, then compute midpoint.
   - Call `updateDayOrder(taskId, actionDate, newPosition)`.
4. If dates differ → defer to Phase 3 (cross-date drag with popover).

### 2.5 Auto-scroll during drag

**`src/renderer/views/TasksView.tsx`**:
- Identify the scroll container (the parent element that scrolls the task list).
- During drag, if the cursor is within 60px of the top/bottom edge of the scroll container, scroll at a rate proportional to proximity (faster near the edge).
- @dnd-kit supports auto-scrolling via its `AutoScrollActivator` — configure it on the `DndContext`.

### 2.6 Drag overlay styling

- The dragged task row appears slightly elevated (`shadow-lg`), with a subtle scale (`scale-[1.02]`).
- The original position shows a dashed border placeholder with reduced opacity.
- Date-stripe backgrounds are maintained on the overlay for context.

### Files modified
- `package.json` (new dependency)
- `src/renderer/views/TasksView.tsx` (major changes)
- `src/renderer/components/DraggableTaskList.tsx` (new, optional — may stay in TasksView)

---

## Phase 3 — Cross-Date Dragging

_The full drag experience: dragging between date groups shows an adaptive popover for date selection._

### 3.1 Drop-zone detection

**`onDragOver` handler**:
- As the user drags over a position between two tasks, determine the `actionDate` of the task above and below.
- If the dates are different (cross-date boundary), activate the date popover.
- If the dates are the same, no popover (same-day reorder, handled in Phase 2).

### 3.2 Adaptive date popover

**`src/renderer/components/DragDatePopover.tsx`** (new):

**Small gap (0–7 days inclusive)**:
- Render a vertical list of individual dates between the upper and lower task dates.
- Each date is a clickable button showing the formatted date (e.g., "Mon 10 Mar", "Tue 11 Mar").
- Highlight today if in range.
- The currently hovered date gets a visual indicator.

**Large gap (>7 days)**:
- Render a compact calendar picker (reuse/extend the existing `CalendarGrid` from TaskCells.tsx).
- Constrain the selectable range to the dates between the upper and lower tasks.
- Month navigation within the allowed range.

**Same day**:
- No popover. Same-day reorder only.

**Positioning**:
- The popover anchors to the drop indicator line, offset to the right of the task list.
- Use Floating UI (already installed) for positioning and collision avoidance.

### 3.3 Drop completion

When the user selects a date from the popover (click or keyboard):
1. Update the task's `action_date` to the selected date via `PATCH /tasks/:id`.
2. Delete the old `day_order` entry (if any).
3. Compute the new `day_order` position based on drop position within the target date group.
4. Call `updateDayOrder(taskId, newDate, position)`.
5. Refresh the task list.

**If the user drops without selecting a date** (releases the drag without clicking the popover):
- Cancel the drag. No changes.

### 3.4 Due date warnings

When the user selects a date from the popover that is after the task's `dueDate`:
- The date button/cell in the popover shows a warning indicator (amber highlight, same as existing overdue styling).
- The drag is NOT blocked — the user can proceed.
- After the drop completes, the task row shows the standard overdue/past-due styling.

### 3.5 Keyboard support

- When dragging with keyboard (arrow keys via @dnd-kit's keyboard sensor):
  - Up/down moves between positions.
  - When crossing a date boundary, the popover appears.
  - Left/right or number keys select a date in the popover.
  - Enter confirms, Escape cancels.

### Files modified
- `src/renderer/components/DragDatePopover.tsx` (new)
- `src/renderer/views/TasksView.tsx` (drag handlers)
- `src/renderer/components/TaskCells.tsx` (may extend CalendarGrid for reuse)

---

## Phase 4 — Contextual Task Insertion

_Insert a new task between two existing tasks, inheriting context from the current view._

### 4.1 Insert-between trigger

**`src/renderer/views/TasksView.tsx`**:
- When hovering between two task rows, show a thin "insert" indicator line with a `+` button.
- Clicking the `+` button opens an inline creation row at that position (similar to the existing create row, but positioned between the two tasks).
- The indicator appears on hover with a slight delay (150ms) to avoid visual noise.

### 4.2 Context inheritance

When inserting between two tasks:
- **Project**: if the task list is filtered to a single project, inherit that project ID.
- **Action date**: determined by the same adaptive popover logic as cross-date dragging:
  - If both adjacent tasks share the same date → use that date (no popover).
  - If adjacent tasks have different dates → show the adaptive popover.
- **day_order position**: computed as midpoint of the two adjacent tasks' positions.

### 4.3 Inline creation row

The creation row is the same as the existing create row but:
- Pre-filled with the inherited project (if applicable).
- Pre-filled with the determined action date.
- Focus goes immediately to the topic input.
- On submit (Enter), create the task with the inherited fields and computed day_order.
- On cancel (Escape), remove the insertion row.

### Files modified
- `src/renderer/views/TasksView.tsx`

---

## Implementation Notes

### Fractional Indexing Strategy

Use REAL-valued positions with midpoint insertion:
- Initial positions: `1.0, 2.0, 3.0, ...`
- Insert between 1.0 and 2.0 → `1.5`
- Insert between 1.0 and 1.5 → `1.25`
- After ~50 insertions in the same gap, precision reaches ~1e-15 (IEEE 754 limit).
- **Rebalance trigger**: when a computed midpoint gap falls below `0.001`, rebalance the entire date group to integer positions. This is rare in practice.

### Performance

- No virtualization needed initially — task lists are typically <200 items.
- day_order lookups are indexed by `action_date`, queries are fast.
- Drag overlay uses a lightweight clone, not the full interactive row.
- Consider adding virtualization (e.g., @tanstack/react-virtual) if lists grow beyond 500 items.

### Migration & Rollout

- Phase 0 can deploy independently (it's a data integrity improvement).
- Phase 1 can deploy independently (backend-only, no UI change until Phase 2).
- Phases 2–3 should deploy together (drag without cross-date support would be confusing).
- Phase 4 is a standalone enhancement.

### Suggested deploy order
1. Phase 0 → deploy, verify no tasks lost
2. Phase 1 → deploy migration, verify sorting unchanged
3. Phases 2 + 3 → develop together, deploy as one release
4. Phase 4 → polish release
