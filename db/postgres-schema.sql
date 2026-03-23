-- IT Forge — PostgreSQL Schema
-- Run: psql -d itforge -f db/postgres-schema.sql

-- Settings
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Users (admin + client login accounts)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'client',
  company_id INTEGER,
  full_name TEXT,
  email TEXT,
  phone TEXT,
  is_active INTEGER DEFAULT 1,
  is_super INTEGER DEFAULT 0,
  totp_secret TEXT,
  totp_enabled INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Companies
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  logo TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  storage_quota INTEGER DEFAULT 500,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Admin-company assignments
CREATE TABLE IF NOT EXISTS admin_companies (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  UNIQUE(user_id, company_id)
);

-- Company modules
CREATE TABLE IF NOT EXISTS company_modules (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  tms INTEGER DEFAULT 0,
  fleet INTEGER DEFAULT 0,
  monitoring INTEGER DEFAULT 0,
  files INTEGER DEFAULT 1,
  chat INTEGER DEFAULT 1,
  sops INTEGER DEFAULT 1,
  policies INTEGER DEFAULT 1,
  passwords INTEGER DEFAULT 1,
  eld INTEGER DEFAULT 0,
  domains INTEGER DEFAULT 1,
  rdp INTEGER DEFAULT 1
);

-- Company contacts
CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT,
  email TEXT,
  phone TEXT,
  is_primary INTEGER DEFAULT 0
);

-- Company users/employees
CREATE TABLE IF NOT EXISTS company_users (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  title TEXT,
  email TEXT,
  phone TEXT,
  department TEXT,
  role TEXT,
  manager_id INTEGER REFERENCES company_users(id) ON DELETE SET NULL,
  access_level TEXT DEFAULT 'limited',
  email_account TEXT,
  hire_date TEXT,
  photo_url TEXT,
  is_active INTEGER DEFAULT 1,
  is_driver INTEGER DEFAULT 0,
  pay_type TEXT DEFAULT 'per-mile',
  pay_rate REAL DEFAULT 0,
  notes TEXT
);

