-- Fuel provider integrations (Samsara, Motive, etc.)
CREATE TABLE IF NOT EXISTS fuel_integrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  label TEXT,
  encrypted_secrets TEXT NOT NULL,
  base_url TEXT,
  status TEXT DEFAULT 'pending',
  last_sync_at TEXT,
  last_error TEXT,
  sync_from_date TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- Provider asset mapping (maps provider vehicle IDs to internal fleet IDs)
CREATE TABLE IF NOT EXISTS fuel_provider_asset_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  integration_id INTEGER NOT NULL,
  provider_vehicle_id TEXT NOT NULL,
  provider_vehicle_name TEXT,
  provider_vin TEXT,
  internal_vehicle_id INTEGER,
  internal_driver_id INTEGER,
  mapped_by TEXT DEFAULT 'auto',
  mapped_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (integration_id) REFERENCES fuel_integrations(id) ON DELETE CASCADE,
  FOREIGN KEY (internal_vehicle_id) REFERENCES fleet_vehicles(id) ON DELETE SET NULL,
  UNIQUE(integration_id, provider_vehicle_id)
);

-- Daily fuel measurements (one row per company+truck+date)
CREATE TABLE IF NOT EXISTS fuel_measurements_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  integration_id INTEGER,
  vehicle_id INTEGER,
  driver_id INTEGER,
  date TEXT NOT NULL,
  miles REAL DEFAULT 0,
  gallons REAL DEFAULT 0,
  mpg REAL DEFAULT 0,
  idle_hours REAL DEFAULT 0,
  idle_gallons REAL DEFAULT 0,
  odometer_start REAL,
  odometer_end REAL,
  provider TEXT,
  provider_vehicle_id TEXT,
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (vehicle_id) REFERENCES fleet_vehicles(id) ON DELETE SET NULL,
  UNIQUE(company_id, vehicle_id, date, provider)
)
