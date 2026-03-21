-- Baseline snapshots (computed historical MPG per group)
CREATE TABLE IF NOT EXISTS fuel_baseline_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  group_id INTEGER,
  driver_id INTEGER,
  scope TEXT DEFAULT 'group',
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  window_days INTEGER,
  total_miles REAL DEFAULT 0,
  total_gallons REAL DEFAULT 0,
  baseline_mpg REAL DEFAULT 0,
  method TEXT DEFAULT 'miles_over_gallons',
  vehicle_count INTEGER DEFAULT 0,
  measurement_count INTEGER DEFAULT 0,
  is_current INTEGER DEFAULT 1,
  computed_by TEXT,
  computed_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES fuel_groups(id) ON DELETE SET NULL,
  FOREIGN KEY (driver_id) REFERENCES company_users(id) ON DELETE SET NULL
);

-- Group target policies (target MPG + bonus per group)
CREATE TABLE IF NOT EXISTS fuel_target_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL,
  target_mpg REAL NOT NULL,
  kpi_bonus_usd REAL DEFAULT 0,
  penalty_usd REAL DEFAULT 0,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  is_active INTEGER DEFAULT 1,
  notes TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES fuel_groups(id) ON DELETE CASCADE
);

-- Driver target overrides (override group target for specific drivers)
CREATE TABLE IF NOT EXISTS fuel_target_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  driver_id INTEGER NOT NULL,
  target_mpg REAL NOT NULL,
  kpi_bonus_usd REAL DEFAULT 0,
  penalty_usd REAL DEFAULT 0,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  reason TEXT,
  is_active INTEGER DEFAULT 1,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (driver_id) REFERENCES company_users(id) ON DELETE CASCADE
)
