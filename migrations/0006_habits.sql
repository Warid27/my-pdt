CREATE TABLE IF NOT EXISTS habits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  frequency TEXT NOT NULL DEFAULT 'daily',
  target_days TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS habit_checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  habit_id INTEGER NOT NULL REFERENCES habits(id),
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  date TEXT NOT NULL,
  note TEXT,
  UNIQUE(habit_id, date)
);

CREATE INDEX IF NOT EXISTS idx_habits_name ON habits (name);
CREATE INDEX IF NOT EXISTS idx_habit_checkins_date ON habit_checkins (date);
CREATE INDEX IF NOT EXISTS idx_habit_checkins_habit_date ON habit_checkins (habit_id, date);