-- Roles & Departments
CREATE TABLE IF NOT EXISTS roles (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, sort_order INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS departments (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, sort_order INTEGER DEFAULT 0);

-- Servers, Subscriptions, Assets, Inventory
CREATE TABLE IF NOT EXISTS servers (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, name TEXT NOT NULL, type TEXT, os TEXT, ip TEXT, purpose TEXT, location TEXT, is_active INTEGER DEFAULT 1, notes TEXT);
CREATE TABLE IF NOT EXISTS subscriptions (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, name TEXT NOT NULL, vendor TEXT, type TEXT, seats INTEGER DEFAULT 1, cost_per_unit REAL DEFAULT 0, billing_cycle TEXT DEFAULT 'monthly', renewal_date TEXT, auto_renew INTEGER DEFAULT 1, login_url TEXT, notes TEXT);
CREATE TABLE IF NOT EXISTS assets (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, name TEXT NOT NULL, type TEXT, provider TEXT, expires_at TEXT, login_url TEXT, notes TEXT);
CREATE TABLE IF NOT EXISTS inventory_locations (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, name TEXT NOT NULL, type TEXT DEFAULT 'office', address TEXT, parent_id INTEGER REFERENCES inventory_locations(id) ON DELETE SET NULL, is_active INTEGER DEFAULT 1, notes TEXT);
CREATE TABLE IF NOT EXISTS inventory (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, name TEXT NOT NULL, type TEXT, manufacturer TEXT, model TEXT, serial_number TEXT, quantity INTEGER DEFAULT 1, cost REAL DEFAULT 0, location_id INTEGER REFERENCES inventory_locations(id) ON DELETE SET NULL, assigned_to TEXT, purchase_date TEXT, warranty_expires TEXT, condition TEXT DEFAULT 'good', notes TEXT);

-- Services, Agreements, Invoices
CREATE TABLE IF NOT EXISTS services (id SERIAL PRIMARY KEY, name TEXT NOT NULL, category TEXT, description TEXT, price_type TEXT DEFAULT 'monthly', base_price REAL DEFAULT 0, is_public INTEGER DEFAULT 1, is_active INTEGER DEFAULT 1, show_on_landing INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS agreements (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, service_id INTEGER REFERENCES services(id) ON DELETE CASCADE, title TEXT, custom_price REAL, billing_cycle TEXT DEFAULT 'monthly', start_date TEXT, end_date TEXT, auto_renew INTEGER DEFAULT 1, sla_response TEXT, sla_resolution TEXT, scope TEXT, exclusions TEXT, terms TEXT, signed_by TEXT, signed_date TEXT, attachment TEXT, attachment_name TEXT, is_active INTEGER DEFAULT 1, notes TEXT, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS invoices (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, invoice_number TEXT, date TEXT, due_date TEXT, subtotal REAL DEFAULT 0, tax REAL DEFAULT 0, total REAL DEFAULT 0, status TEXT DEFAULT 'draft', paid_date TEXT, notes TEXT, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS invoice_items (id SERIAL PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, description TEXT, quantity REAL DEFAULT 1, unit_price REAL DEFAULT 0, total REAL DEFAULT 0);

-- Tasks, Projects
CREATE TABLE IF NOT EXISTS projects (id SERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT, company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL, status TEXT DEFAULT 'planning', start_date TEXT, due_date TEXT, budget REAL DEFAULT 0, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS project_statuses (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT DEFAULT '#64748b', sort_order INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS tasks (id SERIAL PRIMARY KEY, title TEXT NOT NULL, description TEXT, company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE, project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, related_table TEXT, related_id INTEGER, priority TEXT DEFAULT 'medium', status TEXT DEFAULT 'todo', due_date TEXT, assigned_to TEXT, created_by TEXT DEFAULT 'admin', created_at TIMESTAMP DEFAULT NOW(), started_at TIMESTAMP, completed_at TIMESTAMP, first_response_at TIMESTAMP, sla_response_min INTEGER, sla_resolve_min INTEGER);

-- Monitoring
CREATE TABLE IF NOT EXISTS equipment_monitors (id SERIAL PRIMARY KEY, company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE, name TEXT NOT NULL, type TEXT DEFAULT 'server', target TEXT, check_type TEXT DEFAULT 'ping', interval_min INTEGER DEFAULT 5, last_check TIMESTAMP, last_status TEXT DEFAULT 'unknown', last_response_ms INTEGER, uptime_pct REAL DEFAULT 0, alert_email TEXT, is_active INTEGER DEFAULT 1, notes TEXT, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS monitor_logs (id SERIAL PRIMARY KEY, monitor_id INTEGER NOT NULL REFERENCES equipment_monitors(id) ON DELETE CASCADE, checked_at TIMESTAMP DEFAULT NOW(), status TEXT, response_ms INTEGER, error TEXT);
CREATE TABLE IF NOT EXISTS alerts (id SERIAL PRIMARY KEY, monitor_id INTEGER REFERENCES equipment_monitors(id) ON DELETE SET NULL, source TEXT DEFAULT 'monitor', severity TEXT DEFAULT 'critical', title TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'open', resolved_at TIMESTAMP, resolved_by TEXT, resolution TEXT, created_at TIMESTAMP DEFAULT NOW());

-- Chat
CREATE TABLE IF NOT EXISTS chat_channels (id SERIAL PRIMARY KEY, name TEXT NOT NULL, type TEXT DEFAULT 'group', company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE, created_by TEXT, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS chat_members (id SERIAL PRIMARY KEY, channel_id INTEGER NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE, user_type TEXT DEFAULT 'company_user', user_id INTEGER, user_name TEXT NOT NULL, last_read_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS chat_messages (id SERIAL PRIMARY KEY, channel_id INTEGER NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE, sender_type TEXT DEFAULT 'company_user', sender_id INTEGER, sender_name TEXT NOT NULL, message TEXT NOT NULL, attachment TEXT, attachment_name TEXT, attachment_type TEXT, created_at TIMESTAMP DEFAULT NOW());

-- SOPs, Policies, Password Vault
CREATE TABLE IF NOT EXISTS sops (id SERIAL PRIMARY KEY, company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE, title TEXT NOT NULL, sop_number TEXT, category TEXT, department TEXT, target_role TEXT, purpose TEXT, scope_applies TEXT, scope_excludes TEXT, materials TEXT, equipment TEXT, definitions TEXT, safety_warnings TEXT, compliance_reqs TEXT, exceptions TEXT, description TEXT, version TEXT DEFAULT '1.0', status TEXT DEFAULT 'draft', owner TEXT, prepared_by TEXT, prepared_date TEXT, reviewed_by TEXT, reviewed_date TEXT, approved_by TEXT, approved_date TEXT, review_date TEXT, is_template INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS sop_sections (id SERIAL PRIMARY KEY, sop_id INTEGER NOT NULL REFERENCES sops(id) ON DELETE CASCADE, section_number INTEGER DEFAULT 1, title TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sop_steps (id SERIAL PRIMARY KEY, sop_id INTEGER NOT NULL REFERENCES sops(id) ON DELETE CASCADE, section_id INTEGER REFERENCES sop_sections(id) ON DELETE CASCADE, step_number INTEGER DEFAULT 1, title TEXT NOT NULL, description TEXT, responsible TEXT, warning TEXT, notes TEXT);
CREATE TABLE IF NOT EXISTS sop_acknowledgments (id SERIAL PRIMARY KEY, sop_id INTEGER NOT NULL REFERENCES sops(id) ON DELETE CASCADE, user_name TEXT NOT NULL, company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE, acknowledged_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS sop_references (id SERIAL PRIMARY KEY, sop_id INTEGER NOT NULL REFERENCES sops(id) ON DELETE CASCADE, title TEXT NOT NULL, link TEXT, related_sop_id INTEGER);
CREATE TABLE IF NOT EXISTS sop_revisions (id SERIAL PRIMARY KEY, sop_id INTEGER NOT NULL REFERENCES sops(id) ON DELETE CASCADE, version TEXT, date TEXT, changed_by TEXT, description TEXT);
CREATE TABLE IF NOT EXISTS security_policies (id SERIAL PRIMARY KEY, company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE, title TEXT NOT NULL, category TEXT DEFAULT 'general', description TEXT, content TEXT, version TEXT DEFAULT '1.0', status TEXT DEFAULT 'draft', requires_ack INTEGER DEFAULT 1, review_date TEXT, created_by TEXT, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS policy_acknowledgments (id SERIAL PRIMARY KEY, policy_id INTEGER NOT NULL REFERENCES security_policies(id) ON DELETE CASCADE, user_name TEXT NOT NULL, company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE, acknowledged_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS password_vault (id SERIAL PRIMARY KEY, company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE, title TEXT NOT NULL, username TEXT, password_enc TEXT, url TEXT, category TEXT DEFAULT 'general', notes TEXT, share_type TEXT DEFAULT 'private', share_dept TEXT, shared_with TEXT, created_by TEXT, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS password_reset_tokens (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE, expires_at TIMESTAMP NOT NULL, used INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW());

-- Process Flows
CREATE TABLE IF NOT EXISTS process_flows (id SERIAL PRIMARY KEY, company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE, title TEXT NOT NULL, category TEXT, description TEXT, trigger_event TEXT, owner TEXT, status TEXT DEFAULT 'draft', is_template INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS flow_nodes (id SERIAL PRIMARY KEY, flow_id INTEGER NOT NULL REFERENCES process_flows(id) ON DELETE CASCADE, node_order INTEGER DEFAULT 0, type TEXT DEFAULT 'process', label TEXT NOT NULL, description TEXT, responsible TEXT, yes_label TEXT, no_label TEXT, color TEXT, swimlane TEXT, duration TEXT, notes TEXT, connect_to INTEGER, yes_connect INTEGER, no_connect INTEGER);

-- Files
CREATE TABLE IF NOT EXISTS file_folders (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, parent_id INTEGER REFERENCES file_folders(id) ON DELETE CASCADE, name TEXT NOT NULL, created_by TEXT, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS folder_access (id SERIAL PRIMARY KEY, folder_id INTEGER NOT NULL REFERENCES file_folders(id) ON DELETE CASCADE, user_name TEXT NOT NULL, permission TEXT DEFAULT 'view');
CREATE TABLE IF NOT EXISTS company_files (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, folder_id INTEGER REFERENCES file_folders(id) ON DELETE SET NULL, filename TEXT NOT NULL, original_name TEXT NOT NULL, size INTEGER DEFAULT 0, mime_type TEXT, uploaded_by TEXT, notes TEXT, created_at TIMESTAMP DEFAULT NOW());

-- Email Security, Domains, RDP
CREATE TABLE IF NOT EXISTS email_providers (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, provider TEXT NOT NULL, domain TEXT, admin_url TEXT, mfa_enabled INTEGER DEFAULT 0, spf_configured INTEGER DEFAULT 0, dkim_configured INTEGER DEFAULT 0, dmarc_configured INTEGER DEFAULT 0, backup_codes_stored INTEGER DEFAULT 0, password_policy TEXT, retention_days INTEGER DEFAULT 0, notes TEXT, last_audit_date TEXT, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS domains (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, domain TEXT NOT NULL, registrar TEXT, dns_provider TEXT, hosting_provider TEXT, ssl_provider TEXT, ssl_expires TEXT, domain_expires TEXT, nameservers TEXT, a_records TEXT, mx_records TEXT, auto_renew INTEGER DEFAULT 1, admin_url TEXT, login_email TEXT, notes TEXT, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS rdp_connections (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, name TEXT NOT NULL, type TEXT DEFAULT 'rdp', hostname TEXT, port INTEGER DEFAULT 3389, username TEXT, password_enc TEXT, domain TEXT, gateway TEXT, os TEXT, purpose TEXT, assigned_to TEXT, last_connected TIMESTAMP, is_active INTEGER DEFAULT 1, notes TEXT, created_at TIMESTAMP DEFAULT NOW());

-- ELD Integrations
CREATE TABLE IF NOT EXISTS eld_integrations (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, provider TEXT NOT NULL, label TEXT, api_key TEXT NOT NULL, base_url TEXT, is_active INTEGER DEFAULT 1, last_sync TIMESTAMP, last_error TEXT, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS eld_vehicles (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, integration_id INTEGER NOT NULL REFERENCES eld_integrations(id) ON DELETE CASCADE, external_id TEXT, name TEXT, make TEXT, model TEXT, year INTEGER, vin TEXT, license_plate TEXT, status TEXT, asset_type TEXT DEFAULT 'vehicle', odometer REAL, fuel_pct REAL, last_location TEXT, last_lat REAL, last_lng REAL, last_speed REAL, driver_name TEXT, raw_data TEXT, last_updated TIMESTAMP DEFAULT NOW());

-- Fleet
CREATE TABLE IF NOT EXISTS fleet_vehicles (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, unit_number TEXT, type TEXT DEFAULT 'truck', make TEXT, model TEXT, year INTEGER, vin TEXT, license_plate TEXT, state TEXT, color TEXT, status TEXT DEFAULT 'active', driver_id INTEGER REFERENCES company_users(id) ON DELETE SET NULL, fuel_type TEXT DEFAULT 'diesel', odometer INTEGER DEFAULT 0, purchase_date TEXT, purchase_price REAL DEFAULT 0, insurance_policy TEXT, insurance_expires TEXT, registration_expires TEXT, inspection_expires TEXT, gps_unit TEXT, eld_provider TEXT, eld_vehicle_id INTEGER, notes TEXT, photo_url TEXT, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS fleet_trailers (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, unit_number TEXT, type TEXT DEFAULT 'dry-van', make TEXT, model TEXT, year INTEGER, vin TEXT, license_plate TEXT, state TEXT, length_ft INTEGER, status TEXT DEFAULT 'active', assigned_vehicle_id INTEGER REFERENCES fleet_vehicles(id) ON DELETE SET NULL, eld_vehicle_id INTEGER, purchase_date TEXT, purchase_price REAL DEFAULT 0, registration_expires TEXT, inspection_expires TEXT, notes TEXT, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS fleet_maintenance (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, vehicle_id INTEGER REFERENCES fleet_vehicles(id) ON DELETE SET NULL, trailer_id INTEGER REFERENCES fleet_trailers(id) ON DELETE SET NULL, type TEXT DEFAULT 'repair', description TEXT NOT NULL, vendor TEXT, cost REAL DEFAULT 0, odometer INTEGER, date TEXT, next_due_date TEXT, next_due_miles INTEGER, status TEXT DEFAULT 'completed', notes TEXT, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS fleet_fuel (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, vehicle_id INTEGER REFERENCES fleet_vehicles(id) ON DELETE SET NULL, date TEXT, gallons REAL DEFAULT 0, cost_per_gallon REAL DEFAULT 0, total_cost REAL DEFAULT 0, odometer INTEGER, station TEXT, city TEXT, state TEXT, fuel_card TEXT, notes TEXT, created_at TIMESTAMP DEFAULT NOW());

-- TMS
CREATE TABLE IF NOT EXISTS tms_loads (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, load_number TEXT, status TEXT DEFAULT 'available', broker TEXT, broker_mc TEXT, broker_contact TEXT, broker_phone TEXT, broker_email TEXT, customer TEXT, reference_number TEXT, commodity TEXT, weight INTEGER, pieces INTEGER, temperature TEXT, equipment_type TEXT DEFAULT 'dry-van', rate REAL DEFAULT 0, rate_type TEXT DEFAULT 'flat', fuel_surcharge REAL DEFAULT 0, detention_pay REAL DEFAULT 0, accessorial REAL DEFAULT 0, total_pay REAL DEFAULT 0, total_miles INTEGER DEFAULT 0, rate_per_mile REAL DEFAULT 0, pickup_city TEXT, pickup_state TEXT, pickup_address TEXT, pickup_date TEXT, pickup_time TEXT, pickup_notes TEXT, delivery_city TEXT, delivery_state TEXT, delivery_address TEXT, delivery_date TEXT, delivery_time TEXT, delivery_notes TEXT, driver_id INTEGER REFERENCES company_users(id) ON DELETE SET NULL, vehicle_id INTEGER REFERENCES fleet_vehicles(id) ON DELETE SET NULL, trailer_id INTEGER REFERENCES fleet_trailers(id) ON DELETE SET NULL, dispatcher_id INTEGER REFERENCES company_users(id) ON DELETE SET NULL, trip_id INTEGER, dispatched_at TIMESTAMP, picked_up_at TIMESTAMP, delivered_at TIMESTAMP, invoice_status TEXT DEFAULT 'not-invoiced', pod_received INTEGER DEFAULT 0, notes TEXT, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS tms_stops (id SERIAL PRIMARY KEY, load_id INTEGER NOT NULL REFERENCES tms_loads(id) ON DELETE CASCADE, stop_order INTEGER DEFAULT 1, type TEXT DEFAULT 'pickup', city TEXT, state TEXT, address TEXT, date TEXT, time TEXT, contact TEXT, phone TEXT, notes TEXT, arrived_at TIMESTAMP, departed_at TIMESTAMP);
CREATE TABLE IF NOT EXISTS tms_trips (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, trip_number TEXT, driver_id INTEGER REFERENCES company_users(id) ON DELETE SET NULL, vehicle_id INTEGER REFERENCES fleet_vehicles(id) ON DELETE SET NULL, trailer_id INTEGER REFERENCES fleet_trailers(id) ON DELETE SET NULL, status TEXT DEFAULT 'planned', start_date TEXT, end_date TEXT, start_odometer INTEGER, end_odometer INTEGER, total_miles INTEGER DEFAULT 0, fuel_cost REAL DEFAULT 0, toll_cost REAL DEFAULT 0, other_cost REAL DEFAULT 0, total_revenue REAL DEFAULT 0, total_cost REAL DEFAULT 0, profit REAL DEFAULT 0, settlement_id INTEGER, notes TEXT, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS tms_driver_pay (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, driver_id INTEGER NOT NULL REFERENCES company_users(id) ON DELETE CASCADE, period_start TEXT, period_end TEXT, pay_type TEXT DEFAULT 'per-mile', rate REAL DEFAULT 0, total_miles INTEGER DEFAULT 0, total_loads INTEGER DEFAULT 0, gross_pay REAL DEFAULT 0, bonus REAL DEFAULT 0, deductions REAL DEFAULT 0, reimbursements REAL DEFAULT 0, net_pay REAL DEFAULT 0, status TEXT DEFAULT 'draft', paid_date TEXT, notes TEXT, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS tms_dispatchers (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES company_users(id) ON DELETE CASCADE, team_name TEXT, max_drivers INTEGER DEFAULT 20, is_active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS tms_documents (id SERIAL PRIMARY KEY, load_id INTEGER NOT NULL REFERENCES tms_loads(id) ON DELETE CASCADE, type TEXT DEFAULT 'other', filename TEXT NOT NULL, original_name TEXT NOT NULL, uploaded_by TEXT, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS tms_status_log (id SERIAL PRIMARY KEY, load_id INTEGER NOT NULL REFERENCES tms_loads(id) ON DELETE CASCADE, status TEXT NOT NULL, note TEXT, location TEXT, changed_by TEXT, created_at TIMESTAMP DEFAULT NOW());

-- Fuel Incentive
CREATE TABLE IF NOT EXISTS fuel_config (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE, enabled INTEGER DEFAULT 0, billing_mode TEXT DEFAULT 'per-truck', split_driver_pct REAL DEFAULT 50, split_company_pct REAL DEFAULT 50, baseline_window_days INTEGER DEFAULT 90, baseline_mpg REAL DEFAULT 0, fuel_price_source TEXT DEFAULT 'manual', fuel_price_manual REAL DEFAULT 0, min_miles_qualify INTEGER DEFAULT 500, ceiling_bonus_per_gallon REAL DEFAULT 0.50, floor_penalty_per_gallon REAL DEFAULT 0, pay_frequency TEXT DEFAULT 'monthly', notes TEXT, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS fuel_groups (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT, baseline_mpg REAL DEFAULT 0, vehicle_ids TEXT, is_active INTEGER DEFAULT 1, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS fuel_driver_baselines (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, driver_id INTEGER NOT NULL REFERENCES company_users(id) ON DELETE CASCADE, group_id INTEGER REFERENCES fuel_groups(id) ON DELETE SET NULL, baseline_mpg REAL DEFAULT 0, effective_date TEXT, notes TEXT);
CREATE TABLE IF NOT EXISTS fuel_audit_log (id SERIAL PRIMARY KEY, company_id INTEGER, driver_id INTEGER, vehicle_id INTEGER, action TEXT NOT NULL, period_start TEXT, period_end TEXT, baseline_mpg REAL, actual_mpg REAL, gallons_saved REAL, fuel_price REAL, gross_savings REAL, driver_share REAL, company_share REAL, miles INTEGER, gallons REAL, details TEXT, created_by TEXT, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS fuel_truck_group_map (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, vehicle_id INTEGER NOT NULL, group_id INTEGER NOT NULL, assigned_at TIMESTAMP DEFAULT NOW(), assigned_by TEXT, UNIQUE(company_id, vehicle_id));
CREATE TABLE IF NOT EXISTS fuel_driver_group_map (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, driver_id INTEGER NOT NULL, group_id INTEGER NOT NULL, assigned_at TIMESTAMP DEFAULT NOW(), assigned_by TEXT, UNIQUE(company_id, driver_id));
CREATE TABLE IF NOT EXISTS fuel_vin_cache (id SERIAL PRIMARY KEY, vin TEXT NOT NULL UNIQUE, make TEXT, model TEXT, year INTEGER, body_class TEXT, fuel_type TEXT, engine TEXT, gvwr TEXT, drive_type TEXT, raw_json TEXT, decoded_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS fuel_integrations (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, provider TEXT NOT NULL, label TEXT, encrypted_secrets TEXT NOT NULL, base_url TEXT, status TEXT DEFAULT 'pending', last_sync_at TIMESTAMP, last_error TEXT, sync_from_date TEXT, is_active INTEGER DEFAULT 1, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS fuel_provider_asset_map (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, integration_id INTEGER NOT NULL REFERENCES fuel_integrations(id) ON DELETE CASCADE, provider_vehicle_id TEXT NOT NULL, provider_vehicle_name TEXT, provider_vin TEXT, internal_vehicle_id INTEGER, internal_driver_id INTEGER, mapped_by TEXT DEFAULT 'auto', mapped_at TIMESTAMP DEFAULT NOW(), UNIQUE(integration_id, provider_vehicle_id));
CREATE TABLE IF NOT EXISTS fuel_measurements_daily (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, integration_id INTEGER, vehicle_id INTEGER, driver_id INTEGER, date TEXT NOT NULL, miles REAL DEFAULT 0, gallons REAL DEFAULT 0, mpg REAL DEFAULT 0, idle_hours REAL DEFAULT 0, idle_gallons REAL DEFAULT 0, odometer_start REAL, odometer_end REAL, provider TEXT, provider_vehicle_id TEXT, raw_data TEXT, created_at TIMESTAMP DEFAULT NOW(), UNIQUE(company_id, vehicle_id, date, provider));
CREATE TABLE IF NOT EXISTS fuel_baseline_snapshots (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, group_id INTEGER, driver_id INTEGER, scope TEXT DEFAULT 'group', period_start TEXT NOT NULL, period_end TEXT NOT NULL, window_days INTEGER, total_miles REAL DEFAULT 0, total_gallons REAL DEFAULT 0, baseline_mpg REAL DEFAULT 0, method TEXT DEFAULT 'miles_over_gallons', vehicle_count INTEGER DEFAULT 0, measurement_count INTEGER DEFAULT 0, is_current INTEGER DEFAULT 1, computed_by TEXT, computed_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS fuel_target_policies (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, group_id INTEGER NOT NULL, target_mpg REAL NOT NULL, kpi_bonus_usd REAL DEFAULT 0, penalty_usd REAL DEFAULT 0, effective_from TEXT NOT NULL, effective_to TEXT, is_active INTEGER DEFAULT 1, notes TEXT, created_by TEXT, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS fuel_target_overrides (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, driver_id INTEGER NOT NULL, target_mpg REAL NOT NULL, kpi_bonus_usd REAL DEFAULT 0, penalty_usd REAL DEFAULT 0, effective_from TEXT NOT NULL, effective_to TEXT, reason TEXT, is_active INTEGER DEFAULT 1, created_by TEXT, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS fuel_payout_periods (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, status TEXT DEFAULT 'open', config_snapshot TEXT, total_drivers INTEGER DEFAULT 0, total_eligible INTEGER DEFAULT 0, total_driver_payout REAL DEFAULT 0, total_company_share REAL DEFAULT 0, total_platform_fee REAL DEFAULT 0, total_kpi_bonus REAL DEFAULT 0, total_savings REAL DEFAULT 0, calculated_at TIMESTAMP, calculated_by TEXT, approved_at TIMESTAMP, approved_by TEXT, closed_at TIMESTAMP, closed_by TEXT, notes TEXT, created_at TIMESTAMP DEFAULT NOW(), UNIQUE(company_id, period_start, period_end));
CREATE TABLE IF NOT EXISTS fuel_payout_ledgers (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, period_id INTEGER NOT NULL, driver_id INTEGER NOT NULL, driver_name TEXT, group_id INTEGER, group_name TEXT, status TEXT DEFAULT 'pending', total_miles REAL DEFAULT 0, total_gallons REAL DEFAULT 0, actual_mpg REAL DEFAULT 0, mpg_method TEXT, baseline_mpg REAL DEFAULT 0, target_mpg REAL, target_source TEXT, kpi_bonus_usd REAL DEFAULT 0, kpi_earned INTEGER DEFAULT 0, savings_gallons REAL DEFAULT 0, fuel_price REAL DEFAULT 0, savings_usd REAL DEFAULT 0, driver_share_pct REAL DEFAULT 0, company_share_pct REAL DEFAULT 0, platform_share_pct REAL DEFAULT 0, driver_share_usd REAL DEFAULT 0, company_share_usd REAL DEFAULT 0, platform_fee_usd REAL DEFAULT 0, driver_payout REAL DEFAULT 0, explanation_json TEXT, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS fuel_payout_adjustments (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, source_period_id INTEGER, target_period_id INTEGER, driver_id INTEGER NOT NULL, amount REAL NOT NULL, reason TEXT NOT NULL, status TEXT DEFAULT 'pending', created_by TEXT, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS fuel_ceiling_log (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, group_id INTEGER, consecutive_periods INTEGER, avg_mpg_delta REAL, old_billing_mode TEXT, new_billing_mode TEXT, triggered_at TIMESTAMP DEFAULT NOW());

-- Gamification
CREATE TABLE IF NOT EXISTS user_xp (id SERIAL PRIMARY KEY, username TEXT NOT NULL, action TEXT NOT NULL, xp INTEGER NOT NULL, description TEXT, created_at TIMESTAMP DEFAULT NOW());

-- Schedule
CREATE TABLE IF NOT EXISTS service_schedule (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, service_id INTEGER REFERENCES services(id) ON DELETE SET NULL, title TEXT NOT NULL, description TEXT, frequency TEXT DEFAULT 'monthly', day_of_month INTEGER DEFAULT 1, day_of_week TEXT, time_slot TEXT, assigned_to TEXT, is_active INTEGER DEFAULT 1, last_completed TEXT, next_due TEXT, notes TEXT, created_at TIMESTAMP DEFAULT NOW());

-- User equipment/software
CREATE TABLE IF NOT EXISTS user_software (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, user_id INTEGER REFERENCES company_users(id) ON DELETE SET NULL, name TEXT NOT NULL, license_key TEXT, license_type TEXT DEFAULT 'per-user', vendor TEXT, expires_at TEXT, cost REAL DEFAULT 0, notes TEXT);
CREATE TABLE IF NOT EXISTS user_equipment (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, user_id INTEGER REFERENCES company_users(id) ON DELETE SET NULL, inventory_id INTEGER REFERENCES inventory(id) ON DELETE CASCADE, assigned_date TIMESTAMP DEFAULT NOW(), notes TEXT);

-- Migrations tracking
CREATE TABLE IF NOT EXISTS migrations (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TIMESTAMP DEFAULT NOW());

-- ============ INDEXES ============
CREATE INDEX IF NOT EXISTS idx_company_users_company ON company_users(company_id, is_active);
CREATE INDEX IF NOT EXISTS idx_fleet_vehicles_company ON fleet_vehicles(company_id, status);
CREATE INDEX IF NOT EXISTS idx_fleet_trailers_company ON fleet_trailers(company_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_company ON tasks(company_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices(company_id, status);
CREATE INDEX IF NOT EXISTS idx_inventory_company ON inventory(company_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_channels_company ON chat_channels(company_id);
CREATE INDEX IF NOT EXISTS idx_tms_loads_company ON tms_loads(company_id, status);
CREATE INDEX IF NOT EXISTS idx_tms_loads_driver ON tms_loads(driver_id, status);
CREATE INDEX IF NOT EXISTS idx_user_xp_username ON user_xp(username);
CREATE INDEX IF NOT EXISTS idx_users_login ON users(username, role, is_active);
CREATE INDEX IF NOT EXISTS idx_fmd_company_date ON fuel_measurements_daily(company_id, date);
CREATE INDEX IF NOT EXISTS idx_fmd_vehicle_date ON fuel_measurements_daily(company_id, vehicle_id, date);
CREATE INDEX IF NOT EXISTS idx_fpl_period ON fuel_payout_ledgers(period_id, company_id);
CREATE INDEX IF NOT EXISTS idx_fbs_group ON fuel_baseline_snapshots(company_id, group_id, is_current);
CREATE INDEX IF NOT EXISTS idx_eld_vehicles_company ON eld_vehicles(company_id, integration_id);

-- ============ SEED DATA ============
INSERT INTO settings (key, value) VALUES ('business_name', 'IT Forge') ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('business_email', '') ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('business_phone', '') ON CONFLICT (key) DO NOTHING;
