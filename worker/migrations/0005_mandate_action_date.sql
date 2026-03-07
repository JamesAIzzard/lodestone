-- Backfill: any memory with a status but no action_date gets today's date.
-- This enforces the invariant that all tasks (memories with status) have an action_date.
UPDATE memories
SET action_date = strftime('%Y-%m-%d', 'now'),
    updated_at  = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status IS NOT NULL
  AND action_date IS NULL
  AND deleted_at IS NULL;
