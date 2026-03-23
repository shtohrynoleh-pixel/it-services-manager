-- Expense audit log (tracks every CRUD action on expense entities)
CREATE TABLE IF NOT EXISTS expense_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  field_changes TEXT,
  performed_by TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_exp_audit_company ON expense_audit_log(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_exp_audit_entity ON expense_audit_log(entity_type, entity_id);

-- Add updated_at to cost centers if missing
-- (categories and vendors already have created_at; add updated_at for edit tracking)
