-- Expense Cost Centers (departments / cost centers)
CREATE TABLE IF NOT EXISTS expense_cost_centers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  manager_id INTEGER,
  is_active INTEGER DEFAULT 1,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (manager_id) REFERENCES company_users(id) ON DELETE SET NULL,
  UNIQUE(company_id, code)
);

-- Expense Categories (hierarchical)
CREATE TABLE IF NOT EXISTS expense_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  parent_id INTEGER,
  icon TEXT,
  is_active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES expense_categories(id) ON DELETE SET NULL,
  UNIQUE(company_id, name)
);

-- Expense Vendors
CREATE TABLE IF NOT EXISTS expense_vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  contact TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  tax_id TEXT,
  notes TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  UNIQUE(company_id, name)
);

-- Expense Transactions (core ledger)
CREATE TABLE IF NOT EXISTS expense_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  description TEXT,
  vendor_id INTEGER,
  vendor_name TEXT,
  category_id INTEGER,
  category_name TEXT,
  cost_center_id INTEGER,
  cost_center_code TEXT,
  project_id INTEGER,
  project_name TEXT,
  reference TEXT,
  invoice_number TEXT,
  source TEXT DEFAULT 'manual',
  import_batch_id INTEGER,
  dedupe_hash TEXT,
  status TEXT DEFAULT 'pending',
  approved_by TEXT,
  approved_at TEXT,
  notes TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (vendor_id) REFERENCES expense_vendors(id) ON DELETE SET NULL,
  FOREIGN KEY (category_id) REFERENCES expense_categories(id) ON DELETE SET NULL,
  FOREIGN KEY (cost_center_id) REFERENCES expense_cost_centers(id) ON DELETE SET NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY (import_batch_id) REFERENCES expense_import_batches(id) ON DELETE SET NULL
);

-- Import Batches
CREATE TABLE IF NOT EXISTS expense_import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  filename TEXT,
  source TEXT DEFAULT 'csv',
  status TEXT DEFAULT 'pending',
  total_rows INTEGER DEFAULT 0,
  imported_rows INTEGER DEFAULT 0,
  skipped_rows INTEGER DEFAULT 0,
  error_rows INTEGER DEFAULT 0,
  total_amount REAL DEFAULT 0,
  errors TEXT,
  uploaded_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_exp_tx_company ON expense_transactions(company_id, date);
CREATE INDEX IF NOT EXISTS idx_exp_tx_category ON expense_transactions(company_id, category_id);
CREATE INDEX IF NOT EXISTS idx_exp_tx_cost_center ON expense_transactions(company_id, cost_center_id);
CREATE INDEX IF NOT EXISTS idx_exp_tx_project ON expense_transactions(company_id, project_id);
CREATE INDEX IF NOT EXISTS idx_exp_tx_vendor ON expense_transactions(company_id, vendor_id);
CREATE INDEX IF NOT EXISTS idx_exp_tx_status ON expense_transactions(company_id, status);
CREATE INDEX IF NOT EXISTS idx_exp_tx_dedupe ON expense_transactions(company_id, dedupe_hash);
CREATE INDEX IF NOT EXISTS idx_exp_tx_batch ON expense_transactions(import_batch_id);
CREATE INDEX IF NOT EXISTS idx_exp_cc_company ON expense_cost_centers(company_id, is_active);
CREATE INDEX IF NOT EXISTS idx_exp_cat_company ON expense_categories(company_id, is_active);
CREATE INDEX IF NOT EXISTS idx_exp_vendor_company ON expense_vendors(company_id, is_active)
