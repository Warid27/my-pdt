CREATE TABLE IF NOT EXISTS init_sessions (
  chat_id TEXT PRIMARY KEY,
  step TEXT NOT NULL,
  confirm_code TEXT NOT NULL,
  reset_mode TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
