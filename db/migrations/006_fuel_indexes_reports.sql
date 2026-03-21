-- Performance indexes for fuel tables
CREATE INDEX IF NOT EXISTS idx_fmd_company_date ON fuel_measurements_daily(company_id, date);
CREATE INDEX IF NOT EXISTS idx_fmd_vehicle_date ON fuel_measurements_daily(company_id, vehicle_id, date);
CREATE INDEX IF NOT EXISTS idx_fmd_driver_date ON fuel_measurements_daily(company_id, driver_id, date);
CREATE INDEX IF NOT EXISTS idx_fmd_provider ON fuel_measurements_daily(company_id, provider, date);
CREATE INDEX IF NOT EXISTS idx_fpl_period ON fuel_payout_ledgers(period_id, company_id);
CREATE INDEX IF NOT EXISTS idx_fpl_driver ON fuel_payout_ledgers(driver_id, company_id);
CREATE INDEX IF NOT EXISTS idx_fbs_group ON fuel_baseline_snapshots(company_id, group_id, is_current);
CREATE INDEX IF NOT EXISTS idx_ftp_group ON fuel_target_policies(company_id, group_id, is_active);
CREATE INDEX IF NOT EXISTS idx_fto_driver ON fuel_target_overrides(company_id, driver_id, is_active);
CREATE INDEX IF NOT EXISTS idx_fi_company ON fuel_integrations(company_id, is_active);
CREATE INDEX IF NOT EXISTS idx_fpam_intg ON fuel_provider_asset_map(integration_id, provider_vehicle_id);

-- Ceiling switch tracking
CREATE TABLE IF NOT EXISTS fuel_ceiling_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  group_id INTEGER,
  consecutive_periods INTEGER,
  avg_mpg_delta REAL,
  old_billing_mode TEXT,
  new_billing_mode TEXT,
  triggered_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
)
