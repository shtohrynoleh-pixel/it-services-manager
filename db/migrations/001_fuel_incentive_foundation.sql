-- Fuel incentive config per company
CREATE TABLE IF NOT EXISTS fuel_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL UNIQUE,
  enabled INTEGER DEFAULT 0,
  billing_mode TEXT DEFAULT 'per-truck',
  split_driver_pct REAL DEFAULT 50,
  split_company_pct REAL DEFAULT 50,
  baseline_window_days INTEGER DEFAULT 90,
  baseline_mpg REAL DEFAULT 0,
  fuel_price_source TEXT DEFAULT 'manual',
  fuel_price_manual REAL DEFAULT 0,
  min_miles_qualify INTEGER DEFAULT 500,
  ceiling_bonus_per_gallon REAL DEFAULT 0.50,
  floor_penalty_per_gallon REAL DEFAULT 0,
  pay_frequency TEXT DEFAULT 'monthly',
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- Fuel audit log (tracks every calculation, change, and payout)
CREATE TABLE IF NOT EXISTS fuel_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  driver_id INTEGER,
  vehicle_id INTEGER,
  action TEXT NOT NULL,
  period_start TEXT,
  period_end TEXT,
  baseline_mpg REAL,
  actual_mpg REAL,
  gallons_saved REAL,
  fuel_price REAL,
  gross_savings REAL,
  driver_share REAL,
  company_share REAL,
  miles INTEGER,
  gallons REAL,
  details TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (driver_id) REFERENCES company_users(id) ON DELETE SET NULL,
  FOREIGN KEY (vehicle_id) REFERENCES fleet_vehicles(id) ON DELETE SET NULL
);

-- Fuel equipment groups (group trucks by class for fair comparison)
CREATE TABLE IF NOT EXISTS fuel_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  baseline_mpg REAL DEFAULT 0,
  vehicle_ids TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- Fuel driver baselines (per-driver MPG targets)
CREATE TABLE IF NOT EXISTS fuel_driver_baselines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  driver_id INTEGER NOT NULL,
  group_id INTEGER,
  baseline_mpg REAL DEFAULT 0,
  effective_date TEXT,
  notes TEXT,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (driver_id) REFERENCES company_users(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES fuel_groups(id) ON DELETE SET NULL
)
