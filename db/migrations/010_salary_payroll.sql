-- Salary profiles: one per employee defining their recurring pay
CREATE TABLE IF NOT EXISTS salary_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  employee_name TEXT NOT NULL,
  cost_center_id INTEGER,
  project_id INTEGER,
  pay_frequency TEXT NOT NULL DEFAULT 'monthly',
  amount REAL NOT NULL DEFAULT 0,
  effective_from TEXT,
  effective_to TEXT,
  is_active INTEGER DEFAULT 1,
  notes TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id) REFERENCES company_users(id) ON DELETE CASCADE,
  FOREIGN KEY (cost_center_id) REFERENCES expense_cost_centers(id) ON DELETE SET NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
  UNIQUE(company_id, employee_id)
);

-- Salary runs: a pay period batch that generates transactions
CREATE TABLE IF NOT EXISTS salary_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  pay_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  total_amount REAL DEFAULT 0,
  line_count INTEGER DEFAULT 0,
  approved_by TEXT,
  approved_at TEXT,
  posted_by TEXT,
  posted_at TEXT,
  notes TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- Salary run lines: one per employee per run
CREATE TABLE IF NOT EXISTS salary_run_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  profile_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  employee_name TEXT NOT NULL,
  amount REAL NOT NULL,
  cost_center_id INTEGER,
  cost_center_code TEXT,
  project_id INTEGER,
  project_name TEXT,
  description TEXT,
  transaction_id INTEGER,
  FOREIGN KEY (run_id) REFERENCES salary_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id) REFERENCES salary_profiles(id) ON DELETE CASCADE,
  FOREIGN KEY (transaction_id) REFERENCES expense_transactions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_salary_profiles_company ON salary_profiles(company_id, is_active);
CREATE INDEX IF NOT EXISTS idx_salary_runs_company ON salary_runs(company_id, status);
CREATE INDEX IF NOT EXISTS idx_salary_run_lines_run ON salary_run_lines(run_id);
CREATE INDEX IF NOT EXISTS idx_exp_tx_source ON expense_transactions(company_id, source)
