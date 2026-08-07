-- Add logs support + submission kind/fingerprint for dedupe
ALTER TABLE projects ADD COLUMN logs_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE submissions ADD COLUMN kind TEXT NOT NULL DEFAULT 'form';
ALTER TABLE submissions ADD COLUMN fingerprint TEXT;
ALTER TABLE submissions ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE submissions ADD COLUMN level TEXT;
