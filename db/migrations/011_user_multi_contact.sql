-- Multiple emails per user
CREATE TABLE IF NOT EXISTS user_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  type TEXT DEFAULT 'work',
  is_primary INTEGER DEFAULT 0,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES company_users(id) ON DELETE CASCADE
);

-- Multiple phones per user (with extensions)
CREATE TABLE IF NOT EXISTS user_phones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  phone TEXT NOT NULL,
  ext TEXT,
  type TEXT DEFAULT 'work',
  is_primary INTEGER DEFAULT 0,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES company_users(id) ON DELETE CASCADE
);

-- Divisions (company-scoped organizational units)
CREATE TABLE IF NOT EXISTS divisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  code TEXT,
  parent_id INTEGER,
  head_id INTEGER,
  is_active INTEGER DEFAULT 1,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES divisions(id) ON DELETE SET NULL,
  FOREIGN KEY (head_id) REFERENCES company_users(id) ON DELETE SET NULL,
  UNIQUE(company_id, name)
);

-- User-to-division assignments (many-to-many)
CREATE TABLE IF NOT EXISTS user_division_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  division_id INTEGER NOT NULL,
  role_in_division TEXT,
  is_primary INTEGER DEFAULT 0,
  assigned_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES company_users(id) ON DELETE CASCADE,
  FOREIGN KEY (division_id) REFERENCES divisions(id) ON DELETE CASCADE,
  UNIQUE(user_id, division_id)
);

CREATE INDEX IF NOT EXISTS idx_user_emails_user ON user_emails(user_id);
CREATE INDEX IF NOT EXISTS idx_user_phones_user ON user_phones(user_id);
CREATE INDEX IF NOT EXISTS idx_divisions_company ON divisions(company_id, is_active);
CREATE INDEX IF NOT EXISTS idx_user_div_assign_user ON user_division_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_user_div_assign_div ON user_division_assignments(division_id)
