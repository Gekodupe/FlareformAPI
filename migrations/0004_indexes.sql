-- Indexes for log kind + fingerprint dedupe (safe on fresh and existing DBs)
CREATE INDEX IF NOT EXISTS idx_submissions_kind ON submissions(project_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_fingerprint ON submissions(project_id, fingerprint);
