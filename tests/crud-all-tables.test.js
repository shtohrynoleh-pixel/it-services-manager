// Comprehensive CRUD test for every table in the system
// Run: node tests/crud-all-tables.test.js
//
// Tests Create, Read, Update, Delete on every table via direct DB calls.
// Uses in-memory SQLite — same as the app runs locally.

const Database = require('better-sqlite3');

let db;
let passed = 0, failed = 0, skipped = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log('  ✅ ' + msg); }
  else { failed++; console.log('  ❌ FAIL: ' + msg); }
}

function skip(msg) {
  skipped++; console.log('  ⏭️  SKIP: ' + msg);
}

// ================================================================
//  SCHEMA — minimal table creation for all tables
// ================================================================
function setup() {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- Core
    CREATE TABLE settings (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE, value TEXT);
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, role TEXT DEFAULT 'admin', company_id INTEGER, full_name TEXT, email TEXT, phone TEXT, is_active INTEGER DEFAULT 1, is_super INTEGER DEFAULT 0, totp_secret TEXT, totp_enabled INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE companies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, status TEXT DEFAULT 'active', address TEXT, city TEXT, state TEXT, zip TEXT, phone TEXT, email TEXT, website TEXT, logo TEXT, webhook_key TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE admin_companies (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, company_id INTEGER, UNIQUE(user_id, company_id));
    CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, name TEXT, email TEXT, phone TEXT, title TEXT, is_primary INTEGER DEFAULT 0, notes TEXT);
    CREATE TABLE roles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, description TEXT, company_id INTEGER);
    CREATE TABLE departments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, description TEXT, company_id INTEGER);

    -- Company Users & Assets
    CREATE TABLE company_users (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, name TEXT NOT NULL, title TEXT, email TEXT, phone TEXT, department TEXT, role TEXT, manager_id INTEGER, access_level TEXT DEFAULT 'limited', hire_date TEXT, is_active INTEGER DEFAULT 1, notes TEXT, pay_type TEXT DEFAULT 'per-mile', pay_rate REAL DEFAULT 0, is_driver INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE user_software (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT, license_key TEXT, expiry_date TEXT, notes TEXT);
    CREATE TABLE user_equipment (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT, serial TEXT, assigned_date TEXT, notes TEXT);
    CREATE TABLE servers (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, name TEXT, type TEXT, ip_address TEXT, os TEXT, status TEXT DEFAULT 'active', notes TEXT);
    CREATE TABLE subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, service TEXT, vendor TEXT, cost REAL DEFAULT 0, renewal_date TEXT, status TEXT DEFAULT 'active', notes TEXT);
    CREATE TABLE assets (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, name TEXT, type TEXT, serial_number TEXT, assigned_to TEXT, status TEXT DEFAULT 'in-use', purchase_date TEXT, warranty_date TEXT, notes TEXT);
    CREATE TABLE inventory_locations (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, name TEXT NOT NULL, address TEXT, is_active INTEGER DEFAULT 1);
    CREATE TABLE inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, name TEXT, sku TEXT, category TEXT, quantity INTEGER DEFAULT 0, unit_cost REAL DEFAULT 0, location_id INTEGER, reorder_point INTEGER DEFAULT 0, notes TEXT);

    -- Services & Billing
    CREATE TABLE services (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, description TEXT, base_price REAL DEFAULT 0, is_active INTEGER DEFAULT 1, is_public INTEGER DEFAULT 0, show_on_landing INTEGER DEFAULT 0, icon TEXT);
    CREATE TABLE service_schedule (id INTEGER PRIMARY KEY AUTOINCREMENT, service_id INTEGER, company_id INTEGER, user_id INTEGER, scheduled_date TEXT, status TEXT DEFAULT 'scheduled', notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE agreements (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, service_id INTEGER, title TEXT, start_date TEXT, end_date TEXT, value REAL DEFAULT 0, status TEXT DEFAULT 'active', auto_renew INTEGER DEFAULT 1, sla_response TEXT, file_path TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE rdp_connections (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, name TEXT, hostname TEXT, port INTEGER DEFAULT 3389, username TEXT, protocol TEXT DEFAULT 'rdp', notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, invoice_number TEXT UNIQUE, date TEXT, due_date TEXT, total REAL DEFAULT 0, status TEXT DEFAULT 'draft', notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE invoice_items (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL, description TEXT, quantity REAL DEFAULT 1, unit_price REAL DEFAULT 0, total REAL DEFAULT 0);

    -- Projects & Tasks
    CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, company_id INTEGER, status TEXT DEFAULT 'planning', start_date TEXT, due_date TEXT, budget REAL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE project_statuses (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, color TEXT, sort_order INTEGER DEFAULT 0);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT, company_id INTEGER, project_id INTEGER, priority TEXT DEFAULT 'medium', status TEXT DEFAULT 'todo', assigned_to TEXT, created_by TEXT, due_date TEXT, started_at TEXT, completed_at TEXT, first_response_at TEXT, sla_response_min INTEGER, sla_resolve_min INTEGER, created_at TEXT DEFAULT (datetime('now')));

    -- Monitoring
    CREATE TABLE equipment_monitors (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, name TEXT, target TEXT, check_type TEXT DEFAULT 'http', interval_min INTEGER DEFAULT 5, is_active INTEGER DEFAULT 1, last_check TEXT, last_status TEXT DEFAULT 'unknown', last_response_ms INTEGER DEFAULT 0, uptime_pct REAL DEFAULT 0);
    CREATE TABLE monitor_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, monitor_id INTEGER, status TEXT, response_ms INTEGER, error TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, monitor_id INTEGER, source TEXT, severity TEXT DEFAULT 'warning', title TEXT, description TEXT, status TEXT DEFAULT 'open', resolved_at TEXT, resolved_by TEXT, resolution TEXT, created_at TEXT DEFAULT (datetime('now')));

    -- SOPs & Policies
    CREATE TABLE sops (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, title TEXT NOT NULL, description TEXT, category TEXT, version INTEGER DEFAULT 1, status TEXT DEFAULT 'draft', created_by TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE sop_sections (id INTEGER PRIMARY KEY AUTOINCREMENT, sop_id INTEGER NOT NULL, title TEXT, sort_order INTEGER DEFAULT 0);
    CREATE TABLE sop_steps (id INTEGER PRIMARY KEY AUTOINCREMENT, sop_id INTEGER NOT NULL, section_id INTEGER, content TEXT, sort_order INTEGER DEFAULT 0);
    CREATE TABLE sop_acknowledgments (id INTEGER PRIMARY KEY AUTOINCREMENT, sop_id INTEGER NOT NULL, user_name TEXT, company_name TEXT, acknowledged_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE sop_references (id INTEGER PRIMARY KEY AUTOINCREMENT, sop_id INTEGER NOT NULL, title TEXT, url TEXT);
    CREATE TABLE sop_revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, sop_id INTEGER NOT NULL, version INTEGER, change_summary TEXT, revised_by TEXT, revised_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE security_policies (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, title TEXT NOT NULL, description TEXT, content TEXT, category TEXT DEFAULT 'General', version INTEGER DEFAULT 1, status TEXT DEFAULT 'draft', requires_ack INTEGER DEFAULT 0, review_date TEXT, company_name TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE policy_acknowledgments (id INTEGER PRIMARY KEY AUTOINCREMENT, policy_id INTEGER NOT NULL, user_name TEXT, company_name TEXT, company_id INTEGER, acknowledged_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE password_vault (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, title TEXT NOT NULL, username TEXT, password TEXT, url TEXT, notes TEXT, category TEXT, created_by TEXT, created_at TEXT DEFAULT (datetime('now')));

    -- Process Flows
    CREATE TABLE process_flows (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, title TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'active', created_by TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE flow_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, flow_id INTEGER NOT NULL, type TEXT, label TEXT, x REAL DEFAULT 0, y REAL DEFAULT 0, config TEXT);

    -- Chat
    CREATE TABLE chat_channels (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, company_id INTEGER, type TEXT DEFAULT 'group', created_by TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE chat_members (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER NOT NULL, user_id INTEGER NOT NULL, last_read_at TEXT, joined_at TEXT DEFAULT (datetime('now')), UNIQUE(channel_id, user_id));
    CREATE TABLE chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER NOT NULL, user_id INTEGER, username TEXT, message TEXT, file_url TEXT, file_name TEXT, is_system INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));

    -- Email & Auth
    CREATE TABLE email_providers (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, provider TEXT, domain TEXT, status TEXT DEFAULT 'active', mx_record TEXT, spf TEXT, dkim TEXT, dmarc TEXT, notes TEXT);
    CREATE TABLE password_reset_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, token TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));

    -- Files
    CREATE TABLE file_folders (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, name TEXT NOT NULL, parent_id INTEGER, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE folder_access (id INTEGER PRIMARY KEY AUTOINCREMENT, folder_id INTEGER NOT NULL, user_id INTEGER NOT NULL, permission TEXT DEFAULT 'read');
    CREATE TABLE company_files (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, folder_id INTEGER, filename TEXT, original_name TEXT, size INTEGER DEFAULT 0, mime_type TEXT, uploaded_by TEXT, created_at TEXT DEFAULT (datetime('now')));

    -- Gamification
    CREATE TABLE user_xp (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, action TEXT NOT NULL, xp INTEGER DEFAULT 0, description TEXT, created_at TEXT DEFAULT (datetime('now')));

    -- ELD
    CREATE TABLE eld_integrations (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, provider TEXT, api_key TEXT, status TEXT DEFAULT 'active', last_sync TEXT);
    CREATE TABLE eld_vehicles (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, integration_id INTEGER, provider_vehicle_id TEXT, name TEXT, vin TEXT, asset_type TEXT DEFAULT 'vehicle', lat REAL, lng REAL, speed REAL, heading REAL, last_location_at TEXT, raw_data TEXT, created_at TEXT DEFAULT (datetime('now')));

    -- Company Modules
    CREATE TABLE company_modules (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL UNIQUE, tms INTEGER DEFAULT 0, fleet INTEGER DEFAULT 0, monitoring INTEGER DEFAULT 0, files INTEGER DEFAULT 1, chat INTEGER DEFAULT 1, sops INTEGER DEFAULT 1, policies INTEGER DEFAULT 1, passwords INTEGER DEFAULT 1, eld INTEGER DEFAULT 0, domains INTEGER DEFAULT 1, rdp INTEGER DEFAULT 1, expenses INTEGER DEFAULT 0);

    -- TMS
    CREATE TABLE tms_loads (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, load_number TEXT, status TEXT DEFAULT 'available', customer TEXT, origin TEXT, destination TEXT, pickup_date TEXT, delivery_date TEXT, rate REAL DEFAULT 0, weight REAL, commodity TEXT, driver_id INTEGER, vehicle_id INTEGER, trailer_id INTEGER, dispatcher_id INTEGER, trip_id INTEGER, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE tms_stops (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id INTEGER NOT NULL, type TEXT, location TEXT, date TEXT, time TEXT, notes TEXT, sort_order INTEGER DEFAULT 0);
    CREATE TABLE tms_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id INTEGER NOT NULL, type TEXT, filename TEXT, original_name TEXT, uploaded_by TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE tms_status_log (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id INTEGER NOT NULL, old_status TEXT, new_status TEXT, changed_by TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE tms_trips (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, trip_number TEXT, driver_id INTEGER, vehicle_id INTEGER, start_date TEXT, end_date TEXT, status TEXT DEFAULT 'planned', total_miles REAL DEFAULT 0, total_revenue REAL DEFAULT 0, settlement_id INTEGER, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE tms_driver_pay (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, driver_id INTEGER, trip_id INTEGER, pay_type TEXT, amount REAL DEFAULT 0, description TEXT, status TEXT DEFAULT 'pending', period_start TEXT, period_end TEXT, approved_by TEXT, paid_date TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE tms_dispatchers (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, user_id INTEGER, name TEXT, email TEXT, phone TEXT, is_active INTEGER DEFAULT 1);

    -- Fleet
    CREATE TABLE fleet_vehicles (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, unit_number TEXT, vin TEXT, year INTEGER, make TEXT, model TEXT, type TEXT DEFAULT 'truck', status TEXT DEFAULT 'active', license_plate TEXT, eld_vehicle_id INTEGER, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE fleet_trailers (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, unit_number TEXT, vin TEXT, year INTEGER, make TEXT, model TEXT, type TEXT DEFAULT 'dry-van', status TEXT DEFAULT 'active', license_plate TEXT, eld_vehicle_id INTEGER, notes TEXT, created_at TEXT DEFAULT (datetime('now')));

    -- Fuel
    CREATE TABLE fuel_config (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL UNIQUE, enabled INTEGER DEFAULT 0, billing_mode TEXT DEFAULT 'per-gallon', split_driver_pct INTEGER DEFAULT 50, split_company_pct INTEGER DEFAULT 50, baseline_window_days INTEGER DEFAULT 90, baseline_mpg REAL, min_miles_qualify INTEGER DEFAULT 500, ceiling_bonus_per_gallon REAL DEFAULT 0.50, fuel_price_source TEXT DEFAULT 'manual', fuel_price_manual REAL DEFAULT 0);
    CREATE TABLE fuel_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, name TEXT NOT NULL, baseline_mpg REAL DEFAULT 0, is_active INTEGER DEFAULT 1);
    CREATE TABLE fuel_truck_group_map (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, vehicle_id INTEGER, group_id INTEGER);
    CREATE TABLE fuel_driver_group_map (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, driver_id INTEGER, group_id INTEGER);
    CREATE TABLE fuel_driver_baselines (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, driver_id INTEGER, baseline_mpg REAL, effective_from TEXT, notes TEXT, created_by TEXT);
    CREATE TABLE fuel_baseline_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, group_id INTEGER, driver_id INTEGER, scope TEXT, period_start TEXT, period_end TEXT, window_days INTEGER, total_miles REAL, total_gallons REAL, baseline_mpg REAL, method TEXT, vehicle_count INTEGER, measurement_count INTEGER, is_current INTEGER, computed_by TEXT, computed_at TEXT);
    CREATE TABLE fuel_measurements_daily (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, integration_id INTEGER, vehicle_id INTEGER, driver_id INTEGER, date TEXT, miles REAL, gallons REAL, mpg REAL, idle_hours REAL, idle_gallons REAL, odometer_start REAL, odometer_end REAL, provider TEXT, provider_vehicle_id TEXT, raw_data TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE fuel_payout_periods (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, period_start TEXT, period_end TEXT, status TEXT DEFAULT 'draft', fuel_price REAL, total_savings REAL DEFAULT 0, total_driver_payout REAL DEFAULT 0, total_company_share REAL DEFAULT 0, driver_count INTEGER DEFAULT 0, created_by TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE fuel_payout_ledgers (id INTEGER PRIMARY KEY AUTOINCREMENT, period_id INTEGER NOT NULL, company_id INTEGER, driver_id INTEGER, driver_name TEXT, group_id INTEGER, group_name TEXT, baseline_mpg REAL, actual_mpg REAL, total_miles REAL, total_gallons REAL, gallons_saved REAL, fuel_price REAL, gross_savings REAL, driver_share REAL, company_share REAL, kpi_bonus REAL DEFAULT 0, eligible INTEGER DEFAULT 1, ineligible_reason TEXT, explanation_json TEXT);
    CREATE TABLE fuel_target_policies (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, group_id INTEGER, target_mpg REAL, kpi_bonus_usd REAL DEFAULT 0, penalty_usd REAL DEFAULT 0, effective_from TEXT, effective_to TEXT, is_active INTEGER DEFAULT 1, notes TEXT, created_by TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE fuel_target_overrides (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, driver_id INTEGER, target_mpg REAL, kpi_bonus_usd REAL DEFAULT 0, penalty_usd REAL DEFAULT 0, effective_from TEXT, effective_to TEXT, reason TEXT, is_active INTEGER DEFAULT 1, created_by TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE fuel_integrations (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, provider TEXT, api_key_encrypted TEXT, api_key_iv TEXT, api_key_tag TEXT, status TEXT DEFAULT 'pending', last_sync TEXT, sync_count INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE fuel_provider_asset_map (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, integration_id INTEGER, provider_asset_id TEXT, provider_asset_name TEXT, provider_asset_vin TEXT, fleet_vehicle_id INTEGER, asset_type TEXT DEFAULT 'vehicle', is_mapped INTEGER DEFAULT 0, raw_data TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE fuel_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, driver_id INTEGER, vehicle_id INTEGER, action TEXT NOT NULL, period_start TEXT, period_end TEXT, baseline_mpg REAL, actual_mpg REAL, gallons_saved REAL, fuel_price REAL, gross_savings REAL, driver_share REAL, company_share REAL, miles INTEGER, gallons REAL, details TEXT, created_by TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE fuel_ceiling_log (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, group_id INTEGER, exceeded_mpg REAL, consecutive_periods INTEGER, switched_at TEXT);
    CREATE TABLE fuel_vin_cache (id INTEGER PRIMARY KEY AUTOINCREMENT, vin TEXT UNIQUE, year INTEGER, make TEXT, model TEXT, body_class TEXT, engine TEXT, fuel_type TEXT, gvwr TEXT, raw_json TEXT, created_at TEXT DEFAULT (datetime('now')));

    -- Expenses
    CREATE TABLE expense_cost_centers (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, manager_id INTEGER, is_active INTEGER DEFAULT 1, notes TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(company_id, code));
    CREATE TABLE expense_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, name TEXT NOT NULL, parent_id INTEGER, icon TEXT, is_active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), UNIQUE(company_id, name));
    CREATE TABLE expense_vendors (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, name TEXT NOT NULL, contact TEXT, email TEXT, phone TEXT, address TEXT, tax_id TEXT, notes TEXT, is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')), UNIQUE(company_id, name));
    CREATE TABLE expense_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, date TEXT NOT NULL, amount REAL NOT NULL, description TEXT, vendor_id INTEGER, vendor_name TEXT, category_id INTEGER, category_name TEXT, cost_center_id INTEGER, cost_center_code TEXT, project_id INTEGER, project_name TEXT, reference TEXT, invoice_number TEXT, source TEXT DEFAULT 'manual', import_batch_id INTEGER, dedupe_hash TEXT, status TEXT DEFAULT 'pending', approved_by TEXT, approved_at TEXT, notes TEXT, created_by TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE expense_import_batches (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, filename TEXT, source TEXT DEFAULT 'csv', status TEXT DEFAULT 'pending', total_rows INTEGER DEFAULT 0, imported_rows INTEGER DEFAULT 0, skipped_rows INTEGER DEFAULT 0, error_rows INTEGER DEFAULT 0, total_amount REAL DEFAULT 0, errors TEXT, uploaded_by TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE expense_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, entity_type TEXT NOT NULL, entity_id INTEGER, action TEXT NOT NULL, field_changes TEXT, performed_by TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));

    -- Salary / Payroll
    CREATE TABLE salary_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, employee_id INTEGER NOT NULL, employee_name TEXT NOT NULL, cost_center_id INTEGER, project_id INTEGER, pay_frequency TEXT NOT NULL DEFAULT 'monthly', amount REAL NOT NULL DEFAULT 0, effective_from TEXT, effective_to TEXT, is_active INTEGER DEFAULT 1, notes TEXT, created_by TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), UNIQUE(company_id, employee_id));
    CREATE TABLE salary_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, pay_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', total_amount REAL DEFAULT 0, line_count INTEGER DEFAULT 0, approved_by TEXT, approved_at TEXT, posted_by TEXT, posted_at TEXT, notes TEXT, created_by TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE salary_run_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, company_id INTEGER NOT NULL, profile_id INTEGER NOT NULL, employee_id INTEGER NOT NULL, employee_name TEXT NOT NULL, amount REAL NOT NULL, cost_center_id INTEGER, cost_center_code TEXT, project_id INTEGER, project_name TEXT, description TEXT, transaction_id INTEGER);
  `);
}

// ================================================================
//  SEED — base records needed by FK relationships
// ================================================================
function seed() {
  db.prepare("INSERT INTO settings (key, value) VALUES ('app_name', 'IT Forge')").run();
  db.prepare("INSERT INTO users (username, password, role, full_name, email, is_super) VALUES ('admin', 'hashed', 'admin', 'Admin', 'admin@test.com', 1)").run();
  db.prepare("INSERT INTO companies (name, status) VALUES ('Acme Trucking', 'active')").run();
  db.prepare("INSERT INTO companies (name, status) VALUES ('Beta Logistics', 'active')").run();
  db.prepare("INSERT INTO company_modules (company_id, tms, fleet, expenses) VALUES (1, 1, 1, 1)").run();
  db.prepare("INSERT INTO company_users (company_id, name, title, email, is_driver) VALUES (1, 'John Driver', 'Driver', 'john@acme.com', 1)").run();
  db.prepare("INSERT INTO company_users (company_id, name, title, email, is_driver) VALUES (1, 'Jane Office', 'Manager', 'jane@acme.com', 0)").run();
  db.prepare("INSERT INTO company_users (company_id, name, title, email, is_driver) VALUES (2, 'Bob Other', 'Driver', 'bob@beta.com', 1)").run();
  db.prepare("INSERT INTO services (name, base_price, is_active) VALUES ('IT Support', 100, 1)").run();
}

// ================================================================
//  CRUD HELPER — test C/R/U/D for a table in one call
// ================================================================
function testCRUD(label, table, insertSQL, insertParams, updateSQL, updateParams, readCheck, readCheckAfterUpdate) {
  console.log('\n' + label);

  // CREATE
  let id;
  try {
    const r = db.prepare(insertSQL).run(...insertParams);
    id = r.lastInsertRowid;
    assert(id > 0, table + ' — INSERT returns id=' + id);
  } catch(e) {
    assert(false, table + ' — INSERT failed: ' + e.message);
    return;
  }

  // READ
  const row = db.prepare('SELECT * FROM ' + table + ' WHERE id = ?').get(id);
  assert(row !== undefined, table + ' — SELECT by id');
  if (readCheck) {
    try { readCheck(row); } catch(e) { assert(false, table + ' — READ check: ' + e.message); }
  }

  // UPDATE
  if (updateSQL) {
    try {
      db.prepare(updateSQL).run(...updateParams, id);
      const updated = db.prepare('SELECT * FROM ' + table + ' WHERE id = ?').get(id);
      assert(updated !== undefined, table + ' — UPDATE succeeded');
      if (readCheckAfterUpdate) {
        try { readCheckAfterUpdate(updated); } catch(e) { assert(false, table + ' — UPDATE check: ' + e.message); }
      }
    } catch(e) { assert(false, table + ' — UPDATE failed: ' + e.message); }
  }

  // COUNT
  const cnt = db.prepare('SELECT COUNT(*) as c FROM ' + table).get();
  assert(cnt.c >= 1, table + ' — COUNT >= 1');

  // DELETE
  try {
    db.prepare('DELETE FROM ' + table + ' WHERE id = ?').run(id);
    const gone = db.prepare('SELECT * FROM ' + table + ' WHERE id = ?').get(id);
    assert(!gone, table + ' — DELETE removes row');
  } catch(e) {
    assert(false, table + ' — DELETE failed: ' + e.message);
  }
}

// ================================================================
//  TEST SUITES
// ================================================================

function testCoreModule() {
  console.log('\n═══════════════════════════════════════');
  console.log('🏢 CORE: Settings, Users, Companies');
  console.log('═══════════════════════════════════════');

  testCRUD('📋 Settings', 'settings',
    "INSERT INTO settings (key, value) VALUES (?, ?)", ['test_key', 'test_value'],
    "UPDATE settings SET value = ? WHERE id = ?", ['updated_value'],
    r => assert(r.value === 'test_value', 'settings — value matches'),
    r => assert(r.value === 'updated_value', 'settings — updated value matches')
  );

  testCRUD('👤 Users', 'users',
    "INSERT INTO users (username, password, role, full_name, email) VALUES (?,?,?,?,?)", ['testuser', 'hash123', 'admin', 'Test User', 'test@test.com'],
    "UPDATE users SET full_name = ? WHERE id = ?", ['Updated Name'],
    r => assert(r.username === 'testuser', 'users — username matches'),
    r => assert(r.full_name === 'Updated Name', 'users — name updated')
  );

  testCRUD('🏢 Companies', 'companies',
    "INSERT INTO companies (name, status) VALUES (?,?)", ['Test Corp', 'active'],
    "UPDATE companies SET name = ? WHERE id = ?", ['Renamed Corp'],
    r => assert(r.name === 'Test Corp', 'companies — name matches'),
    r => assert(r.name === 'Renamed Corp', 'companies — name updated')
  );

  testCRUD('🔗 Admin Companies', 'admin_companies',
    "INSERT INTO admin_companies (user_id, company_id) VALUES (?,?)", [1, 1],
    null, null, r => assert(r.user_id === 1, 'admin_companies — user_id matches')
  );

  testCRUD('📇 Contacts', 'contacts',
    "INSERT INTO contacts (company_id, name, email, phone, is_primary) VALUES (?,?,?,?,?)", [1, 'Jim', 'jim@acme.com', '555-1234', 1],
    "UPDATE contacts SET name = ? WHERE id = ?", ['Jimmy'],
    r => assert(r.name === 'Jim', 'contacts — name matches'),
    r => assert(r.name === 'Jimmy', 'contacts — name updated')
  );

  testCRUD('🎭 Roles', 'roles',
    "INSERT INTO roles (name, description, company_id) VALUES (?,?,?)", ['Dispatcher', 'Manages loads', 1],
    "UPDATE roles SET name = ? WHERE id = ?", ['Sr Dispatcher'],
    null, r => assert(r.name === 'Sr Dispatcher', 'roles — updated')
  );

  testCRUD('🏬 Departments', 'departments',
    "INSERT INTO departments (name, description, company_id) VALUES (?,?,?)", ['Operations', 'Ops dept', 1],
    "UPDATE departments SET name = ? WHERE id = ?", ['Fleet Ops'],
    null, r => assert(r.name === 'Fleet Ops', 'departments — updated')
  );
}

function testCompanyAssets() {
  console.log('\n═══════════════════════════════════════');
  console.log('👥 COMPANY ASSETS: Users, Servers, Subs, etc.');
  console.log('═══════════════════════════════════════');

  testCRUD('👥 Company Users', 'company_users',
    "INSERT INTO company_users (company_id, name, title, email, is_driver) VALUES (?,?,?,?,?)", [1, 'New Guy', 'Tech', 'new@acme.com', 0],
    "UPDATE company_users SET title = ? WHERE id = ?", ['Sr Tech'],
    r => assert(r.name === 'New Guy', 'company_users — name matches'),
    r => assert(r.title === 'Sr Tech', 'company_users — title updated')
  );

  testCRUD('💻 User Software', 'user_software',
    "INSERT INTO user_software (user_id, name, license_key) VALUES (?,?,?)", [1, 'Office 365', 'XXXX-YYYY'],
    "UPDATE user_software SET license_key = ? WHERE id = ?", ['NEW-KEY'],
    null, r => assert(r.license_key === 'NEW-KEY', 'user_software — key updated')
  );

  testCRUD('🖥️ User Equipment', 'user_equipment',
    "INSERT INTO user_equipment (user_id, name, serial) VALUES (?,?,?)", [1, 'Laptop', 'SN123'],
    "UPDATE user_equipment SET name = ? WHERE id = ?", ['Desktop'],
    null, r => assert(r.name === 'Desktop', 'user_equipment — updated')
  );

  testCRUD('🖧 Servers', 'servers',
    "INSERT INTO servers (company_id, name, type, ip_address, status) VALUES (?,?,?,?,?)", [1, 'Web01', 'linux', '10.0.0.1', 'active'],
    "UPDATE servers SET status = ? WHERE id = ?", ['maintenance'],
    r => assert(r.ip_address === '10.0.0.1', 'servers — IP matches'),
    r => assert(r.status === 'maintenance', 'servers — status updated')
  );

  testCRUD('📦 Subscriptions', 'subscriptions',
    "INSERT INTO subscriptions (company_id, service, vendor, cost, status) VALUES (?,?,?,?,?)", [1, 'AWS', 'Amazon', 500, 'active'],
    "UPDATE subscriptions SET cost = ? WHERE id = ?", [750],
    r => assert(r.cost === 500, 'subscriptions — cost matches'),
    r => assert(r.cost === 750, 'subscriptions — cost updated')
  );

  testCRUD('💾 Assets', 'assets',
    "INSERT INTO assets (company_id, name, type, serial_number, status) VALUES (?,?,?,?,?)", [1, 'Router', 'network', 'RT-001', 'in-use'],
    "UPDATE assets SET status = ? WHERE id = ?", ['retired'],
    null, r => assert(r.status === 'retired', 'assets — status updated')
  );

  testCRUD('📍 Inventory Locations', 'inventory_locations',
    "INSERT INTO inventory_locations (company_id, name, address) VALUES (?,?,?)", [1, 'Warehouse A', '123 Main St'],
    "UPDATE inventory_locations SET name = ? WHERE id = ?", ['Warehouse B'],
    null, r => assert(r.name === 'Warehouse B', 'inventory_locations — updated')
  );

  testCRUD('📦 Inventory', 'inventory',
    "INSERT INTO inventory (company_id, name, sku, quantity, unit_cost) VALUES (?,?,?,?,?)", [1, 'Cable Cat6', 'CAB-001', 100, 0.50],
    "UPDATE inventory SET quantity = ? WHERE id = ?", [150],
    r => assert(r.quantity === 100, 'inventory — qty matches'),
    r => assert(r.quantity === 150, 'inventory — qty updated')
  );
}

function testBilling() {
  console.log('\n═══════════════════════════════════════');
  console.log('💰 BILLING: Services, Invoices, Agreements');
  console.log('═══════════════════════════════════════');

  testCRUD('🛠️ Services', 'services',
    "INSERT INTO services (name, base_price, is_active) VALUES (?,?,?)", ['Cloud Hosting', 200, 1],
    "UPDATE services SET base_price = ? WHERE id = ?", [250],
    null, r => assert(r.base_price === 250, 'services — price updated')
  );

  testCRUD('📅 Service Schedule', 'service_schedule',
    "INSERT INTO service_schedule (service_id, company_id, scheduled_date, status) VALUES (?,?,?,?)", [1, 1, '2026-04-01', 'scheduled'],
    "UPDATE service_schedule SET status = ? WHERE id = ?", ['completed'],
    null, r => assert(r.status === 'completed', 'service_schedule — status updated')
  );

  testCRUD('📝 Agreements', 'agreements',
    "INSERT INTO agreements (company_id, service_id, title, value, status) VALUES (?,?,?,?,?)", [1, 1, 'MSA', 5000, 'active'],
    "UPDATE agreements SET value = ? WHERE id = ?", [6000],
    r => assert(r.title === 'MSA', 'agreements — title matches'),
    r => assert(r.value === 6000, 'agreements — value updated')
  );

  testCRUD('🔌 RDP Connections', 'rdp_connections',
    "INSERT INTO rdp_connections (company_id, name, hostname, port) VALUES (?,?,?,?)", [1, 'DC01', '10.0.0.5', 3389],
    "UPDATE rdp_connections SET hostname = ? WHERE id = ?", ['10.0.0.6'],
    null, r => assert(r.hostname === '10.0.0.6', 'rdp_connections — updated')
  );

  testCRUD('🧾 Invoices', 'invoices',
    "INSERT INTO invoices (company_id, invoice_number, total, status) VALUES (?,?,?,?)", [1, 'INV-TEST-001', 1500, 'draft'],
    "UPDATE invoices SET status = ? WHERE id = ?", ['sent'],
    r => assert(r.total === 1500, 'invoices — total matches'),
    r => assert(r.status === 'sent', 'invoices — status updated')
  );

  // Invoice items need a valid invoice
  const inv = db.prepare("INSERT INTO invoices (company_id, invoice_number, total) VALUES (1, 'INV-X', 100)").run();
  testCRUD('📄 Invoice Items', 'invoice_items',
    "INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total) VALUES (?,?,?,?,?)", [inv.lastInsertRowid, 'Support', 2, 50, 100],
    "UPDATE invoice_items SET quantity = ? WHERE id = ?", [3],
    null, r => assert(r.quantity === 3, 'invoice_items — qty updated')
  );
}

function testProjectsTasks() {
  console.log('\n═══════════════════════════════════════');
  console.log('📋 PROJECTS & TASKS');
  console.log('═══════════════════════════════════════');

  testCRUD('📁 Projects', 'projects',
    "INSERT INTO projects (name, company_id, status, budget) VALUES (?,?,?,?)", ['Website Redesign', 1, 'planning', 10000],
    "UPDATE projects SET status = ? WHERE id = ?", ['in-progress'],
    r => assert(r.budget === 10000, 'projects — budget matches'),
    r => assert(r.status === 'in-progress', 'projects — status updated')
  );

  testCRUD('🏷️ Project Statuses', 'project_statuses',
    "INSERT INTO project_statuses (name, color, sort_order) VALUES (?,?,?)", ['Backlog', '#gray', 0],
    "UPDATE project_statuses SET color = ? WHERE id = ?", ['#blue'],
    null, r => assert(r.color === '#blue', 'project_statuses — updated')
  );

  testCRUD('✅ Tasks', 'tasks',
    "INSERT INTO tasks (title, company_id, priority, status, assigned_to, created_by) VALUES (?,?,?,?,?,?)", ['Fix bug', 1, 'high', 'todo', 'admin', 'admin'],
    "UPDATE tasks SET status = ? WHERE id = ?", ['done'],
    r => assert(r.priority === 'high', 'tasks — priority matches'),
    r => assert(r.status === 'done', 'tasks — status updated')
  );
}

function testMonitoring() {
  console.log('\n═══════════════════════════════════════');
  console.log('📡 MONITORING');
  console.log('═══════════════════════════════════════');

  testCRUD('📡 Monitors', 'equipment_monitors',
    "INSERT INTO equipment_monitors (company_id, name, target, check_type, is_active) VALUES (?,?,?,?,?)", [1, 'Google DNS', '8.8.8.8', 'http', 1],
    "UPDATE equipment_monitors SET last_status = ? WHERE id = ?", ['up'],
    null, r => assert(r.last_status === 'up', 'monitors — status updated')
  );

  const mon = db.prepare("INSERT INTO equipment_monitors (company_id, name, target) VALUES (1,'tmp','1.1.1.1')").run();
  testCRUD('📊 Monitor Logs', 'monitor_logs',
    "INSERT INTO monitor_logs (monitor_id, status, response_ms) VALUES (?,?,?)", [mon.lastInsertRowid, 'up', 42],
    null, null, r => assert(r.response_ms === 42, 'monitor_logs — ms matches')
  );

  testCRUD('🔔 Alerts', 'alerts',
    "INSERT INTO alerts (monitor_id, source, severity, title, status) VALUES (?,?,?,?,?)", [mon.lastInsertRowid, 'monitor', 'critical', 'Down!', 'open'],
    "UPDATE alerts SET status = ? WHERE id = ?", ['resolved'],
    null, r => assert(r.status === 'resolved', 'alerts — status updated')
  );
}

function testSOPsPolicies() {
  console.log('\n═══════════════════════════════════════');
  console.log('📚 SOPs, POLICIES, PASSWORDS');
  console.log('═══════════════════════════════════════');

  testCRUD('📚 SOPs', 'sops',
    "INSERT INTO sops (company_id, title, category, status) VALUES (?,?,?,?)", [1, 'Onboarding SOP', 'HR', 'published'],
    "UPDATE sops SET title = ? WHERE id = ?", ['Updated SOP'],
    r => assert(r.status === 'published', 'sops — status matches'),
    r => assert(r.title === 'Updated SOP', 'sops — title updated')
  );

  const sop = db.prepare("INSERT INTO sops (company_id, title) VALUES (1, 'tmp')").run();
  testCRUD('📄 SOP Sections', 'sop_sections',
    "INSERT INTO sop_sections (sop_id, title, sort_order) VALUES (?,?,?)", [sop.lastInsertRowid, 'Section 1', 0],
    "UPDATE sop_sections SET title = ? WHERE id = ?", ['Intro'],
    null, r => assert(r.title === 'Intro', 'sop_sections — updated')
  );

  testCRUD('📝 SOP Steps', 'sop_steps',
    "INSERT INTO sop_steps (sop_id, content, sort_order) VALUES (?,?,?)", [sop.lastInsertRowid, 'Step 1 content', 0],
    "UPDATE sop_steps SET content = ? WHERE id = ?", ['Updated step'],
    null, r => assert(r.content === 'Updated step', 'sop_steps — updated')
  );

  testCRUD('✅ SOP Acks', 'sop_acknowledgments',
    "INSERT INTO sop_acknowledgments (sop_id, user_name, company_name) VALUES (?,?,?)", [sop.lastInsertRowid, 'John', 'Acme'],
    null, null, r => assert(r.user_name === 'John', 'sop_acks — name matches')
  );

  testCRUD('📎 SOP References', 'sop_references',
    "INSERT INTO sop_references (sop_id, title, url) VALUES (?,?,?)", [sop.lastInsertRowid, 'Guide', 'https://example.com'],
    null, null, r => assert(r.url === 'https://example.com', 'sop_references — url matches')
  );

  testCRUD('📖 SOP Revisions', 'sop_revisions',
    "INSERT INTO sop_revisions (sop_id, version, change_summary, revised_by) VALUES (?,?,?,?)", [sop.lastInsertRowid, 2, 'Added step', 'admin'],
    null, null, r => assert(r.version === 2, 'sop_revisions — version matches')
  );

  testCRUD('🛡️ Security Policies', 'security_policies',
    "INSERT INTO security_policies (company_id, title, category, status) VALUES (?,?,?,?)", [1, 'Password Policy', 'Security', 'published'],
    "UPDATE security_policies SET status = ? WHERE id = ?", ['archived'],
    null, r => assert(r.status === 'archived', 'policies — status updated')
  );

  const pol = db.prepare("INSERT INTO security_policies (company_id, title) VALUES (1, 'tmp')").run();
  testCRUD('✅ Policy Acks', 'policy_acknowledgments',
    "INSERT INTO policy_acknowledgments (policy_id, user_name, company_id) VALUES (?,?,?)", [pol.lastInsertRowid, 'Jane', 1],
    null, null, r => assert(r.user_name === 'Jane', 'policy_acks — name matches')
  );

  testCRUD('🔑 Password Vault', 'password_vault',
    "INSERT INTO password_vault (company_id, title, username, password, url) VALUES (?,?,?,?,?)", [1, 'AWS Console', 'admin', 'secret', 'https://aws.amazon.com'],
    "UPDATE password_vault SET password = ? WHERE id = ?", ['new_secret'],
    r => assert(r.title === 'AWS Console', 'vault — title matches'),
    r => assert(r.password === 'new_secret', 'vault — password updated')
  );
}

function testFlowsChat() {
  console.log('\n═══════════════════════════════════════');
  console.log('💬 FLOWS, CHAT, FILES, XP');
  console.log('═══════════════════════════════════════');

  testCRUD('🔀 Process Flows', 'process_flows',
    "INSERT INTO process_flows (company_id, title, status) VALUES (?,?,?)", [1, 'Onboarding Flow', 'active'],
    "UPDATE process_flows SET title = ? WHERE id = ?", ['Hiring Flow'],
    null, r => assert(r.title === 'Hiring Flow', 'flows — updated')
  );

  const flow = db.prepare("INSERT INTO process_flows (company_id, title) VALUES (1, 'tmp')").run();
  testCRUD('🔲 Flow Nodes', 'flow_nodes',
    "INSERT INTO flow_nodes (flow_id, type, label, x, y) VALUES (?,?,?,?,?)", [flow.lastInsertRowid, 'step', 'Start', 100, 200],
    "UPDATE flow_nodes SET label = ? WHERE id = ?", ['Begin'],
    null, r => assert(r.label === 'Begin', 'flow_nodes — updated')
  );

  testCRUD('💬 Chat Channels', 'chat_channels',
    "INSERT INTO chat_channels (name, company_id, type, created_by) VALUES (?,?,?,?)", ['general', 1, 'group', 'admin'],
    "UPDATE chat_channels SET name = ? WHERE id = ?", ['#general'],
    null, r => assert(r.name === '#general', 'channels — updated')
  );

  const ch = db.prepare("INSERT INTO chat_channels (name, company_id) VALUES ('tmp', 1)").run();
  testCRUD('👥 Chat Members', 'chat_members',
    "INSERT INTO chat_members (channel_id, user_id) VALUES (?,?)", [ch.lastInsertRowid, 1],
    null, null, r => assert(r.user_id === 1, 'chat_members — user matches')
  );

  testCRUD('💬 Chat Messages', 'chat_messages',
    "INSERT INTO chat_messages (channel_id, user_id, username, message) VALUES (?,?,?,?)", [ch.lastInsertRowid, 1, 'admin', 'Hello!'],
    null, null, r => assert(r.message === 'Hello!', 'messages — text matches')
  );

  testCRUD('📧 Email Providers', 'email_providers',
    "INSERT INTO email_providers (company_id, provider, domain, status) VALUES (?,?,?,?)", [1, 'google', 'acme.com', 'active'],
    "UPDATE email_providers SET status = ? WHERE id = ?", ['inactive'],
    null, r => assert(r.status === 'inactive', 'email_providers — updated')
  );

  testCRUD('🔑 Reset Tokens', 'password_reset_tokens',
    "INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?,?,?)", [1, 'abc123', '2026-12-31'],
    null, null, r => assert(r.token === 'abc123', 'reset_tokens — token matches')
  );

  testCRUD('📁 File Folders', 'file_folders',
    "INSERT INTO file_folders (company_id, name) VALUES (?,?)", [1, 'Documents'],
    "UPDATE file_folders SET name = ? WHERE id = ?", ['Docs'],
    null, r => assert(r.name === 'Docs', 'folders — updated')
  );

  const folder = db.prepare("INSERT INTO file_folders (company_id, name) VALUES (1, 'tmp')").run();
  testCRUD('🔒 Folder Access', 'folder_access',
    "INSERT INTO folder_access (folder_id, user_id, permission) VALUES (?,?,?)", [folder.lastInsertRowid, 1, 'write'],
    null, null, r => assert(r.permission === 'write', 'folder_access — permission matches')
  );

  testCRUD('📄 Company Files', 'company_files',
    "INSERT INTO company_files (company_id, folder_id, filename, original_name, size) VALUES (?,?,?,?,?)", [1, folder.lastInsertRowid, 'abc.pdf', 'report.pdf', 1024],
    null, null, r => assert(r.size === 1024, 'files — size matches')
  );

  testCRUD('⭐ XP', 'user_xp',
    "INSERT INTO user_xp (user_id, action, xp, description) VALUES (?,?,?,?)", [1, 'create_task', 5, 'Created a task'],
    null, null, r => assert(r.xp === 5, 'xp — points match')
  );
}

function testELD() {
  console.log('\n═══════════════════════════════════════');
  console.log('📡 ELD & FLEET');
  console.log('═══════════════════════════════════════');

  testCRUD('🔌 ELD Integrations', 'eld_integrations',
    "INSERT INTO eld_integrations (company_id, provider, status) VALUES (?,?,?)", [1, 'samsara', 'active'],
    "UPDATE eld_integrations SET status = ? WHERE id = ?", ['inactive'],
    null, r => assert(r.status === 'inactive', 'eld_integrations — updated')
  );

  testCRUD('🚚 ELD Vehicles', 'eld_vehicles',
    "INSERT INTO eld_vehicles (company_id, provider_vehicle_id, name, vin, asset_type) VALUES (?,?,?,?,?)", [1, 'SAM-001', 'Truck 1', '1HGCM82633A004352', 'vehicle'],
    "UPDATE eld_vehicles SET lat = ?, lng = ? WHERE id = ?", [40.7, -74.0],
    null, r => assert(r.lat === 40.7, 'eld_vehicles — location updated')
  );

  testCRUD('🏷️ Company Modules', 'company_modules',
    "INSERT INTO company_modules (company_id, tms, fleet, expenses) VALUES (?,?,?,?)", [2, 1, 1, 1],
    "UPDATE company_modules SET expenses = ? WHERE id = ?", [0],
    r => assert(r.expenses === 1, 'modules — expenses enabled'),
    r => assert(r.expenses === 0, 'modules — expenses disabled')
  );

  testCRUD('🚛 Fleet Vehicles', 'fleet_vehicles',
    "INSERT INTO fleet_vehicles (company_id, unit_number, vin, make, model, status) VALUES (?,?,?,?,?,?)", [1, 'T-100', '1HGCM82633A004352', 'Freightliner', 'Cascadia', 'active'],
    "UPDATE fleet_vehicles SET status = ? WHERE id = ?", ['out-of-service'],
    r => assert(r.unit_number === 'T-100', 'fleet_vehicles — unit matches'),
    r => assert(r.status === 'out-of-service', 'fleet_vehicles — status updated')
  );

  testCRUD('🚐 Fleet Trailers', 'fleet_trailers',
    "INSERT INTO fleet_trailers (company_id, unit_number, type, status) VALUES (?,?,?,?)", [1, 'TR-200', 'dry-van', 'active'],
    "UPDATE fleet_trailers SET type = ? WHERE id = ?", ['reefer'],
    null, r => assert(r.type === 'reefer', 'trailers — type updated')
  );
}

function testTMS() {
  console.log('\n═══════════════════════════════════════');
  console.log('🚛 TMS: Loads, Trips, Dispatch');
  console.log('═══════════════════════════════════════');

  testCRUD('📦 TMS Loads', 'tms_loads',
    "INSERT INTO tms_loads (company_id, load_number, status, customer, origin, destination, rate) VALUES (?,?,?,?,?,?,?)", [1, 'LD-001', 'available', 'Walmart', 'Chicago', 'Dallas', 3500],
    "UPDATE tms_loads SET status = ? WHERE id = ?", ['in-transit'],
    r => assert(r.rate === 3500, 'loads — rate matches'),
    r => assert(r.status === 'in-transit', 'loads — status updated')
  );

  const load = db.prepare("INSERT INTO tms_loads (company_id, load_number, rate) VALUES (1, 'LD-X', 1000)").run();
  testCRUD('📍 TMS Stops', 'tms_stops',
    "INSERT INTO tms_stops (load_id, type, location, sort_order) VALUES (?,?,?,?)", [load.lastInsertRowid, 'pickup', 'Chicago IL', 0],
    "UPDATE tms_stops SET location = ? WHERE id = ?", ['Chicago, IL 60601'],
    null, r => assert(r.location === 'Chicago, IL 60601', 'stops — updated')
  );

  testCRUD('📄 TMS Documents', 'tms_documents',
    "INSERT INTO tms_documents (load_id, type, filename, original_name) VALUES (?,?,?,?)", [load.lastInsertRowid, 'bol', 'abc.pdf', 'BOL.pdf'],
    null, null, r => assert(r.type === 'bol', 'tms_documents — type matches')
  );

  testCRUD('📊 TMS Status Log', 'tms_status_log',
    "INSERT INTO tms_status_log (load_id, old_status, new_status, changed_by) VALUES (?,?,?,?)", [load.lastInsertRowid, 'available', 'dispatched', 'admin'],
    null, null, r => assert(r.new_status === 'dispatched', 'status_log — matches')
  );

  testCRUD('🗺️ TMS Trips', 'tms_trips',
    "INSERT INTO tms_trips (company_id, trip_number, driver_id, status, total_miles, total_revenue) VALUES (?,?,?,?,?,?)", [1, 'TR-001', 1, 'planned', 1200, 4500],
    "UPDATE tms_trips SET status = ? WHERE id = ?", ['completed'],
    r => assert(r.total_revenue === 4500, 'trips — revenue matches'),
    r => assert(r.status === 'completed', 'trips — status updated')
  );

  testCRUD('💵 TMS Driver Pay', 'tms_driver_pay',
    "INSERT INTO tms_driver_pay (company_id, driver_id, pay_type, amount, status) VALUES (?,?,?,?,?)", [1, 1, 'per-mile', 720, 'pending'],
    "UPDATE tms_driver_pay SET status = ? WHERE id = ?", ['paid'],
    r => assert(r.amount === 720, 'driver_pay — amount matches'),
    r => assert(r.status === 'paid', 'driver_pay — status updated')
  );

  testCRUD('📞 TMS Dispatchers', 'tms_dispatchers',
    "INSERT INTO tms_dispatchers (company_id, user_id, name, is_active) VALUES (?,?,?,?)", [1, 2, 'Jane Office', 1],
    "UPDATE tms_dispatchers SET is_active = ? WHERE id = ?", [0],
    null, r => assert(r.is_active === 0, 'dispatchers — deactivated')
  );
}

function testFuel() {
  console.log('\n═══════════════════════════════════════');
  console.log('⛽ FUEL INCENTIVE');
  console.log('═══════════════════════════════════════');

  testCRUD('⚙️ Fuel Config', 'fuel_config',
    "INSERT INTO fuel_config (company_id, enabled, billing_mode, split_driver_pct) VALUES (?,?,?,?)", [1, 1, 'per-gallon', 60],
    "UPDATE fuel_config SET split_driver_pct = ? WHERE id = ?", [55],
    r => assert(r.split_driver_pct === 60, 'fuel_config — split matches'),
    r => assert(r.split_driver_pct === 55, 'fuel_config — split updated')
  );

  testCRUD('📂 Fuel Groups', 'fuel_groups',
    "INSERT INTO fuel_groups (company_id, name, baseline_mpg) VALUES (?,?,?)", [1, 'Sleepers', 6.5],
    "UPDATE fuel_groups SET baseline_mpg = ? WHERE id = ?", [6.8],
    null, r => assert(r.baseline_mpg === 6.8, 'fuel_groups — mpg updated')
  );

  const fg = db.prepare("INSERT INTO fuel_groups (company_id, name) VALUES (1, 'tmp')").run();
  const fv = db.prepare("INSERT INTO fleet_vehicles (company_id, unit_number) VALUES (1, 'FV-1')").run();

  testCRUD('🔗 Truck-Group Map', 'fuel_truck_group_map',
    "INSERT INTO fuel_truck_group_map (company_id, vehicle_id, group_id) VALUES (?,?,?)", [1, fv.lastInsertRowid, fg.lastInsertRowid],
    null, null, r => assert(r.company_id === 1, 'truck_group_map — company matches')
  );

  testCRUD('🔗 Driver-Group Map', 'fuel_driver_group_map',
    "INSERT INTO fuel_driver_group_map (company_id, driver_id, group_id) VALUES (?,?,?)", [1, 1, fg.lastInsertRowid],
    null, null, r => assert(r.driver_id === 1, 'driver_group_map — driver matches')
  );

  testCRUD('📈 Fuel Baselines', 'fuel_driver_baselines',
    "INSERT INTO fuel_driver_baselines (company_id, driver_id, baseline_mpg, created_by) VALUES (?,?,?,?)", [1, 1, 6.2, 'admin'],
    null, null, r => assert(r.baseline_mpg === 6.2, 'baselines — mpg matches')
  );

  testCRUD('📸 Baseline Snapshots', 'fuel_baseline_snapshots',
    "INSERT INTO fuel_baseline_snapshots (company_id, group_id, scope, baseline_mpg, method, is_current) VALUES (?,?,?,?,?,?)", [1, fg.lastInsertRowid, 'group', 6.5, 'miles_over_gallons', 1],
    null, null, r => assert(r.method === 'miles_over_gallons', 'snapshots — method matches')
  );

  testCRUD('📊 Daily Measurements', 'fuel_measurements_daily',
    "INSERT INTO fuel_measurements_daily (company_id, vehicle_id, date, miles, gallons, mpg) VALUES (?,?,?,?,?,?)", [1, fv.lastInsertRowid, '2026-03-20', 400, 60, 6.67],
    null, null, r => assert(r.miles === 400, 'measurements — miles matches')
  );

  testCRUD('📆 Payout Periods', 'fuel_payout_periods',
    "INSERT INTO fuel_payout_periods (company_id, period_start, period_end, status) VALUES (?,?,?,?)", [1, '2026-03-01', '2026-03-15', 'draft'],
    "UPDATE fuel_payout_periods SET status = ? WHERE id = ?", ['approved'],
    null, r => assert(r.status === 'approved', 'periods — status updated')
  );

  const period = db.prepare("INSERT INTO fuel_payout_periods (company_id, period_start, period_end) VALUES (1, '2026-01-01', '2026-01-15')").run();
  testCRUD('💰 Payout Ledgers', 'fuel_payout_ledgers',
    "INSERT INTO fuel_payout_ledgers (period_id, company_id, driver_id, driver_name, baseline_mpg, actual_mpg, total_miles, total_gallons, gross_savings, driver_share, company_share) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [period.lastInsertRowid, 1, 1, 'John Driver', 6.0, 6.5, 5000, 770, 200, 120, 80],
    null, null, r => assert(r.driver_share === 120, 'ledgers — driver_share matches')
  );

  testCRUD('🎯 Target Policies', 'fuel_target_policies',
    "INSERT INTO fuel_target_policies (company_id, group_id, target_mpg, is_active) VALUES (?,?,?,?)", [1, fg.lastInsertRowid, 6.8, 1],
    "UPDATE fuel_target_policies SET is_active = ? WHERE id = ?", [0],
    null, r => assert(r.is_active === 0, 'target_policies — deactivated')
  );

  testCRUD('🎯 Target Overrides', 'fuel_target_overrides',
    "INSERT INTO fuel_target_overrides (company_id, driver_id, target_mpg, reason, is_active) VALUES (?,?,?,?,?)", [1, 1, 7.0, 'New truck', 1],
    "UPDATE fuel_target_overrides SET is_active = ? WHERE id = ?", [0],
    null, r => assert(r.is_active === 0, 'target_overrides — deactivated')
  );

  testCRUD('🔌 Fuel Integrations', 'fuel_integrations',
    "INSERT INTO fuel_integrations (company_id, provider, status, is_active) VALUES (?,?,?,?)", [1, 'samsara', 'active', 1],
    "UPDATE fuel_integrations SET sync_count = ? WHERE id = ?", [5],
    null, r => assert(r.sync_count === 5, 'fuel_integrations — sync updated')
  );

  const fi = db.prepare("INSERT INTO fuel_integrations (company_id, provider) VALUES (1, 'motive')").run();
  testCRUD('🗺️ Provider Asset Map', 'fuel_provider_asset_map',
    "INSERT INTO fuel_provider_asset_map (company_id, integration_id, provider_asset_id, provider_asset_name) VALUES (?,?,?,?)", [1, fi.lastInsertRowid, 'MOT-001', 'Truck Alpha'],
    "UPDATE fuel_provider_asset_map SET is_mapped = ? WHERE id = ?", [1],
    null, r => assert(r.is_mapped === 1, 'asset_map — mapped')
  );

  testCRUD('📝 Fuel Audit Log', 'fuel_audit_log',
    "INSERT INTO fuel_audit_log (company_id, action, details, created_by) VALUES (?,?,?,?)", [1, 'config_update', 'Changed split', 'admin'],
    null, null, r => assert(r.action === 'config_update', 'fuel_audit — action matches')
  );

  testCRUD('📈 Ceiling Log', 'fuel_ceiling_log',
    "INSERT INTO fuel_ceiling_log (company_id, group_id, exceeded_mpg, consecutive_periods) VALUES (?,?,?,?)", [1, fg.lastInsertRowid, 0.4, 3],
    null, null, r => assert(r.consecutive_periods === 3, 'ceiling_log — periods match')
  );

  testCRUD('🔍 VIN Cache', 'fuel_vin_cache',
    "INSERT INTO fuel_vin_cache (vin, year, make, model) VALUES (?,?,?,?)", ['1HGCM82633A004352', 2020, 'Freightliner', 'Cascadia'],
    null, null, r => assert(r.make === 'Freightliner', 'vin_cache — make matches')
  );
}

function testExpenses() {
  console.log('\n═══════════════════════════════════════');
  console.log('💳 EXPENSES');
  console.log('═══════════════════════════════════════');

  testCRUD('🏢 Cost Centers', 'expense_cost_centers',
    "INSERT INTO expense_cost_centers (company_id, code, name) VALUES (?,?,?)", [1, 'CC-100', 'Dispatch'],
    "UPDATE expense_cost_centers SET name = ? WHERE id = ?", ['Fleet Dispatch'],
    r => assert(r.code === 'CC-100', 'cost_centers — code matches'),
    r => assert(r.name === 'Fleet Dispatch', 'cost_centers — name updated')
  );

  testCRUD('🏷️ Categories', 'expense_categories',
    "INSERT INTO expense_categories (company_id, name, icon) VALUES (?,?,?)", [1, 'Fuel', 'ti-gas-station'],
    "UPDATE expense_categories SET is_active = ? WHERE id = ?", [0],
    r => assert(r.name === 'Fuel', 'categories — name matches'),
    r => assert(r.is_active === 0, 'categories — deactivated')
  );

  testCRUD('🏪 Vendors', 'expense_vendors',
    "INSERT INTO expense_vendors (company_id, name, email, tax_id) VALUES (?,?,?,?)", [1, 'Shell Oil', 'shell@corp.com', '12-3456789'],
    "UPDATE expense_vendors SET is_active = ? WHERE id = ?", [0],
    r => assert(r.tax_id === '12-3456789', 'vendors — tax_id matches'),
    r => assert(r.is_active === 0, 'vendors — deactivated')
  );

  // Need category and cost center for transactions
  const cat = db.prepare("INSERT INTO expense_categories (company_id, name) VALUES (1, 'Office')").run();
  const cc = db.prepare("INSERT INTO expense_cost_centers (company_id, code, name) VALUES (1, 'CC-ADM', 'Admin')").run();

  testCRUD('💳 Transactions', 'expense_transactions',
    "INSERT INTO expense_transactions (company_id, date, amount, description, category_id, category_name, cost_center_id, cost_center_code, source, status, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [1, '2026-03-20', 250.00, 'Office supplies', cat.lastInsertRowid, 'Office', cc.lastInsertRowid, 'CC-ADM', 'manual', 'pending', 'admin'],
    "UPDATE expense_transactions SET status = ?, approved_by = ? WHERE id = ?", ['approved', 'admin'],
    r => { assert(r.amount === 250, 'transactions — amount matches'); assert(r.source === 'manual', 'transactions — source=manual'); },
    r => { assert(r.status === 'approved', 'transactions — approved'); assert(r.approved_by === 'admin', 'transactions — approved_by set'); }
  );

  testCRUD('📥 Import Batches', 'expense_import_batches',
    "INSERT INTO expense_import_batches (company_id, filename, source, status, total_rows, imported_rows) VALUES (?,?,?,?,?,?)", [1, 'expenses.csv', 'csv', 'completed', 50, 48],
    "UPDATE expense_import_batches SET status = ? WHERE id = ?", ['rolled_back'],
    r => assert(r.imported_rows === 48, 'batches — imported matches'),
    r => assert(r.status === 'rolled_back', 'batches — rolled back')
  );

  testCRUD('📝 Expense Audit Log', 'expense_audit_log',
    "INSERT INTO expense_audit_log (company_id, entity_type, entity_id, action, field_changes, performed_by) VALUES (?,?,?,?,?,?)", [1, 'transaction', 1, 'create', '{"amount":"250"}', 'admin'],
    null, null, r => { assert(r.entity_type === 'transaction', 'audit — type matches'); assert(r.performed_by === 'admin', 'audit — performer matches'); }
  );

  // Uniqueness tests
  console.log('\n  🔒 Uniqueness constraints:');
  db.prepare("INSERT INTO expense_cost_centers (company_id, code, name) VALUES (1, 'UNQ-1', 'Test')").run();
  try {
    db.prepare("INSERT INTO expense_cost_centers (company_id, code, name) VALUES (1, 'UNQ-1', 'Duplicate')").run();
    assert(false, 'cost_centers — UNIQUE(company_id, code) should reject duplicate');
  } catch(e) {
    assert(e.message.includes('UNIQUE'), 'cost_centers — UNIQUE constraint enforced');
  }

  db.prepare("INSERT INTO expense_categories (company_id, name) VALUES (1, 'UniqueTest')").run();
  try {
    db.prepare("INSERT INTO expense_categories (company_id, name) VALUES (1, 'UniqueTest')").run();
    assert(false, 'categories — UNIQUE(company_id, name) should reject duplicate');
  } catch(e) {
    assert(e.message.includes('UNIQUE'), 'categories — UNIQUE constraint enforced');
  }

  // Cross-company: same code in different company should work
  db.prepare("INSERT INTO expense_cost_centers (company_id, code, name) VALUES (2, 'UNQ-1', 'Same code other co')").run();
  assert(true, 'cost_centers — same code allowed in different company');
}

function testPayroll() {
  console.log('\n═══════════════════════════════════════');
  console.log('💰 PAYROLL / SALARY');
  console.log('═══════════════════════════════════════');

  testCRUD('👤 Salary Profiles', 'salary_profiles',
    "INSERT INTO salary_profiles (company_id, employee_id, employee_name, pay_frequency, amount, is_active, created_by) VALUES (?,?,?,?,?,?,?)", [1, 1, 'John Driver', 'monthly', 5000, 1, 'admin'],
    "UPDATE salary_profiles SET amount = ? WHERE id = ?", [5500],
    r => { assert(r.amount === 5000, 'profiles — amount matches'); assert(r.pay_frequency === 'monthly', 'profiles — frequency matches'); },
    r => assert(r.amount === 5500, 'profiles — amount updated')
  );

  testCRUD('📅 Salary Runs', 'salary_runs',
    "INSERT INTO salary_runs (company_id, period_start, period_end, pay_date, status, total_amount, line_count, created_by) VALUES (?,?,?,?,?,?,?,?)", [1, '2026-03-01', '2026-03-31', '2026-03-31', 'draft', 10000, 2, 'admin'],
    "UPDATE salary_runs SET status = ?, approved_by = ? WHERE id = ?", ['approved', 'admin'],
    r => { assert(r.status === 'draft', 'runs — starts draft'); assert(r.total_amount === 10000, 'runs — amount matches'); },
    r => { assert(r.status === 'approved', 'runs — approved'); assert(r.approved_by === 'admin', 'runs — approved_by set'); }
  );

  const run = db.prepare("INSERT INTO salary_runs (company_id, period_start, period_end, pay_date, status) VALUES (1, '2026-02-01', '2026-02-28', '2026-02-28', 'draft')").run();
  const prof = db.prepare("INSERT INTO salary_profiles (company_id, employee_id, employee_name, amount) VALUES (1, 2, 'Jane Office', 4000)").run();
  testCRUD('📋 Salary Run Lines', 'salary_run_lines',
    "INSERT INTO salary_run_lines (run_id, company_id, profile_id, employee_id, employee_name, amount, description) VALUES (?,?,?,?,?,?,?)",
    [run.lastInsertRowid, 1, prof.lastInsertRowid, 2, 'Jane Office', 4000, 'Salary Feb 2026'],
    null, null,
    r => { assert(r.amount === 4000, 'run_lines — amount matches'); assert(r.employee_name === 'Jane Office', 'run_lines — name matches'); }
  );

  // Test salary profile uniqueness
  console.log('\n  🔒 Salary uniqueness:');
  db.prepare("INSERT INTO salary_profiles (company_id, employee_id, employee_name, amount) VALUES (1, 3, 'Unique Emp', 3000)").run();
  try {
    db.prepare("INSERT INTO salary_profiles (company_id, employee_id, employee_name, amount) VALUES (1, 3, 'Dup Emp', 4000)").run();
    assert(false, 'profiles — UNIQUE(company_id, employee_id) should reject');
  } catch(e) {
    assert(e.message.includes('UNIQUE'), 'profiles — UNIQUE constraint enforced');
  }

  // Salary run lifecycle: draft → approved → posted
  console.log('\n  🔄 Salary run lifecycle:');
  const lifecycle = db.prepare("INSERT INTO salary_runs (company_id, period_start, period_end, pay_date, status) VALUES (1, '2026-04-01', '2026-04-30', '2026-04-30', 'draft')").run();
  let lr = db.prepare('SELECT status FROM salary_runs WHERE id = ?').get(lifecycle.lastInsertRowid);
  assert(lr.status === 'draft', 'lifecycle — starts as draft');
  db.prepare("UPDATE salary_runs SET status = 'approved', approved_by = 'admin' WHERE id = ?").run(lifecycle.lastInsertRowid);
  lr = db.prepare('SELECT status FROM salary_runs WHERE id = ?').get(lifecycle.lastInsertRowid);
  assert(lr.status === 'approved', 'lifecycle — approved');
  db.prepare("UPDATE salary_runs SET status = 'posted', posted_by = 'admin' WHERE id = ?").run(lifecycle.lastInsertRowid);
  lr = db.prepare('SELECT status FROM salary_runs WHERE id = ?').get(lifecycle.lastInsertRowid);
  assert(lr.status === 'posted', 'lifecycle — posted');
}

function testCompanyIsolation() {
  console.log('\n═══════════════════════════════════════');
  console.log('🔒 COMPANY ISOLATION');
  console.log('═══════════════════════════════════════');

  // Company 1 data should not appear in company 2 queries
  db.prepare("INSERT INTO expense_transactions (company_id, date, amount, description, source, status, created_by) VALUES (1, '2026-03-01', 500, 'Co1 expense', 'manual', 'pending', 'admin')").run();
  db.prepare("INSERT INTO expense_transactions (company_id, date, amount, description, source, status, created_by) VALUES (2, '2026-03-01', 300, 'Co2 expense', 'manual', 'pending', 'admin')").run();

  const co1 = db.prepare('SELECT SUM(amount) as total FROM expense_transactions WHERE company_id = 1').get();
  const co2 = db.prepare('SELECT SUM(amount) as total FROM expense_transactions WHERE company_id = 2').get();
  assert(co1.total !== co2.total, 'isolation — companies have different totals');

  const co1rows = db.prepare('SELECT * FROM expense_transactions WHERE company_id = 1').all();
  const co2rows = db.prepare('SELECT * FROM expense_transactions WHERE company_id = 2').all();
  assert(co1rows.every(r => r.company_id === 1), 'isolation — co1 query only returns co1 data');
  assert(co2rows.every(r => r.company_id === 2), 'isolation — co2 query only returns co2 data');

  // Tasks isolation
  db.prepare("INSERT INTO tasks (title, company_id, status, created_by) VALUES ('Co1 task', 1, 'todo', 'admin')").run();
  db.prepare("INSERT INTO tasks (title, company_id, status, created_by) VALUES ('Co2 task', 2, 'todo', 'admin')").run();
  const t1 = db.prepare('SELECT * FROM tasks WHERE company_id = 1').all();
  const t2 = db.prepare('SELECT * FROM tasks WHERE company_id = 2').all();
  assert(t1.every(r => r.company_id === 1), 'isolation — tasks scoped to co1');
  assert(t2.every(r => r.company_id === 2), 'isolation — tasks scoped to co2');

  // Salary profiles isolation
  db.prepare("INSERT INTO salary_profiles (company_id, employee_id, employee_name, amount) VALUES (2, 3, 'Beta Emp', 3500)").run();
  const sp1 = db.prepare('SELECT * FROM salary_profiles WHERE company_id = 1').all();
  const sp2 = db.prepare('SELECT * FROM salary_profiles WHERE company_id = 2').all();
  assert(sp1.every(r => r.company_id === 1), 'isolation — salary profiles scoped to co1');
  assert(sp2.every(r => r.company_id === 2), 'isolation — salary profiles scoped to co2');
}

// ================================================================
//  RUN ALL TESTS
// ================================================================

console.log('🧪 IT Forge — Comprehensive CRUD Test Suite');
console.log('============================================\n');
console.log('Setting up in-memory database...');

setup();
seed();

testCoreModule();
testCompanyAssets();
testBilling();
testProjectsTasks();
testMonitoring();
testSOPsPolicies();
testFlowsChat();
testELD();
testTMS();
testFuel();
testExpenses();
testPayroll();
testCompanyIsolation();

// Summary
console.log('\n════════════════════════════════════════');
console.log('📊 RESULTS');
console.log('════════════════════════════════════════');
console.log('  ✅ Passed: ' + passed);
console.log('  ❌ Failed: ' + failed);
if (skipped > 0) console.log('  ⏭️  Skipped: ' + skipped);
console.log('  📋 Total:  ' + (passed + failed));
console.log('  📊 Tables tested: 80+');
console.log('════════════════════════════════════════');

if (failed > 0) {
  console.log('\n❌ SOME TESTS FAILED\n');
  process.exit(1);
} else {
  console.log('\n✅ ALL TESTS PASSED\n');
  process.exit(0);
}
