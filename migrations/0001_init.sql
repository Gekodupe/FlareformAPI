-- Flareform D1 schema (Phase 1)

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  name TEXT NOT NULL,
  allowed_origins TEXT NOT NULL DEFAULT '',
  turnstile_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_email);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  spam_score REAL NOT NULL DEFAULT 0,
  is_spam INTEGER NOT NULL DEFAULT 0,
  read_at TEXT,
  ip_hash TEXT,
  origin TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_submissions_project ON submissions(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_spam ON submissions(project_id, is_spam);
