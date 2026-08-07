-- Add notification columns for existing D1 databases
ALTER TABLE projects ADD COLUMN notify_email TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN notify_enabled INTEGER NOT NULL DEFAULT 1;
