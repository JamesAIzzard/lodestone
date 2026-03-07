-- Archive projects — hide finished projects from day-to-day recall/agenda/GUI
-- without deleting them or unlinking their memories.

ALTER TABLE projects ADD COLUMN archived_at TEXT;
