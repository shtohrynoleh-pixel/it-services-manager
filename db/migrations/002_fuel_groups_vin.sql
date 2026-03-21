-- Truck-to-group mapping
CREATE TABLE IF NOT EXISTS fuel_truck_group_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  vehicle_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL,
  assigned_at TEXT DEFAULT (datetime('now')),
  assigned_by TEXT,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (vehicle_id) REFERENCES fleet_vehicles(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES fuel_groups(id) ON DELETE CASCADE,
  UNIQUE(company_id, vehicle_id)
);

-- Driver-to-group mapping
CREATE TABLE IF NOT EXISTS fuel_driver_group_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  driver_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL,
  assigned_at TEXT DEFAULT (datetime('now')),
  assigned_by TEXT,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (driver_id) REFERENCES company_users(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES fuel_groups(id) ON DELETE CASCADE,
  UNIQUE(company_id, driver_id)
);

-- VIN decode cache
CREATE TABLE IF NOT EXISTS fuel_vin_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vin TEXT NOT NULL UNIQUE,
  make TEXT,
  model TEXT,
  year INTEGER,
  body_class TEXT,
  fuel_type TEXT,
  engine TEXT,
  gvwr TEXT,
  drive_type TEXT,
  raw_json TEXT,
  decoded_at TEXT DEFAULT (datetime('now'))
)
