-- Manual within-day ordering for drag-to-reorder.
-- Sparse table: rows only exist when a user explicitly drags a task.
-- Tasks without an entry fall back to priority-based ordering.
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
