CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  debit_account TEXT NOT NULL,
  credit_account TEXT NOT NULL,
  amount INTEGER NOT NULL,
  description TEXT,
  category TEXT,
  person TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(debit_account) REFERENCES accounts(name),
  FOREIGN KEY(credit_account) REFERENCES accounts(name)
);

CREATE TABLE IF NOT EXISTS debt_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person TEXT NOT NULL,
  amount INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  direction TEXT NOT NULL,
  is_paid INTEGER DEFAULT 0,
  note TEXT,
  reminded_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_accounts_name ON accounts (name);
CREATE INDEX IF NOT EXISTS idx_ledger_created_at ON ledger (created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_debit_account ON ledger (debit_account);
CREATE INDEX IF NOT EXISTS idx_ledger_credit_account ON ledger (credit_account);
CREATE INDEX IF NOT EXISTS idx_ledger_person ON ledger (person);
CREATE INDEX IF NOT EXISTS idx_debt_reminders_due ON debt_reminders (due_date, is_paid);
CREATE INDEX IF NOT EXISTS idx_debt_reminders_person ON debt_reminders (person);
