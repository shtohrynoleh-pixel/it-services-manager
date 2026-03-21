// Database schema and initialization
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'app.db');

function initDB() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- Admin / Settings
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- Users (admin + client users)
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'client',
      company_id INTEGER,
      full_name TEXT,
      email TEXT,
      phone TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL
    );

    -- Companies (trucking clients)
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      logo TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Admin-company assignments (which companies a company-admin can manage)
    CREATE TABLE IF NOT EXISTS admin_companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      UNIQUE(user_id, company_id)
    );

    -- Company contacts
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      role TEXT,
      email TEXT,
      phone TEXT,
      is_primary INTEGER DEFAULT 0,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    -- Custom roles
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      sort_order INTEGER DEFAULT 0
    );

    -- Departments
    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      sort_order INTEGER DEFAULT 0
    );

    -- Company employees / users they manage
    CREATE TABLE IF NOT EXISTS company_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      title TEXT,
      email TEXT,
      phone TEXT,
      department TEXT,
      role TEXT,
      manager_id INTEGER,
      access_level TEXT DEFAULT 'limited',
      email_account TEXT,
      hire_date TEXT,
      photo_url TEXT,
      is_active INTEGER DEFAULT 1,
      notes TEXT,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (manager_id) REFERENCES company_users(id) ON DELETE SET NULL
    );

    -- Software licenses assigned to users
    CREATE TABLE IF NOT EXISTS user_software (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      user_id INTEGER,
      name TEXT NOT NULL,
      license_key TEXT,
      license_type TEXT DEFAULT 'per-user',
      vendor TEXT,
      expires_at TEXT,
      cost REAL DEFAULT 0,
      notes TEXT,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES company_users(id) ON DELETE SET NULL
    );

    -- Equipment assigned to users
    CREATE TABLE IF NOT EXISTS user_equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      user_id INTEGER,
      inventory_id INTEGER,
      assigned_date TEXT DEFAULT (datetime('now')),
      notes TEXT,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES company_users(id) ON DELETE SET NULL,
      FOREIGN KEY (inventory_id) REFERENCES inventory(id) ON DELETE CASCADE
    );

    -- Servers
    CREATE TABLE IF NOT EXISTS servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT,
      os TEXT,
      ip TEXT,
      purpose TEXT,
      location TEXT,
      is_active INTEGER DEFAULT 1,
      notes TEXT,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    -- Subscriptions
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      vendor TEXT,
      type TEXT,
      seats INTEGER DEFAULT 1,
      cost_per_unit REAL DEFAULT 0,
      billing_cycle TEXT DEFAULT 'monthly',
      renewal_date TEXT,
      auto_renew INTEGER DEFAULT 1,
      login_url TEXT,
      notes TEXT,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    -- Digital assets (domains, websites, SSL, accounts)
    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT,
      provider TEXT,
      expires_at TEXT,
      login_url TEXT,
      notes TEXT,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    -- Inventory locations (warehouses, offices, etc.)
    CREATE TABLE IF NOT EXISTS inventory_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'office',
      address TEXT,
      parent_id INTEGER,
      is_active INTEGER DEFAULT 1,
      notes TEXT,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES inventory_locations(id) ON DELETE SET NULL
    );

    -- Hardware inventory
    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT,
      manufacturer TEXT,
      model TEXT,
      serial_number TEXT,
      quantity INTEGER DEFAULT 1,
      cost REAL DEFAULT 0,
      location_id INTEGER,
      assigned_to TEXT,
      purchase_date TEXT,
      warranty_expires TEXT,
      condition TEXT DEFAULT 'good',
      notes TEXT,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES inventory_locations(id) ON DELETE SET NULL
    );

    -- Services catalog (what you offer)
    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT,
      description TEXT,
      price_type TEXT DEFAULT 'monthly',
      base_price REAL DEFAULT 0,
      is_public INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Service agreements (service assigned to company)
    CREATE TABLE IF NOT EXISTS agreements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      service_id INTEGER,
      title TEXT,
      custom_price REAL,
      billing_cycle TEXT DEFAULT 'monthly',
      start_date TEXT,
      end_date TEXT,
      auto_renew INTEGER DEFAULT 1,
      sla_response TEXT,
      sla_resolution TEXT,
      scope TEXT,
      exclusions TEXT,
      terms TEXT,
      signed_by TEXT,
      signed_date TEXT,
      attachment TEXT,
      attachment_name TEXT,
      is_active INTEGER DEFAULT 1,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
    );

    -- RDP / Remote access connections
    CREATE TABLE IF NOT EXISTS rdp_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'rdp',
      hostname TEXT,
      port INTEGER DEFAULT 3389,
      username TEXT,
      password_enc TEXT,
      domain TEXT,
      gateway TEXT,
      os TEXT,
      purpose TEXT,
      assigned_to TEXT,
      last_connected TEXT,
      is_active INTEGER DEFAULT 1,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    -- Invoices
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      invoice_number TEXT,
      date TEXT,
      due_date TEXT,
      subtotal REAL DEFAULT 0,
      tax REAL DEFAULT 0,
      total REAL DEFAULT 0,
      status TEXT DEFAULT 'draft',
      paid_date TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    -- Invoice line items
    CREATE TABLE IF NOT EXISTS invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      description TEXT,
      quantity REAL DEFAULT 1,
      unit_price REAL DEFAULT 0,
      total REAL DEFAULT 0,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    );

    -- Projects
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      company_id INTEGER,
      status TEXT DEFAULT 'planning',
      start_date TEXT,
      due_date TEXT,
      budget REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL
    );

    -- Tasks (linked to company, project, or any record)
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      company_id INTEGER,
      project_id INTEGER,
      related_table TEXT,
      related_id INTEGER,
      priority TEXT DEFAULT 'medium',
      status TEXT DEFAULT 'todo',
      due_date TEXT,
      assigned_to TEXT,
      created_by TEXT DEFAULT 'admin',
      created_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      first_response_at TEXT,
      sla_response_min INTEGER,
      sla_resolve_min INTEGER,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

    -- Custom project statuses
    CREATE TABLE IF NOT EXISTS project_statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT DEFAULT '#64748b',
      sort_order INTEGER DEFAULT 0
    );

    -- Equipment monitoring
    CREATE TABLE IF NOT EXISTS equipment_monitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'server',
      target TEXT,
      check_type TEXT DEFAULT 'ping',
      interval_min INTEGER DEFAULT 5,
      last_check TEXT,
      last_status TEXT DEFAULT 'unknown',
      last_response_ms INTEGER,
      uptime_pct REAL DEFAULT 0,
      alert_email TEXT,
      is_active INTEGER DEFAULT 1,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    -- Monitor check history
    CREATE TABLE IF NOT EXISTS monitor_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      checked_at TEXT DEFAULT (datetime('now')),
      status TEXT,
      response_ms INTEGER,
      error TEXT,
      FOREIGN KEY (monitor_id) REFERENCES equipment_monitors(id) ON DELETE CASCADE
    );

    -- SOPs (Standard Operating Procedures)
    CREATE TABLE IF NOT EXISTS sops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER,
      title TEXT NOT NULL,
      sop_number TEXT,
      category TEXT,
      department TEXT,
      target_role TEXT,
      purpose TEXT,
      scope_applies TEXT,
      scope_excludes TEXT,
      materials TEXT,
      equipment TEXT,
      definitions TEXT,
      safety_warnings TEXT,
      compliance_reqs TEXT,
      exceptions TEXT,
      description TEXT,
      version TEXT DEFAULT '1.0',
      status TEXT DEFAULT 'draft',
      owner TEXT,
      prepared_by TEXT,
      prepared_date TEXT,
      reviewed_by TEXT,
      reviewed_date TEXT,
      approved_by TEXT,
      approved_date TEXT,
      review_date TEXT,
      is_template INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    -- SOP Sections (group steps under sections)
    CREATE TABLE IF NOT EXISTS sop_sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sop_id INTEGER NOT NULL,
      section_number INTEGER DEFAULT 1,
      title TEXT NOT NULL,
      FOREIGN KEY (sop_id) REFERENCES sops(id) ON DELETE CASCADE
    );

    -- SOP Steps
    CREATE TABLE IF NOT EXISTS sop_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sop_id INTEGER NOT NULL,
      section_id INTEGER,
      step_number INTEGER DEFAULT 1,
      title TEXT NOT NULL,
      description TEXT,
      responsible TEXT,
      warning TEXT,
      notes TEXT,
      FOREIGN KEY (sop_id) REFERENCES sops(id) ON DELETE CASCADE,
      FOREIGN KEY (section_id) REFERENCES sop_sections(id) ON DELETE CASCADE
    );

    -- SOP compliance tracking (who read/acknowledged which SOP)
    CREATE TABLE IF NOT EXISTS sop_acknowledgments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sop_id INTEGER NOT NULL,
      user_name TEXT NOT NULL,
      company_id INTEGER,
      acknowledged_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (sop_id) REFERENCES sops(id) ON DELETE CASCADE,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    -- SOP references/links
    CREATE TABLE IF NOT EXISTS sop_references (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sop_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      link TEXT,
      related_sop_id INTEGER,
      FOREIGN KEY (sop_id) REFERENCES sops(id) ON DELETE CASCADE
    );

    -- SOP revision history
    CREATE TABLE IF NOT EXISTS sop_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sop_id INTEGER NOT NULL,
      version TEXT,
      date TEXT,
      changed_by TEXT,
      description TEXT,
      FOREIGN KEY (sop_id) REFERENCES sops(id) ON DELETE CASCADE
    );

    -- Process Flows
    CREATE TABLE IF NOT EXISTS process_flows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER,
      title TEXT NOT NULL,
      category TEXT,
      description TEXT,
      trigger_event TEXT,
      owner TEXT,
      status TEXT DEFAULT 'draft',
      is_template INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    -- Process Flow Nodes
    CREATE TABLE IF NOT EXISTS flow_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flow_id INTEGER NOT NULL,
      node_order INTEGER DEFAULT 0,
      type TEXT DEFAULT 'process',
      label TEXT NOT NULL,
      description TEXT,
      responsible TEXT,
      yes_label TEXT,
      no_label TEXT,
      color TEXT,
      swimlane TEXT,
      duration TEXT,
      notes TEXT,
      connect_to INTEGER,
      yes_connect INTEGER,
      no_connect INTEGER,
      FOREIGN KEY (flow_id) REFERENCES process_flows(id) ON DELETE CASCADE
    );

    -- Alerts (from monitoring + webhooks)
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER,
      source TEXT DEFAULT 'monitor',
      severity TEXT DEFAULT 'critical',
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'open',
      resolved_at TEXT,
      resolved_by TEXT,
      resolution TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (monitor_id) REFERENCES equipment_monitors(id) ON DELETE SET NULL
    );

    -- Chat channels
    CREATE TABLE IF NOT EXISTS chat_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'group',
      company_id INTEGER,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    -- Chat channel members
    CREATE TABLE IF NOT EXISTS chat_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      user_type TEXT DEFAULT 'company_user',
      user_id INTEGER,
      user_name TEXT NOT NULL,
      last_read_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (channel_id) REFERENCES chat_channels(id) ON DELETE CASCADE
    );

    -- Chat messages
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      sender_type TEXT DEFAULT 'company_user',
      sender_id INTEGER,
      sender_name TEXT NOT NULL,
      message TEXT NOT NULL,
      attachment TEXT,
      attachment_name TEXT,
      attachment_type TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (channel_id) REFERENCES chat_channels(id) ON DELETE CASCADE
    );

    -- Security policies
    CREATE TABLE IF NOT EXISTS security_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER,
      title TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      description TEXT,
      content TEXT,
      version TEXT DEFAULT '1.0',
      status TEXT DEFAULT 'draft',
      requires_ack INTEGER DEFAULT 1,
      review_date TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    -- Security policy acknowledgments
    CREATE TABLE IF NOT EXISTS policy_acknowledgments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_id INTEGER NOT NULL,
      user_name TEXT NOT NULL,
      company_id INTEGER,
      acknowledged_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (policy_id) REFERENCES security_policies(id) ON DELETE CASCADE,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    -- Password vault (encrypted-at-rest via app)
    CREATE TABLE IF NOT EXISTS password_vault (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER,
      title TEXT NOT NULL,
      username TEXT,
      password_enc TEXT,
      url TEXT,
      category TEXT DEFAULT 'general',
      notes TEXT,
      share_type TEXT DEFAULT 'private',
      share_dept TEXT,
      shared_with TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    -- Email provider security settings
    CREATE TABLE IF NOT EXISTS email_providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      domain TEXT,
      admin_url TEXT,
      mfa_enabled INTEGER DEFAULT 0,
      spf_configured INTEGER DEFAULT 0,
      dkim_configured INTEGER DEFAULT 0,
      dmarc_configured INTEGER DEFAULT 0,
      backup_codes_stored INTEGER DEFAULT 0,
      password_policy TEXT,
      retention_days INTEGER DEFAULT 0,
      notes TEXT,
      last_audit_date TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    -- Password reset tokens
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- File directories
    CREATE TABLE IF NOT EXISTS file_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      parent_id INTEGER,
      name TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES file_folders(id) ON DELETE CASCADE
    );

    -- Folder user access
    CREATE TABLE IF NOT EXISTS folder_access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER NOT NULL,
      user_name TEXT NOT NULL,
      permission TEXT DEFAULT 'view',
      FOREIGN KEY (folder_id) REFERENCES file_folders(id) ON DELETE CASCADE
    );

    -- Files
    CREATE TABLE IF NOT EXISTS company_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      folder_id INTEGER,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      size INTEGER DEFAULT 0,
      mime_type TEXT,
      uploaded_by TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (folder_id) REFERENCES file_folders(id) ON DELETE SET NULL
    );

    -- Gamification: XP events
    CREATE TABLE IF NOT EXISTS user_xp (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      action TEXT NOT NULL,
      xp INTEGER NOT NULL,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- ELD/Telematics API keys (Samsara, Motive, etc.)
    CREATE TABLE IF NOT EXISTS eld_integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      label TEXT,
      api_key TEXT NOT NULL,
      base_url TEXT,
      is_active INTEGER DEFAULT 1,
      last_sync TEXT,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    -- Synced vehicles from ELD providers
    CREATE TABLE IF NOT EXISTS eld_vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      integration_id INTEGER NOT NULL,
      external_id TEXT,
      name TEXT,
      make TEXT,
      model TEXT,
      year INTEGER,
      vin TEXT,
      license_plate TEXT,
      status TEXT,
      odometer REAL,
      fuel_pct REAL,
      last_location TEXT,
      last_lat REAL,
      last_lng REAL,
      last_speed REAL,
      driver_name TEXT,
      raw_data TEXT,
      last_updated TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (integration_id) REFERENCES eld_integrations(id) ON DELETE CASCADE
    );

    -- Fleet: Vehicles (trucks)
    CREATE TABLE IF NOT EXISTS fleet_vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      unit_number TEXT,
      type TEXT DEFAULT 'truck',
      make TEXT,
      model TEXT,
      year INTEGER,
      vin TEXT,
      license_plate TEXT,
      state TEXT,
      color TEXT,
      status TEXT DEFAULT 'active',
      driver_id INTEGER,
      fuel_type TEXT DEFAULT 'diesel',
      odometer INTEGER DEFAULT 0,
      purchase_date TEXT,
      purchase_price REAL DEFAULT 0,
      insurance_policy TEXT,
      insurance_expires TEXT,
      registration_expires TEXT,
      inspection_expires TEXT,
      gps_unit TEXT,
      eld_provider TEXT,
      notes TEXT,
      photo_url TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (driver_id) REFERENCES company_users(id) ON DELETE SET NULL
    );

    -- Fleet: Trailers
    CREATE TABLE IF NOT EXISTS fleet_trailers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      unit_number TEXT,
      type TEXT DEFAULT 'dry-van',
      make TEXT,
      model TEXT,
      year INTEGER,
      vin TEXT,
      license_plate TEXT,
      state TEXT,
      length_ft INTEGER,
      status TEXT DEFAULT 'active',
      assigned_vehicle_id INTEGER,
      purchase_date TEXT,
      purchase_price REAL DEFAULT 0,
      registration_expires TEXT,
      inspection_expires TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_vehicle_id) REFERENCES fleet_vehicles(id) ON DELETE SET NULL
    );

    -- Fleet: Maintenance logs
    CREATE TABLE IF NOT EXISTS fleet_maintenance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      vehicle_id INTEGER,
      trailer_id INTEGER,
      type TEXT DEFAULT 'repair',
      description TEXT NOT NULL,
      vendor TEXT,
      cost REAL DEFAULT 0,
      odometer INTEGER,
      date TEXT,
      next_due_date TEXT,
      next_due_miles INTEGER,
      status TEXT DEFAULT 'completed',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (vehicle_id) REFERENCES fleet_vehicles(id) ON DELETE SET NULL,
      FOREIGN KEY (trailer_id) REFERENCES fleet_trailers(id) ON DELETE SET NULL
    );

    -- Fleet: Fuel logs
    CREATE TABLE IF NOT EXISTS fleet_fuel (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      vehicle_id INTEGER,
      date TEXT,
      gallons REAL DEFAULT 0,
      cost_per_gallon REAL DEFAULT 0,
      total_cost REAL DEFAULT 0,
      odometer INTEGER,
      station TEXT,
      city TEXT,
      state TEXT,
      fuel_card TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (vehicle_id) REFERENCES fleet_vehicles(id) ON DELETE SET NULL
    );

    -- Domain / Hosting management
    CREATE TABLE IF NOT EXISTS domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      domain TEXT NOT NULL,
      registrar TEXT,
      dns_provider TEXT,
      hosting_provider TEXT,
      ssl_provider TEXT,
      ssl_expires TEXT,
      domain_expires TEXT,
      nameservers TEXT,
      a_records TEXT,
      mx_records TEXT,
      auto_renew INTEGER DEFAULT 1,
      admin_url TEXT,
      login_email TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    -- Service schedule (recurring service visits/tasks per company)
    CREATE TABLE IF NOT EXISTS service_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      service_id INTEGER,
      title TEXT NOT NULL,
      description TEXT,
      frequency TEXT DEFAULT 'monthly',
      day_of_month INTEGER DEFAULT 1,
      day_of_week TEXT,
      time_slot TEXT,
      assigned_to TEXT,
      is_active INTEGER DEFAULT 1,
      last_completed TEXT,
      next_due TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE SET NULL
    );
  `);

  // Seed default services if none exist
  const hasServices = db.prepare('SELECT COUNT(*) as c FROM services').get();
  if (hasServices.c === 0) {
    const svcInsert = db.prepare('INSERT INTO services (name, category, description, price_type, base_price, is_public) VALUES (?,?,?,?,?,1)');
    const svcs = [
      // === FLAGSHIP BUNDLE: $2,000/month — designed for 1 day/week workload ===
      ['Complete IT Care Package', 'Bundle', 'Everything your trucking company needs in one flat monthly fee. This is our most popular plan — designed to give you a full IT department for the cost of one day per week.\n\nWhat is included:\n• Unlimited remote helpdesk support (Mon-Fri, 8am-6pm)\n• One on-site visit per week (4 hours) for maintenance, user support, and checkups\n• Server and network monitoring with alerts\n• Email management (add/remove users, fix issues, spam filtering)\n• Data backup management and monthly restore testing\n• Antivirus and security updates on all computers\n• Software installation and updates\n• User account management (new hires, terminations, password resets)\n• Printer and scanner troubleshooting\n• Monthly IT health report\n• Vendor coordination (internet provider, phone, software vendors)\n• Asset tracking for all your computers and equipment\n\nPerfect for companies with 5-30 employees. No surprise bills — one flat rate covers everything above.', 'monthly', 2000],

      // === INDIVIDUAL SERVICES (for companies that only need specific things) ===
      ['Remote Helpdesk Only', 'Managed IT', 'Phone and remote support for everyday IT problems. Your team calls or emails when something breaks — we fix it remotely within hours. Covers password resets, email issues, printer problems, software crashes, slow computers, and basic troubleshooting. No on-site visits included.', 'monthly', 500],
      ['On-Site IT Day', 'Managed IT', 'A full day (up to 8 hours) of on-site IT work at your location. Use it for hardware setup, network fixes, training sessions, or catch-up maintenance. We come to your office and handle everything hands-on. Schedule weekly, biweekly, or as needed.', 'one-time', 600],
      ['Server & Network Monitoring', 'Monitoring', 'We watch your servers, routers, and internet connection 24/7. If anything goes down or starts acting strange, we get an alert and start fixing it — often before you even notice a problem. Includes monthly uptime reports and performance trends.', 'monthly', 300],
      ['Email Setup & Management', 'Email', 'Set up professional company email addresses for your team using Microsoft 365 or Google Workspace. We create accounts, set up on phones and computers, configure spam filters, and handle ongoing support. Price is per user per month on top of the Microsoft/Google license.', 'per-user', 10],
      ['Data Backup & Recovery', 'Backup', 'Automated daily backups of your critical files — dispatch records, accounting data, customer information, documents. Stored securely in the cloud. We test restores monthly to make sure recovery actually works when you need it.', 'monthly', 200],
      ['Cybersecurity Basics', 'Security', 'Keep your company protected from common threats. We install and manage antivirus on all machines, set up email spam filtering, configure your firewall, and give your team simple tips to avoid phishing emails and scams. Includes quarterly security reviews.', 'monthly', 250],
      ['New Computer Setup', 'Hardware', 'We purchase (at your cost), configure, and deploy a new computer or laptop. Includes transferring files and settings from the old machine, installing all your software, setting up email, connecting to printers, and giving the user a quick walkthrough. Price is per machine for our labor.', 'one-time', 150],
      ['Cloud Migration', 'Cloud', 'Move your company from old local servers to the cloud — Microsoft 365, Google Workspace, or hosted servers. We plan everything, migrate your files and email, train your team, and make sure nothing gets lost. One-time project, typically 1-2 weeks.', 'one-time', 2500],
      ['IT Strategy Consultation', 'Consulting', 'A 2-hour session where we review your current IT setup, discuss your business goals, and create a practical technology plan. Good for companies that are growing, moving offices, or just want an expert opinion on what to upgrade and what to skip.', 'one-time', 250],
      ['Website & Domain Care', 'Web', 'We keep your company website running and your domain name renewed. Includes SSL certificate management, basic content updates (text and photos), hosting monitoring, and making sure your site stays secure and loads fast.', 'monthly', 150],
      ['VoIP Phone Setup', 'Communication', 'Replace expensive traditional phone lines with a modern internet-based phone system. We set up the phones, program call routing, configure voicemail, and train your team. Saves most companies 40-60% on their phone bills.', 'one-time', 800],
      ['Employee IT Onboarding', 'HR-IT', 'New hire? We set up their computer, create their email account, install required software, connect them to printers and shared drives, set up their phone, and walk them through everything on day one. Also handles offboarding — disable accounts, collect equipment, secure company data.', 'one-time', 75],
      ['Software License Audit', 'Consulting', 'We review every software subscription and license your company pays for. Find unused seats, duplicate subscriptions, and opportunities to save money. Most companies find 15-25% in savings. One-time audit with a written report.', 'one-time', 400],
      ['Emergency Support (After Hours)', 'Managed IT', 'Critical system down outside business hours? Server crashed on a weekend? We provide emergency response to get your business back online as fast as possible. Response within 1 hour, work until resolved.', 'hourly', 200],
      ['Compliance Documentation', 'Consulting', 'We create and maintain the IT documentation your company needs for insurance, DOT audits, or customer requirements. Includes IT policies, asset inventories, backup documentation, and security procedures. Updated quarterly.', 'monthly', 200]
    ];
    svcs.forEach(s => svcInsert.run(...s));
  }

  // Add 2FA columns to users if missing
  try { db.prepare('SELECT totp_secret FROM users LIMIT 1').get(); } catch(e) {
    try { db.exec('ALTER TABLE users ADD COLUMN totp_secret TEXT'); } catch(e2) {}
    try { db.exec('ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0'); } catch(e2) {}
  }

  // Seed default roles
  const hasRoles = db.prepare('SELECT COUNT(*) as c FROM roles').get();
  if (hasRoles.c === 0) {
    const ri = db.prepare('INSERT INTO roles (name, description, sort_order) VALUES (?,?,?)');
    [['Owner','Company owner or CEO',1],['Manager','Department or office manager',2],['Dispatcher','Dispatch and logistics coordinator',3],['Driver','Truck driver',4],['Mechanic','Fleet maintenance technician',5],['Accounting','Bookkeeper or accountant',6],['Safety Officer','Safety and compliance manager',7],['HR','Human resources',8],['Admin','Office administrator or assistant',9],['IT Contact','Primary IT liaison at the company',10],['Receptionist','Front desk and phone',11],['Warehouse','Warehouse or yard staff',12]].forEach(r => ri.run(...r));
  }

  // Seed default departments
  const hasDepts = db.prepare('SELECT COUNT(*) as c FROM departments').get();
  if (hasDepts.c === 0) {
    const di = db.prepare('INSERT INTO departments (name, description, sort_order) VALUES (?,?,?)');
    [['Executive','Leadership and ownership',1],['Operations','Dispatch, logistics, and daily operations',2],['Driving','CDL drivers and fleet operators',3],['Maintenance','Truck and equipment maintenance',4],['Accounting','Finance, billing, and payroll',5],['Safety','Safety compliance and training',6],['HR','Hiring, onboarding, and employee management',7],['Administration','Office support and front desk',8],['IT','Technology and systems',9],['Warehouse','Loading, unloading, and yard operations',10]].forEach(d => di.run(...d));
  }

  // Add eld_vehicle_id to fleet_vehicles if missing
  try { db.prepare('SELECT eld_vehicle_id FROM fleet_vehicles LIMIT 1').get(); } catch(e) {
    try { db.exec('ALTER TABLE fleet_vehicles ADD COLUMN eld_vehicle_id INTEGER'); } catch(e2) {}
  }

  // Add SLA columns to tasks if missing
  try { db.prepare('SELECT started_at FROM tasks LIMIT 1').get(); } catch(e) {
    try { db.exec('ALTER TABLE tasks ADD COLUMN started_at TEXT'); } catch(e2) {}
    try { db.exec('ALTER TABLE tasks ADD COLUMN completed_at TEXT'); } catch(e2) {}
    try { db.exec('ALTER TABLE tasks ADD COLUMN first_response_at TEXT'); } catch(e2) {}
    try { db.exec('ALTER TABLE tasks ADD COLUMN sla_response_min INTEGER'); } catch(e2) {}
    try { db.exec('ALTER TABLE tasks ADD COLUMN sla_resolve_min INTEGER'); } catch(e2) {}
  }

  // Add agreement columns if missing
  try { db.prepare('SELECT title FROM agreements LIMIT 1').get(); } catch(e) {
    try { db.exec('ALTER TABLE agreements ADD COLUMN title TEXT'); } catch(e2) {}
    try { db.exec('ALTER TABLE agreements ADD COLUMN auto_renew INTEGER DEFAULT 1'); } catch(e2) {}
    try { db.exec('ALTER TABLE agreements ADD COLUMN sla_response TEXT'); } catch(e2) {}
    try { db.exec('ALTER TABLE agreements ADD COLUMN sla_resolution TEXT'); } catch(e2) {}
    try { db.exec('ALTER TABLE agreements ADD COLUMN scope TEXT'); } catch(e2) {}
    try { db.exec('ALTER TABLE agreements ADD COLUMN exclusions TEXT'); } catch(e2) {}
    try { db.exec('ALTER TABLE agreements ADD COLUMN terms TEXT'); } catch(e2) {}
    try { db.exec('ALTER TABLE agreements ADD COLUMN signed_by TEXT'); } catch(e2) {}
    try { db.exec('ALTER TABLE agreements ADD COLUMN signed_date TEXT'); } catch(e2) {}
    try { db.exec('ALTER TABLE agreements ADD COLUMN attachment TEXT'); } catch(e2) {}
    try { db.exec('ALTER TABLE agreements ADD COLUMN attachment_name TEXT'); } catch(e2) {}
  }

  // Add flow_nodes columns if missing
  try { db.prepare('SELECT color FROM flow_nodes LIMIT 1').get(); } catch(e) {
    try { db.exec('ALTER TABLE flow_nodes ADD COLUMN color TEXT'); } catch(e2) {}
    try { db.exec('ALTER TABLE flow_nodes ADD COLUMN swimlane TEXT'); } catch(e2) {}
    try { db.exec('ALTER TABLE flow_nodes ADD COLUMN duration TEXT'); } catch(e2) {}
    try { db.exec('ALTER TABLE flow_nodes ADD COLUMN notes TEXT'); } catch(e2) {}
    try { db.exec('ALTER TABLE flow_nodes ADD COLUMN connect_to INTEGER'); } catch(e2) {}
    try { db.exec('ALTER TABLE flow_nodes ADD COLUMN yes_connect INTEGER'); } catch(e2) {}
    try { db.exec('ALTER TABLE flow_nodes ADD COLUMN no_connect INTEGER'); } catch(e2) {}
  }

  // Add show_on_landing to services if missing
  try { db.prepare('SELECT show_on_landing FROM services LIMIT 1').get(); } catch(e) {
    try { db.exec('ALTER TABLE services ADD COLUMN show_on_landing INTEGER DEFAULT 0'); } catch(e2) {}
  }

  // Add storage_quota to companies if missing (in MB)
  try { db.prepare('SELECT storage_quota FROM companies LIMIT 1').get(); } catch(e) {
    try { db.exec('ALTER TABLE companies ADD COLUMN storage_quota INTEGER DEFAULT 500'); } catch(e2) {}
  }

  // Add is_super column to users if missing
  try { db.prepare('SELECT is_super FROM users LIMIT 1').get(); } catch(e) {
    try { db.exec('ALTER TABLE users ADD COLUMN is_super INTEGER DEFAULT 0'); } catch(e2) {}
  }
  // Make first admin a super admin
  try { db.prepare("UPDATE users SET is_super = 1 WHERE role = 'admin' AND id = (SELECT MIN(id) FROM users WHERE role = 'admin')").run(); } catch(e) {}

  // Add chat attachment columns if missing
  try { db.prepare('SELECT attachment FROM chat_messages LIMIT 1').get(); } catch(e) {
    try { db.exec('ALTER TABLE chat_messages ADD COLUMN attachment TEXT'); } catch(e2) {}
    try { db.exec('ALTER TABLE chat_messages ADD COLUMN attachment_name TEXT'); } catch(e2) {}
    try { db.exec('ALTER TABLE chat_messages ADD COLUMN attachment_type TEXT'); } catch(e2) {}
  }

  // Add inventory columns if missing
  try { db.prepare('SELECT cost FROM inventory LIMIT 1').get(); } catch(e) {
    try { db.exec('ALTER TABLE inventory ADD COLUMN manufacturer TEXT'); } catch(e2) {}
    try { db.exec('ALTER TABLE inventory ADD COLUMN model TEXT'); } catch(e2) {}
    try { db.exec('ALTER TABLE inventory ADD COLUMN quantity INTEGER DEFAULT 1'); } catch(e2) {}
    try { db.exec('ALTER TABLE inventory ADD COLUMN cost REAL DEFAULT 0'); } catch(e2) {}
    try { db.exec('ALTER TABLE inventory ADD COLUMN location_id INTEGER'); } catch(e2) {}
  }

  // Try adding new columns to existing tables
  try { db.prepare('SELECT title FROM company_users LIMIT 1').get(); } catch(e) {
    try { db.exec('ALTER TABLE company_users ADD COLUMN title TEXT'); } catch(e2) {}
    try { db.exec('ALTER TABLE company_users ADD COLUMN manager_id INTEGER'); } catch(e2) {}
    try { db.exec('ALTER TABLE company_users ADD COLUMN hire_date TEXT'); } catch(e2) {}
    try { db.exec('ALTER TABLE company_users ADD COLUMN photo_url TEXT'); } catch(e2) {}
  }

  // Seed SOP templates
  const hasSops = db.prepare('SELECT COUNT(*) as c FROM sops WHERE is_template = 1').get();
  if (hasSops.c === 0) {
    const si = db.prepare('INSERT INTO sops (title, category, description, status, is_template) VALUES (?,?,?,?,1)');
    const sti = db.prepare('INSERT INTO sop_steps (sop_id, step_number, title, description, responsible) VALUES (?,?,?,?,?)');
    const sops = [
      {t:'New Employee IT Onboarding',cat:'HR-IT',d:'Step-by-step process for setting up technology access and equipment when a new employee joins the company.',steps:[
        ['Receive new hire notification from HR','HR sends the hiring manager form with start date, role, and department','HR'],
        ['Create company email account','Set up email in Microsoft 365 or Google Workspace with the standard naming format','IT'],
        ['Create user accounts','Set up logins for all required systems: ERP, dispatch, accounting, etc.','IT'],
        ['Prepare workstation','Configure computer/laptop with OS, software, email, and printer connections','IT'],
        ['Set up phone and voicemail','Assign phone extension, configure voicemail greeting, add to company directory','IT'],
        ['Assign equipment','Document all equipment given to employee: computer, phone, keys, badges','IT'],
        ['Security orientation','Brief employee on password policy, acceptable use, and phishing awareness','IT'],
        ['Verify access works','Walk through all systems with the employee to confirm everything works','IT'],
        ['Update asset inventory','Record all assigned equipment in the asset tracking system','IT'],
        ['Sign IT policy acknowledgment','Employee signs acceptable use policy and confidentiality agreement','HR/IT']
      ]},
      {t:'Employee IT Offboarding',cat:'HR-IT',d:'Secure process for removing technology access and recovering equipment when an employee leaves.',steps:[
        ['Receive termination notification','HR notifies IT of employee departure date and type (voluntary/involuntary)','HR'],
        ['Disable email account','Deactivate email, set up forwarding to manager if needed, do NOT delete yet','IT'],
        ['Disable system access','Remove login access from all business systems, VPN, and remote desktop','IT'],
        ['Recover equipment','Collect laptop, phone, keys, badges, and any other company property','IT'],
        ['Change shared passwords','Update any shared account passwords the employee had access to','IT'],
        ['Backup user data','Archive the employee email and files per retention policy','IT'],
        ['Update asset inventory','Mark all returned equipment in the tracking system','IT'],
        ['Final security review','Verify no unauthorized access occurred, check for data exports','IT']
      ]},
      {t:'Password Reset Procedure',cat:'Security',d:'Standard process for handling password reset requests from employees.',steps:[
        ['Receive reset request','Employee calls or emails helpdesk requesting a password reset','Employee'],
        ['Verify identity','Confirm the requester identity using security questions or manager verification','IT'],
        ['Reset password','Generate a temporary password in the admin console','IT'],
        ['Communicate securely','Send temporary password via a separate channel (phone call, not email)','IT'],
        ['Force password change','Ensure the system requires a new password at next login','IT'],
        ['Document the request','Log the reset in the helpdesk ticket system with date and requester','IT']
      ]},
      {t:'Data Backup Verification',cat:'Backup',d:'Monthly procedure to verify that backups are running correctly and data can be restored.',steps:[
        ['Check backup logs','Review backup software logs for any failures in the past 30 days','IT'],
        ['Verify backup completeness','Confirm all critical data sources are included in the backup scope','IT'],
        ['Test file restore','Restore 3-5 random files from backup and verify they open correctly','IT'],
        ['Test full system restore','Quarterly: restore a full system image to a test environment','IT'],
        ['Check offsite copies','Verify cloud/offsite backup is current and accessible','IT'],
        ['Document results','Record test results, any issues found, and corrective actions taken','IT'],
        ['Report to management','Send monthly backup health report to company management','IT']
      ]},
      {t:'Security Incident Response',cat:'Security',d:'What to do when a security breach, virus infection, or suspicious activity is detected.',steps:[
        ['Identify and contain','Isolate the affected system from the network immediately','IT'],
        ['Assess the scope','Determine what systems, data, and users are affected','IT'],
        ['Notify management','Alert company leadership and affected clients within 1 hour','IT/Management'],
        ['Preserve evidence','Take screenshots, save logs, do not delete or modify affected files','IT'],
        ['Eradicate the threat','Remove malware, close vulnerabilities, patch systems','IT'],
        ['Restore from backup','If data was lost or encrypted, restore from last known good backup','IT'],
        ['Change credentials','Reset all passwords for affected systems and users','IT'],
        ['Post-incident review','Document what happened, how it was handled, and what to improve','IT'],
        ['Update security measures','Implement changes to prevent the same incident from recurring','IT']
      ]},
      {t:'Server Maintenance Checklist',cat:'Server',d:'Monthly server maintenance tasks to keep systems running reliably.',steps:[
        ['Check disk space','Verify all drives have at least 20% free space, clean up if needed','IT'],
        ['Review event logs','Check Windows Event Viewer or Linux syslog for errors and warnings','IT'],
        ['Apply OS updates','Install security patches and critical updates, schedule reboot if required','IT'],
        ['Check backup status','Verify server backups completed successfully','IT'],
        ['Review user accounts','Check for disabled accounts that should be removed, unused admin accounts','IT'],
        ['Check hardware health','Review RAID status, temperature, fan speeds via management console','IT'],
        ['Test UPS battery','Verify UPS is charging and holding load, check battery age','IT'],
        ['Update documentation','Record any changes made during maintenance in the server log','IT']
      ]},
      {t:'Software Installation Request',cat:'IT Operations',d:'Process for requesting, approving, and installing new software on company computers.',steps:[
        ['Submit request','Employee fills out software request form with business justification','Employee'],
        ['Manager approval','Direct manager reviews and approves the business need','Manager'],
        ['IT review','IT checks compatibility, security risks, and licensing requirements','IT'],
        ['Purchase/license','Procure license if needed, verify compliance with vendor terms','IT'],
        ['Install and configure','Install software on the employee workstation, configure settings','IT'],
        ['Test functionality','Verify the software works correctly with existing systems','IT/Employee'],
        ['Document','Add to software inventory, record license key, update asset records','IT']
      ]},
      {t:'Vendor Access Procedure',cat:'Security',d:'How to grant and manage technology vendor access to company systems.',steps:[
        ['Receive access request','Vendor submits request specifying what systems they need access to and why','Vendor'],
        ['Verify NDA is signed','Confirm a current non-disclosure agreement is on file','Management'],
        ['Create temporary credentials','Set up time-limited access with minimum required permissions','IT'],
        ['Monitor vendor session','If possible, observe or log vendor activity during the access window','IT'],
        ['Revoke access when done','Disable the temporary account immediately after work is completed','IT'],
        ['Review work performed','Check what changes the vendor made, verify nothing unexpected','IT'],
        ['Document the access','Log the access event: who, when, what systems, what was done','IT']
      ]}
    ];
    sops.forEach(s => {
      const r = si.run(s.t, s.cat, s.d, 'published');
      s.steps.forEach((st, i) => sti.run(r.lastInsertRowid, i+1, st[0], st[1], st[2]));
    });
  }

  // Seed Process Flow templates
  const hasFlows = db.prepare('SELECT COUNT(*) as c FROM process_flows WHERE is_template = 1').get();
  if (hasFlows.c === 0) {
    const fi = db.prepare('INSERT INTO process_flows (title, category, description, trigger_event, status, is_template) VALUES (?,?,?,?,?,1)');
    const ni = db.prepare('INSERT INTO flow_nodes (flow_id, node_order, type, label, description, responsible, yes_label, no_label) VALUES (?,?,?,?,?,?,?,?)');
    const flows = [
      {t:'Helpdesk Ticket Flow',cat:'IT Operations',d:'How support requests are received, triaged, and resolved.',tr:'Employee reports an IT issue',nodes:[
        ['start','Ticket Received','Employee submits ticket via email, phone, or portal','Employee',null,null],
        ['process','Assign Priority','Classify as Low, Medium, High, or Critical based on business impact','IT',null,null],
        ['decision','Can resolve remotely?','Determine if the issue can be fixed without an on-site visit','IT','Fix remotely','Schedule on-site'],
        ['process','Remote Fix','Connect via remote desktop and resolve the issue','IT',null,null],
        ['process','On-Site Visit','Schedule and perform on-site repair or setup','IT',null,null],
        ['decision','Issue resolved?','Test with the user to confirm the problem is fixed','IT','Close ticket','Escalate'],
        ['process','Escalate','Assign to senior technician or vendor for advanced troubleshooting','IT',null,null],
        ['process','Close Ticket','Document solution, update knowledge base, close the ticket','IT',null,null],
        ['end','Done','Ticket closed, user notified','IT',null,null]
      ]},
      {t:'New Employee Onboarding',cat:'HR-IT',d:'Complete flow from hiring decision to day-one readiness.',tr:'HR approves a new hire',nodes:[
        ['start','Hire Approved','HR confirms new employee and provides start date','HR',null,null],
        ['process','Create Accounts','Set up email, system logins, and user profiles','IT',null,null],
        ['process','Prepare Equipment','Configure workstation, install software, test everything','IT',null,null],
        ['decision','Equipment ready?','Is the workstation fully configured and tested?','IT','Proceed','Fix issues'],
        ['process','Assign Assets','Document all equipment assigned: serial numbers, model, condition','IT',null,null],
        ['process','Day-One Setup','Help employee log in, tour of systems, answer questions','IT',null,null],
        ['process','Security Training','Brief on passwords, phishing, acceptable use policy','IT',null,null],
        ['end','Onboarding Complete','Employee is set up and productive','IT',null,null]
      ]},
      {t:'Server Down Recovery',cat:'Incident',d:'Emergency response when a critical server goes offline.',tr:'Monitoring alert or user report of server outage',nodes:[
        ['start','Server Down Alert','Monitoring system or user reports server is unreachable','System',null,null],
        ['process','Verify Outage','Confirm the server is actually down, not a false alarm','IT',null,null],
        ['decision','Physical or cloud?','Is this an on-premise server or cloud-hosted?','IT','Cloud','Physical'],
        ['process','Check Cloud Console','Log into AWS/Azure/GCP console, check instance status','IT',null,null],
        ['process','Check Physical Server','Go to server room, check power, network cables, error lights','IT',null,null],
        ['decision','Quick fix possible?','Can you restart the service or reboot to fix it?','IT','Restart','Deeper investigation'],
        ['process','Restart Services','Reboot server or restart the failed service','IT',null,null],
        ['process','Investigate Root Cause','Check logs, disk space, hardware health, recent changes','IT',null,null],
        ['decision','Resolved?','Is the server back online and working normally?','IT','Monitor','Restore from backup'],
        ['process','Restore from Backup','If data is corrupted, restore from last good backup','IT',null,null],
        ['process','Monitor & Document','Watch for recurrence, write incident report','IT',null,null],
        ['end','Resolved','Server is back online, root cause documented','IT',null,null]
      ]},
      {t:'Software Update Deployment',cat:'IT Operations',d:'Controlled process for rolling out software updates across the company.',tr:'Vendor releases a new software version or security patch',nodes:[
        ['start','Update Available','New version or security patch released by vendor','Vendor',null,null],
        ['process','Review Release Notes','Check what changed, known issues, compatibility requirements','IT',null,null],
        ['decision','Security critical?','Is this a critical security patch?','IT','Fast track','Standard schedule'],
        ['process','Test on Pilot Machine','Install on one test computer, verify everything works','IT',null,null],
        ['decision','Test passed?','Does the update work without breaking other software?','IT','Deploy','Report issue to vendor'],
        ['process','Schedule Deployment','Plan rollout timing to minimize disruption','IT',null,null],
        ['process','Deploy to All Machines','Push update via remote management or install on-site','IT',null,null],
        ['process','Verify & Document','Confirm all machines updated, record in change log','IT',null,null],
        ['end','Complete','All systems updated and documented','IT',null,null]
      ]}
    ];
    flows.forEach(f => {
      const r = fi.run(f.t, f.cat, f.d, f.tr, 'published');
      f.nodes.forEach((nd, i) => ni.run(r.lastInsertRowid, i, nd[0], nd[1], nd[2], nd[3], nd[4], nd[5]));
    });
  }

  // Seed default project statuses
  const hasStatuses = db.prepare('SELECT COUNT(*) as c FROM project_statuses').get();
  if (hasStatuses.c === 0) {
    const statuses = [
      ['Planning', '#8b5cf6', 1],
      ['In Progress', '#0891b2', 2],
      ['On Hold', '#f59e0b', 3],
      ['Under Review', '#6366f1', 4],
      ['Completed', '#10b981', 5],
      ['Cancelled', '#64748b', 6]
    ];
    const ins = db.prepare('INSERT INTO project_statuses (name, color, sort_order) VALUES (?,?,?)');
    statuses.forEach(s => ins.run(...s));
  }

  // Add logo column to existing companies table if missing
  try { db.prepare('SELECT logo FROM companies LIMIT 1').get(); } catch(e) {
    db.exec('ALTER TABLE companies ADD COLUMN logo TEXT');
  }

  // Seed admin user if not exists
  const adminExists = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
  if (!adminExists) {
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('admin', 10);
    db.prepare('INSERT INTO users (username, password, role, full_name) VALUES (?, ?, ?, ?)').run('admin', hash, 'admin', 'Administrator');
  }

  // Seed default settings
  const bizName = db.prepare('SELECT value FROM settings WHERE key = ?').get('business_name');
  if (!bizName) {
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('business_name', 'IT Forge');
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('business_email', '');
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('business_phone', '');
  }

  // Seed security policy templates
  const hasPolicies = db.prepare('SELECT COUNT(*) as c FROM security_policies WHERE company_id IS NULL').get();
  if (hasPolicies.c === 0) {
    const pi = db.prepare('INSERT INTO security_policies (title, category, description, content, status, requires_ack) VALUES (?,?,?,?,?,?)');
    const policies = [
      ['Acceptable Use Policy', 'General', 'Rules for using company computers, internet, and email',
        '1. OVERVIEW\nThis policy defines acceptable use of company technology resources.\n\n2. SCOPE\nApplies to all employees, contractors, and temporary staff.\n\n3. RULES\n- Company computers are for business use primarily\n- Limited personal use is allowed during breaks\n- Do not install unauthorized software\n- Do not visit inappropriate websites\n- Do not share login credentials with anyone\n- Lock your computer when leaving your desk (Win+L)\n- Report any suspicious emails to IT immediately\n\n4. EMAIL\n- Do not open attachments from unknown senders\n- Do not forward chain emails\n- Do not use company email for personal business\n- Be professional in all communications\n\n5. INTERNET\n- No streaming during work hours\n- No downloading pirated content\n- No visiting adult or gambling sites\n- Use VPN when on public WiFi\n\n6. VIOLATIONS\nViolations may result in disciplinary action up to termination.',
        'published', 1],
      ['Password Policy', 'Security', 'Requirements for creating and managing passwords',
        '1. PASSWORD REQUIREMENTS\n- Minimum 10 characters\n- Must include uppercase, lowercase, number, and special character\n- Cannot reuse last 5 passwords\n- Must be changed every 90 days\n\n2. RULES\n- Never share passwords with anyone including IT\n- Never write passwords on sticky notes\n- Use a password manager (approved by IT)\n- Use unique passwords for each account\n- Enable 2FA wherever available\n\n3. IF COMPROMISED\n- Change password immediately\n- Notify IT department\n- Check for unauthorized access\n\n4. IT ADMIN PASSWORDS\n- Minimum 16 characters\n- Changed every 60 days\n- Stored in approved password vault only',
        'published', 1],
      ['Data Protection Policy', 'Security', 'How to handle and protect company and customer data',
        '1. DATA CLASSIFICATION\n- Public: marketing materials, website content\n- Internal: company procedures, internal memos\n- Confidential: customer data, financial records, HR records\n- Restricted: passwords, encryption keys, legal documents\n\n2. HANDLING RULES\n- Confidential data must be encrypted at rest and in transit\n- Do not email confidential data without encryption\n- Do not store confidential data on personal devices\n- Shred paper documents containing confidential info\n- Report data breaches to IT within 1 hour\n\n3. BACKUPS\n- Critical data backed up daily\n- Backups tested monthly\n- Backups encrypted and stored offsite\n\n4. DISPOSAL\n- Hard drives: wiped with approved tool or physically destroyed\n- Paper: cross-cut shredded\n- Cloud data: verify deletion from all systems',
        'published', 1],
      ['BYOD Policy', 'Devices', 'Rules for using personal devices for work',
        '1. APPROVED DEVICES\n- Personal smartphones for email/calendar only\n- Personal laptops require IT approval and security check\n\n2. REQUIREMENTS\n- Device must have screen lock enabled\n- Device must have current antivirus (if applicable)\n- Device must have latest OS updates\n- Remote wipe must be enabled for phones with company email\n\n3. RESTRICTIONS\n- No company data stored locally on personal devices\n- No accessing company systems from jailbroken/rooted devices\n- IT may remotely wipe company data if device is lost/stolen\n\n4. LOST/STOLEN DEVICE\n- Report to IT immediately\n- IT will remotely wipe company data\n- Change all passwords accessed from that device',
        'published', 1],
      ['Incident Response Policy', 'Security', 'What to do when a security incident occurs',
        '1. DEFINITION\nA security incident is any event that compromises the confidentiality, integrity, or availability of company data or systems.\n\n2. EXAMPLES\n- Malware or virus infection\n- Unauthorized access to systems\n- Data breach or data loss\n- Phishing attack (successful)\n- Lost or stolen device\n- Suspicious network activity\n\n3. RESPONSE STEPS\nStep 1: CONTAIN — Disconnect affected systems from the network\nStep 2: NOTIFY — Contact IT immediately, then management within 1 hour\nStep 3: PRESERVE — Do not delete files, take screenshots, save logs\nStep 4: INVESTIGATE — IT determines scope and cause\nStep 5: REMEDIATE — Fix vulnerabilities, restore from backup\nStep 6: RECOVER — Verify systems are clean, resume operations\nStep 7: DOCUMENT — Write incident report with lessons learned\n\n4. REPORTING\n- All employees must report suspected incidents\n- No disciplinary action for good-faith reporting\n- IT maintains incident log for compliance',
        'published', 1],
      ['Remote Work Security Policy', 'Security', 'Security requirements for working from home or remotely',
        '1. NETWORK SECURITY\n- Always use company VPN when accessing company resources\n- Do not use public WiFi without VPN\n- Home WiFi must use WPA2/WPA3 encryption\n- Change default router password\n\n2. PHYSICAL SECURITY\n- Lock screen when stepping away\n- Do not let family members use work computer\n- Secure documents in locked drawer when not in use\n- Use privacy screen in public places\n\n3. VIDEO CALLS\n- Check background for sensitive information\n- Use headphones in shared spaces\n- Mute when not speaking\n\n4. DATA HANDLING\n- Do not print confidential documents at home\n- Do not photograph screens with personal phone\n- Use company-approved cloud storage only',
        'published', 1]
    ];
    policies.forEach(p => pi.run(...p));
  }

  return db;
}

module.exports = { initDB, DB_PATH };
