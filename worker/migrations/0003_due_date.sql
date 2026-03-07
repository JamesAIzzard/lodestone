-- Due date — hard deadline by which a task must be completed.
-- Parallel to action_date (when to work on it next).

ALTER TABLE memories ADD COLUMN due_date TEXT;

CREATE INDEX IF NOT EXISTS idx_memories_due_date
  ON memories(due_date) WHERE due_date IS NOT NULL;
