const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');

// Multer setup for CSV uploads
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
  if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) cb(null, true);
  else cb(new Error('Only CSV files allowed'));
}});

// Simple CSV parser (handles quoted fields with commas)
function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  const parseLine = (line) => {
    const fields = []; let current = ''; let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (inQuotes && line[i+1] === '"') { current += '"'; i++; } else { inQuotes = !inQuotes; } }
      else if (ch === ',' && !inQuotes) { fields.push(current.trim()); current = ''; }
      else { current += ch; }
    }
    fields.push(current.trim());
    return fields;
  };
  const headers = parseLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, ''));
  const rows = lines.slice(1).map(l => {
    const vals = parseLine(l);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
    return obj;
  }).filter(r => Object.values(r).some(v => v));
  return { headers, rows };
}

// CSV string builder
function toCSV(headers, rows) {
  const escape = (v) => { const s = String(v == null ? '' : v); return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [headers.join(','), ...rows.map(r => headers.map(h => escape(r[h])).join(','))].join('\n');
}

module.exports = function(db) {

  // All admin routes require admin login
  router.use(requireAdmin);

  // View helper — ensures forward slashes on Windows
  const V = (name) => 'admin/' + name;

  const getSettings = () => {
    const s = {};
    try { db.prepare('SELECT key, value FROM settings').all().forEach(r => { s[r.key] = r.value; }); } catch(e) {}
    return s;
  };

  // Notification count — tasks assigned to admin that are pending
  const getNotifications = () => {
    try {
      const allOpen = db.prepare("SELECT t.*, c.name as company_name FROM tasks t LEFT JOIN companies c ON t.company_id = c.id WHERE t.status != 'done' ORDER BY CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, t.created_at DESC LIMIT 20").all();
      const clientTasks = allOpen.filter(t => t.created_by === 'client');
      const myTasks = allOpen.filter(t => t.created_by !== 'client');
      return { allOpen, clientTasks, myTasks, count: allOpen.length };
    } catch(e) { return { allOpen: [], clientTasks: [], myTasks: [], count: 0 }; }
  };

  // Inject notifications into every admin render
  router.use((req, res, next) => {
    res.locals.notifications = getNotifications();
    next();
  });

  // Safe query helper — returns [] if table doesn't exist
  const safeAll = (sql, params) => { try { return params ? db.prepare(sql).all(...(Array.isArray(params)?params:[params])) : db.prepare(sql).all(); } catch(e) { return []; } };
  const safeGet = (sql, params) => { try { return params ? db.prepare(sql).get(...(Array.isArray(params)?params:[params])) : db.prepare(sql).get(); } catch(e) { return null; } };

  // === DASHBOARD ===
  router.get('/', (req, res) => {
    const companies = safeAll('SELECT * FROM companies ORDER BY name');
    const activeCount = companies.filter(c => c.status === 'active').length;
    const invoices = safeAll('SELECT * FROM invoices ORDER BY date DESC');
    const unpaid = invoices.filter(i => i.status === 'sent' || i.status === 'overdue');
    const unpaidTotal = unpaid.reduce((s, i) => s + (i.total || 0), 0);
    let mrr = 0;
    const agreements = safeAll("SELECT a.custom_price, s.base_price FROM agreements a JOIN services s ON a.service_id = s.id WHERE a.is_active = 1 AND a.billing_cycle = 'monthly'");
    agreements.forEach(a => { mrr += (a.custom_price || a.base_price || 0); });
    const tasks = safeAll("SELECT t.*, c.name as company_name FROM tasks t LEFT JOIN companies c ON t.company_id = c.id ORDER BY CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, t.due_date ASC");
    const openTasks = tasks.filter(t => t.status !== 'done');
    const projects = safeAll('SELECT p.*, c.name as company_name FROM projects p LEFT JOIN companies c ON p.company_id = c.id ORDER BY p.status ASC, p.due_date ASC');
    const activeProjects = projects.filter(p => p.status !== 'completed' && p.status !== 'cancelled');
    res.render(V('dashboard'), { user: req.session.user, companies, activeCount, invoices, unpaid, unpaidTotal, mrr, tasks, openTasks, projects, activeProjects, settings: getSettings(), page: 'dashboard' });
  });

  // === TASKS (all in one place) ===
  router.get('/tasks', (req, res) => {
    const filter = req.query.filter || 'open';
    const filterCompany = req.query.company || '';
    const filterPriority = req.query.priority || '';
    const filterAssigned = req.query.assigned || '';
    let where = [];
    if (filter === 'open') where.push("t.status != 'done'");
    else if (filter === 'done') where.push("t.status = 'done'");
    if (filterCompany) where.push("t.company_id = " + parseInt(filterCompany));
    if (filterPriority) where.push("t.priority = '" + filterPriority.replace(/'/g,'') + "'");
    if (filterAssigned) where.push("t.assigned_to = '" + filterAssigned.replace(/'/g,'') + "'");
    const whereStr = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    const tasks = safeAll(`SELECT t.*, c.name as company_name FROM tasks t LEFT JOIN companies c ON t.company_id = c.id ${whereStr} ORDER BY CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, t.due_date ASC`);
    const companies = safeAll('SELECT id, name FROM companies ORDER BY name');
    const allPeople = [{name:'admin'}].concat(safeAll("SELECT DISTINCT name FROM company_users WHERE name IS NOT NULL AND name != '' ORDER BY name"));
    res.render(V('tasks'), { user: req.session.user, tasks, companies, allPeople, filter, filterCompany, filterPriority, filterAssigned, settings: getSettings(), page: 'tasks' });
  });

  router.post('/tasks', (req, res) => {
    const { title, description, company_id, related_table, related_id, priority, due_date, assigned_to, status } = req.body;
    db.prepare('INSERT INTO tasks (title, description, company_id, related_table, related_id, priority, due_date, assigned_to, status) VALUES (?,?,?,?,?,?,?,?,?)').run(
      title, description, company_id || null, related_table || null, related_id || null, priority || 'medium', due_date || null, assigned_to || null, status || 'todo'
    );
    res.redirect(req.body.redirect || '/admin/tasks');
  });

  router.post('/tasks/:id/status', (req, res) => {
    db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(req.body.status, req.params.id);
    res.redirect(req.body.redirect || '/admin/tasks');
  });

  router.post('/tasks/:id/delete', (req, res) => {
    db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
    res.redirect(req.body.redirect || '/admin/tasks');
  });

  // Edit task
  router.get('/tasks/:id/edit', (req, res) => {
    const task = safeGet('SELECT t.*, c.name as company_name FROM tasks t LEFT JOIN companies c ON t.company_id = c.id WHERE t.id = ?', [req.params.id]);
    if (!task) return res.redirect('/admin/tasks');
    const companies = safeAll('SELECT id, name FROM companies ORDER BY name');
    const allPeople = [{name:'admin'}].concat(safeAll("SELECT DISTINCT name FROM company_users WHERE name IS NOT NULL AND name != '' ORDER BY name"));
    res.render(V('task-edit'), { user: req.session.user, task, companies, allPeople, settings: getSettings(), page: 'tasks' });
  });

  router.post('/tasks/:id/edit', (req, res) => {
    const { title, description, company_id, priority, due_date, assigned_to, status } = req.body;
    db.prepare('UPDATE tasks SET title=?, description=?, company_id=?, priority=?, due_date=?, assigned_to=?, status=? WHERE id=?').run(
      title, description, company_id || null, priority || 'medium', due_date || null, assigned_to || null, status || 'todo', req.params.id
    );
    res.redirect(req.body.redirect || '/admin/tasks');
  });

  // === GENERIC RECORD EDIT (contacts, users, servers, subs, assets, inventory) ===
  router.get('/companies/:cid/:table/:itemId/edit', (req, res) => {
    const { cid, table, itemId } = req.params;
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(cid);
    if (!company) return res.redirect('/admin/companies');
    const dbTable = table === 'users' ? 'company_users' : table;
    const item = safeGet('SELECT * FROM ' + dbTable + ' WHERE id = ? AND company_id = ?', [itemId, cid]);
    if (!item) return res.redirect('/admin/companies/' + cid + '?tab=' + table);
    const companyUsers = safeAll('SELECT id, name FROM company_users WHERE company_id = ?', [cid]);
    const inventoryItems = safeAll('SELECT id, name FROM inventory WHERE company_id = ?', [cid]);
    const roles = safeAll('SELECT * FROM roles ORDER BY sort_order');
    const depts = safeAll('SELECT * FROM departments ORDER BY sort_order');
    const locations = safeAll('SELECT * FROM inventory_locations WHERE company_id = ? ORDER BY name', [cid]);
    res.render(V('record-edit'), { user: req.session.user, company, table, dbTable, item, companyUsers, inventoryItems, roles, depts, locations, settings: getSettings(), page: 'companies' });
  });

  router.post('/companies/:cid/:table/:itemId/edit', (req, res) => {
    const { cid, table, itemId } = req.params;
    const dbTable = table === 'users' ? 'company_users' : table;
    const editableFields = {
      contacts: ['name','role','email','phone','is_primary'],
      company_users: ['name','title','email','phone','department','role','manager_id','email_account','hire_date','photo_url','is_active'],
      servers: ['name','type','os','ip','purpose','location','is_active','notes'],
      subscriptions: ['name','vendor','type','seats','cost_per_unit','billing_cycle','renewal_date','auto_renew','notes'],
      assets: ['name','type','provider','expires_at','login_url','notes'],
      inventory: ['name','type','manufacturer','model','serial_number','quantity','cost','location_id','assigned_to','purchase_date','warranty_expires','condition','notes']
    };
    const fields = editableFields[dbTable];
    if (!fields) return res.redirect('/admin/companies/' + cid + '?tab=' + table);
    const sets = fields.map(f => f + '=?').join(',');
    const vals = fields.map(f => {
      if (f === 'is_active' || f === 'auto_renew' || f === 'is_primary') return req.body[f] ? 1 : 0;
      if (f === 'seats' || f === 'cost_per_unit' || f === 'cost') return parseFloat(req.body[f]) || 0;
      if (f === 'quantity') return parseInt(req.body[f]) || 1;
      if (f === 'manager_id' || f === 'location_id') return req.body[f] ? parseInt(req.body[f]) : null;
      return req.body[f] || null;
    });
    vals.push(itemId, cid);
    db.prepare('UPDATE ' + dbTable + ' SET ' + sets + ' WHERE id=? AND company_id=?').run(...vals);
    res.redirect('/admin/companies/' + cid + '?tab=' + table);
  });

  // === PROJECTS ===
  router.get('/projects', (req, res) => {
    const projects = safeAll('SELECT p.*, c.name as company_name FROM projects p LEFT JOIN companies c ON p.company_id = c.id ORDER BY p.status ASC, p.due_date ASC');
    projects.forEach(p => {
      const counts = safeAll('SELECT status, COUNT(*) as cnt FROM tasks WHERE project_id = ? GROUP BY status', [p.id]);
      p.taskTotal = counts.reduce((s, c) => s + c.cnt, 0);
      p.taskDone = (counts.find(c => c.status === 'done') || {}).cnt || 0;
    });
    const companies = safeAll('SELECT id, name FROM companies ORDER BY name');
    const statuses = safeAll('SELECT * FROM project_statuses ORDER BY sort_order');
    res.render(V('projects'), { user: req.session.user, projects, companies, statuses, settings: getSettings(), page: 'projects' });
  });

  router.post('/projects', (req, res) => {
    const { name, description, company_id, status, start_date, due_date, budget } = req.body;
    db.prepare('INSERT INTO projects (name, description, company_id, status, start_date, due_date, budget) VALUES (?,?,?,?,?,?,?)').run(
      name, description, company_id || null, status || 'planning', start_date || null, due_date || null, parseFloat(budget) || 0
    );
    res.redirect('/admin/projects');
  });

  router.get('/projects/:id', (req, res) => {
    const project = safeGet('SELECT p.*, c.name as company_name FROM projects p LEFT JOIN companies c ON p.company_id = c.id WHERE p.id = ?', [req.params.id]);
    if (!project) return res.redirect('/admin/projects');
    const tasks = safeAll("SELECT * FROM tasks WHERE project_id = ? ORDER BY CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, due_date ASC", [project.id]);
    const companies = safeAll('SELECT id, name FROM companies ORDER BY name');
    const statuses = safeAll('SELECT * FROM project_statuses ORDER BY sort_order');
    res.render(V('project-detail'), { user: req.session.user, project, tasks, companies, statuses, settings: getSettings(), page: 'projects' });
  });

  router.post('/projects/:id/update', (req, res) => {
    const { status } = req.body;
    db.prepare('UPDATE projects SET status = ? WHERE id = ?').run(status, req.params.id);
    res.redirect('/admin/projects/' + req.params.id);
  });

  router.post('/projects/:id/delete', (req, res) => {
    db.prepare('DELETE FROM tasks WHERE project_id = ?').run(req.params.id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
    res.redirect('/admin/projects');
  });

  // Add task to project
  router.post('/projects/:id/tasks', (req, res) => {
    const { title, description, priority, due_date, assigned_to } = req.body;
    const project = db.prepare('SELECT company_id FROM projects WHERE id = ?').get(req.params.id);
    db.prepare('INSERT INTO tasks (title, description, company_id, project_id, priority, due_date, assigned_to, status) VALUES (?,?,?,?,?,?,?,?)').run(
      title, description, project ? project.company_id : null, req.params.id, priority || 'medium', due_date || null, assigned_to || null, 'todo'
    );
    res.redirect('/admin/projects/' + req.params.id);
  });

  // === COMPANIES ===
  router.get('/companies', (req, res) => {
    let companies;
    try {
      companies = db.prepare(`SELECT c.*,
        (SELECT COUNT(*) FROM company_users WHERE company_id = c.id) as user_count,
        (SELECT COUNT(*) FROM servers WHERE company_id = c.id) as server_count,
        (SELECT COUNT(*) FROM subscriptions WHERE company_id = c.id) as sub_count,
        (SELECT COUNT(*) FROM tasks WHERE company_id = c.id AND status != 'done') as task_count
        FROM companies c ORDER BY c.name`).all();
    } catch(e) {
      companies = safeAll('SELECT c.*, 0 as user_count, 0 as server_count, 0 as sub_count, 0 as task_count FROM companies c ORDER BY c.name');
    }
    res.render(V('companies'), { user: req.session.user, companies, settings: getSettings(), page: 'companies' });
  });

  router.post('/companies', (req, res) => {
    const { name, status, address, city, state, zip, notes, contact_name, contact_email, contact_phone, client_username, client_password } = req.body;
    const result = db.prepare('INSERT INTO companies (name, status, address, city, state, zip, notes) VALUES (?,?,?,?,?,?,?)').run(name, status || 'active', address, city, state, zip, notes);
    const companyId = result.lastInsertRowid;
    if (contact_name) {
      db.prepare('INSERT INTO contacts (company_id, name, email, phone, is_primary) VALUES (?,?,?,?,1)').run(companyId, contact_name, contact_email, contact_phone);
    }
    if (client_username && client_password) {
      const hash = bcrypt.hashSync(client_password, 10);
      db.prepare('INSERT INTO users (username, password, role, company_id, full_name, email) VALUES (?,?,?,?,?,?)').run(client_username, hash, 'client', companyId, contact_name || client_username, contact_email);
    }
    res.redirect('/admin/companies/' + companyId);
  });

  router.get('/companies/:id', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
    if (!company) return res.redirect('/admin/companies');
    const tab = req.query.tab || 'overview';
    const contacts = safeAll('SELECT * FROM contacts WHERE company_id = ? ORDER BY is_primary DESC, name', [company.id]);
    const users = safeAll('SELECT * FROM company_users WHERE company_id = ? ORDER BY name', [company.id]);
    const servers = safeAll('SELECT * FROM servers WHERE company_id = ? ORDER BY name', [company.id]);
    const subs = safeAll('SELECT * FROM subscriptions WHERE company_id = ? ORDER BY name', [company.id]);
    const assets = safeAll('SELECT * FROM assets WHERE company_id = ? ORDER BY name', [company.id]);
    const inventory = safeAll('SELECT i.*, il.name as location_name FROM inventory i LEFT JOIN inventory_locations il ON i.location_id = il.id WHERE i.company_id = ? ORDER BY i.name', [company.id]);
    const locations = safeAll('SELECT * FROM inventory_locations WHERE company_id = ? ORDER BY name', [company.id]);
    const agreements = safeAll('SELECT a.*, s.name as service_name, s.base_price FROM agreements a LEFT JOIN services s ON a.service_id = s.id WHERE a.company_id = ? ORDER BY a.start_date DESC', [company.id]);
    const invoices = safeAll('SELECT * FROM invoices WHERE company_id = ? ORDER BY date DESC', [company.id]);
    const tasks = safeAll("SELECT * FROM tasks WHERE company_id = ? ORDER BY CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, due_date ASC", [company.id]);
    const clientUsers = safeAll('SELECT * FROM users WHERE company_id = ? AND role = ?', [company.id, 'client']);
    const allServices = safeAll('SELECT * FROM services WHERE is_active = 1 ORDER BY name');
    const allPeople = [{name:'admin'}].concat(safeAll("SELECT DISTINCT name FROM company_users WHERE name IS NOT NULL AND name != '' ORDER BY name"));
    const roles = safeAll('SELECT * FROM roles ORDER BY sort_order');
    const depts = safeAll('SELECT * FROM departments ORDER BY sort_order');
    const imported = req.query.imported || null;
    const importError = req.query.importError || null;
    res.render(V('company-detail'), { user: req.session.user, company, tab, contacts, users, servers, subs, assets, inventory, locations, agreements, invoices, tasks, clientUsers, allServices, allPeople, roles, depts, imported, importError, settings: getSettings(), page: 'companies' });
  });

  router.post('/companies/:id/delete', (req, res) => {
    db.prepare('DELETE FROM companies WHERE id = ?').run(req.params.id);
    db.prepare('DELETE FROM users WHERE company_id = ?').run(req.params.id);
    db.prepare('DELETE FROM tasks WHERE company_id = ?').run(req.params.id);
    res.redirect('/admin/companies');
  });

  // === EMAIL PROVIDER SECURITY (must be before generic /:id/:table) ===
  router.get('/companies/:cid/email-security', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.cid);
    if (!company) return res.redirect('/admin/companies');
    const providers = safeAll('SELECT * FROM email_providers WHERE company_id = ? ORDER BY provider', [company.id]);
    res.render(V('email-security'), { user: req.session.user, company, providers, settings: getSettings(), page: 'companies' });
  });

  router.post('/companies/:cid/email-providers', (req, res) => {
    const { provider, domain, admin_url, mfa_enabled, spf_configured, dkim_configured, dmarc_configured, backup_codes_stored, password_policy, retention_days, notes } = req.body;
    try {
      db.prepare('INSERT INTO email_providers (company_id, provider, domain, admin_url, mfa_enabled, spf_configured, dkim_configured, dmarc_configured, backup_codes_stored, password_policy, retention_days, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
        req.params.cid, provider, domain, admin_url, mfa_enabled ? 1 : 0, spf_configured ? 1 : 0, dkim_configured ? 1 : 0, dmarc_configured ? 1 : 0, backup_codes_stored ? 1 : 0, password_policy, parseInt(retention_days) || 0, notes
      );
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/email-security');
  });

  router.post('/companies/:cid/email-providers/:eid/edit', (req, res) => {
    const { provider, domain, admin_url, mfa_enabled, spf_configured, dkim_configured, dmarc_configured, backup_codes_stored, password_policy, retention_days, notes, last_audit_date } = req.body;
    try {
      db.prepare('UPDATE email_providers SET provider=?, domain=?, admin_url=?, mfa_enabled=?, spf_configured=?, dkim_configured=?, dmarc_configured=?, backup_codes_stored=?, password_policy=?, retention_days=?, notes=?, last_audit_date=? WHERE id=? AND company_id=?').run(
        provider, domain, admin_url, mfa_enabled ? 1 : 0, spf_configured ? 1 : 0, dkim_configured ? 1 : 0, dmarc_configured ? 1 : 0, backup_codes_stored ? 1 : 0, password_policy, parseInt(retention_days) || 0, notes, last_audit_date || null, req.params.eid, req.params.cid
      );
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/email-security');
  });

  router.post('/companies/:cid/email-providers/:eid/delete', (req, res) => {
    try { db.prepare('DELETE FROM email_providers WHERE id = ? AND company_id = ?').run(req.params.eid, req.params.cid); } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/email-security');
  });

  // === COMPANY LOGO ===
  router.post('/companies/:id/logo', (req, res) => {
    const { logo_url } = req.body;
    db.prepare('UPDATE companies SET logo = ? WHERE id = ?').run(logo_url || null, req.params.id);
    res.redirect('/admin/companies/' + req.params.id + '?tab=overview');
  });

  // Generic CRUD for company sub-items
  const tables = {
    contacts: ['company_id','name','role','email','phone','is_primary'],
    company_users: ['company_id','name','title','email','phone','department','role','manager_id','email_account','hire_date','notes'],
    servers: ['company_id','name','type','os','ip','purpose','location','notes'],
    subscriptions: ['company_id','name','vendor','type','seats','cost_per_unit','billing_cycle','renewal_date','notes'],
    assets: ['company_id','name','type','provider','expires_at','login_url','notes'],
    inventory: ['company_id','name','type','manufacturer','model','serial_number','quantity','cost','location_id','assigned_to','purchase_date','warranty_expires','condition','notes']
  };

  router.post('/companies/:id/:table', (req, res) => {
    const table = req.params.table;
    if (table === 'tasks') {
      // Company task
      const { title, description, priority, due_date, assigned_to, related_table, related_id } = req.body;
      db.prepare('INSERT INTO tasks (title, description, company_id, related_table, related_id, priority, due_date, assigned_to, status) VALUES (?,?,?,?,?,?,?,?,?)').run(
        title, description, req.params.id, related_table || null, related_id || null, priority || 'medium', due_date || null, assigned_to || null, 'todo'
      );
      return res.redirect('/admin/companies/' + req.params.id + '?tab=tasks');
    }
    if (table === 'agreements') {
      const { service_id, custom_price, billing_cycle, start_date, notes } = req.body;
      db.prepare('INSERT INTO agreements (company_id, service_id, custom_price, billing_cycle, start_date, notes, is_active) VALUES (?,?,?,?,?,?,1)').run(req.params.id, service_id, custom_price || null, billing_cycle, start_date, notes);
      return res.redirect('/admin/companies/' + req.params.id + '?tab=agreements');
    }
    if (table === 'client-users') {
      const { username, password, full_name, email } = req.body;
      if (!username || !password) return res.redirect('/admin/companies/' + req.params.id + '?tab=overview');
      const hash = bcrypt.hashSync(password, 10);
      db.prepare('INSERT INTO users (username, password, role, company_id, full_name, email, is_active) VALUES (?,?,?,?,?,?,1)').run(username, hash, 'client', req.params.id, full_name, email);
      return res.redirect('/admin/companies/' + req.params.id + '?tab=overview');
    }
    const cols = tables[table];
    if (!cols) return res.status(400).send('Invalid table');
    const vals = cols.map(c => {
      if (c === 'company_id') return req.params.id;
      if (c === 'quantity') return parseInt(req.body[c]) || 1;
      if (c === 'cost' || c === 'cost_per_unit') return parseFloat(req.body[c]) || 0;
      if (c === 'location_id' || c === 'manager_id') return req.body[c] ? parseInt(req.body[c]) : null;
      if (c === 'is_primary') return req.body[c] ? 1 : 0;
      return req.body[c] || null;
    });
    const placeholders = cols.map(() => '?').join(',');
    db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`).run(...vals);
    res.redirect('/admin/companies/' + req.params.id + '?tab=' + table.replace('company_', ''));
  });

  router.post('/companies/:id/:table/:itemId/delete', (req, res) => {
    const table = req.params.table;
    if (table === 'client-users') {
      db.prepare('DELETE FROM users WHERE id = ? AND company_id = ?').run(req.params.itemId, req.params.id);
      return res.redirect('/admin/companies/' + req.params.id + '?tab=overview');
    }
    if (table === 'agreements') {
      db.prepare('DELETE FROM agreements WHERE id = ? AND company_id = ?').run(req.params.itemId, req.params.id);
      return res.redirect('/admin/companies/' + req.params.id + '?tab=agreements');
    }
    if (!tables[table]) return res.status(400).send('Invalid');
    db.prepare(`DELETE FROM ${table} WHERE id = ? AND company_id = ?`).run(req.params.itemId, req.params.id);
    res.redirect('/admin/companies/' + req.params.id + '?tab=' + table.replace('company_', ''));
  });

  // === SERVICES ===
  router.get('/services', (req, res) => {
    const services = db.prepare('SELECT * FROM services ORDER BY name').all();
    res.render(V('services'), { user: req.session.user, services, settings: getSettings(), page: 'services' });
  });

  router.post('/services', (req, res) => {
    const { name, category, description, price_type, base_price, is_public } = req.body;
    db.prepare('INSERT INTO services (name, category, description, price_type, base_price, is_public) VALUES (?,?,?,?,?,?)').run(name, category, description, price_type, parseFloat(base_price) || 0, is_public ? 1 : 0);
    res.redirect('/admin/services');
  });

  router.post('/services/:id/delete', (req, res) => {
    db.prepare('DELETE FROM services WHERE id = ?').run(req.params.id);
    res.redirect('/admin/services');
  });

  router.get('/services/:id/edit', (req, res) => {
    const svc = safeGet('SELECT * FROM services WHERE id = ?', [req.params.id]);
    if (!svc) return res.redirect('/admin/services');
    res.render(V('service-edit'), { user: req.session.user, svc, settings: getSettings(), page: 'services' });
  });

  router.post('/services/:id/edit', (req, res) => {
    const { name, category, description, price_type, base_price, is_public, is_active } = req.body;
    db.prepare('UPDATE services SET name=?, category=?, description=?, price_type=?, base_price=?, is_public=?, is_active=? WHERE id=?').run(
      name, category, description, price_type, parseFloat(base_price) || 0, is_public ? 1 : 0, is_active ? 1 : 0, req.params.id
    );
    res.redirect('/admin/services');
  });

  // === BILLING ===
  router.get('/billing', (req, res) => {
    const invoices = db.prepare('SELECT i.*, c.name as company_name FROM invoices i LEFT JOIN companies c ON i.company_id = c.id ORDER BY i.date DESC').all();
    const companies = db.prepare('SELECT id, name FROM companies WHERE status = ? ORDER BY name').all('active');
    res.render(V('billing'), { user: req.session.user, invoices, companies, settings: getSettings(), page: 'billing' });
  });

  router.post('/invoices', (req, res) => {
    const { company_id, date, due_date, description, amount, status } = req.body;
    const total = parseFloat(amount) || 0;
    const invNum = 'INV-' + Date.now().toString(36).toUpperCase();
    const result = db.prepare('INSERT INTO invoices (company_id, invoice_number, date, due_date, subtotal, total, status) VALUES (?,?,?,?,?,?,?)').run(company_id, invNum, date, due_date, total, total, status || 'sent');
    db.prepare('INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total) VALUES (?,?,1,?,?)').run(result.lastInsertRowid, description, total, total);
    res.redirect(req.body.redirect || '/admin/billing');
  });

  router.post('/invoices/:id/pay', (req, res) => {
    db.prepare("UPDATE invoices SET status = 'paid', paid_date = datetime('now') WHERE id = ?").run(req.params.id);
    res.redirect(req.body.redirect || '/admin/billing');
  });

  router.post('/invoices/:id/delete', (req, res) => {
    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(req.params.id);
    db.prepare('DELETE FROM invoices WHERE id = ?').run(req.params.id);
    res.redirect(req.body.redirect || '/admin/billing');
  });

  // === SETTINGS ===
  router.get('/settings', (req, res) => {
    const currentUser = safeGet('SELECT totp_enabled FROM users WHERE id = ?', [req.session.user.id]);
    const has2fa = !!(currentUser && currentUser.totp_enabled);
    res.render(V('settings'), { user: req.session.user, has2fa, settings: getSettings(), page: 'settings' });
  });

  router.post('/settings', (req, res) => {
    const { business_name, business_email, business_phone } = req.body;
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('business_name', business_name);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('business_email', business_email);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('business_phone', business_phone);
    res.redirect('/admin/settings');
  });

  router.post('/settings/password', (req, res) => {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 4) return res.redirect('/admin/settings');
    const hash = bcrypt.hashSync(new_password, 10);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.session.user.id);
    res.redirect('/admin/settings');
  });

  // === 2FA SETUP ===
  router.get('/settings/2fa-setup', (req, res) => {
    const speakeasy = require('speakeasy');
    const QRCode = require('qrcode');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);

    if (user.totp_enabled && user.totp_secret) {
      // Already enabled — show manage page
      return res.render(V('2fa-setup'), {
        user: req.session.user, qrDataUrl: '', secret: '', isEnabled: true,
        settings: getSettings(), page: 'settings', error: null
      });
    }

    // Generate new secret
    const secret = speakeasy.generateSecret({ length: 20 });
    req.session.temp2faSecret = secret.base32;

    // Build otpauth URL manually for maximum compatibility
    const issuer = 'ITServicesManager';
    const accountName = (user.username || 'admin');
    const otpauthUrl = 'otpauth://totp/' + encodeURIComponent(issuer) + ':' + encodeURIComponent(accountName) + '?secret=' + secret.base32 + '&issuer=' + encodeURIComponent(issuer) + '&algorithm=SHA1&digits=6&period=30';

    console.log('  2FA setup URL:', otpauthUrl);

    QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: 'M', margin: 2, width: 256 }, function(err, qrDataUrl) {
      if (err) console.error('  QR error:', err.message);
      res.render(V('2fa-setup'), {
        user: req.session.user,
        qrDataUrl: qrDataUrl || '',
        secret: secret.base32,
        isEnabled: false,
        settings: getSettings(),
        page: 'settings',
        error: null
      });
    });
  });

  router.post('/settings/2fa-enable', (req, res) => {
    const speakeasy = require('speakeasy');
    const { token } = req.body;
    const tempSecret = req.session.temp2faSecret;
    if (!tempSecret) return res.redirect('/admin/settings/2fa-setup');
    // Verify the token before enabling
    const verified = speakeasy.totp.verify({
      secret: tempSecret,
      encoding: 'base32',
      token: token,
      window: 1
    });
    if (!verified) {
      const QRCode = require('qrcode');
      const issuer = 'ITServicesManager';
      const accountName = req.session.user.username || 'admin';
      const otpauthUrl = 'otpauth://totp/' + encodeURIComponent(issuer) + ':' + encodeURIComponent(accountName) + '?secret=' + tempSecret + '&issuer=' + encodeURIComponent(issuer) + '&algorithm=SHA1&digits=6&period=30';
      QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: 'M', margin: 2, width: 256 }, function(err, qrDataUrl) {
        res.render(V('2fa-setup'), {
          user: req.session.user,
          qrDataUrl: qrDataUrl || '',
          secret: tempSecret,
          isEnabled: false,
          settings: getSettings(),
          page: 'settings',
          error: 'Invalid code. Make sure you scanned the correct QR code and enter the current 6-digit code.'
        });
      });
      return;
    }
    // Save secret to database
    try {
      db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?').run(tempSecret, req.session.user.id);
      delete req.session.temp2faSecret;
    } catch(e) { console.error('2FA enable error:', e.message); }
    res.redirect('/admin/settings');
  });

  router.post('/settings/2fa-disable', (req, res) => {
    const speakeasy = require('speakeasy');
    const { token } = req.body;
    if (!token) return res.redirect('/admin/settings/2fa-setup');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
    if (!user || !user.totp_secret) return res.redirect('/admin/settings');
    const verified = speakeasy.totp.verify({
      secret: user.totp_secret,
      encoding: 'base32',
      token: token,
      window: 1
    });
    if (!verified) {
      // Show error on the 2FA setup page
      return res.render(V('2fa-setup'), {
        user: req.session.user, qrDataUrl: '', secret: '', isEnabled: true,
        settings: getSettings(), page: 'settings',
        error: 'Invalid code. Enter your current authenticator code to disable 2FA.'
      });
    }
    try {
      db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?').run(req.session.user.id);
    } catch(e) {}
    res.redirect('/admin/settings');
  });

  // === PROJECT STATUSES ===
  router.get('/project-statuses', (req, res) => {
    const statuses = safeAll('SELECT * FROM project_statuses ORDER BY sort_order');
    res.render(V('project-statuses'), { user: req.session.user, statuses, settings: getSettings(), page: 'projects' });
  });

  router.post('/project-statuses', (req, res) => {
    const { name, color } = req.body;
    if (!name) return res.redirect('/admin/project-statuses');
    const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM project_statuses').get();
    db.prepare('INSERT OR IGNORE INTO project_statuses (name, color, sort_order) VALUES (?,?,?)').run(name.trim(), color || '#64748b', (maxOrder.m || 0) + 1);
    res.redirect('/admin/project-statuses');
  });

  router.post('/project-statuses/:id/delete', (req, res) => {
    db.prepare('DELETE FROM project_statuses WHERE id = ?').run(req.params.id);
    res.redirect('/admin/project-statuses');
  });


  // === EQUIPMENT MONITORING ===
  router.get('/monitoring', (req, res) => {
    const monitors = safeAll('SELECT m.*, c.name as company_name FROM equipment_monitors m LEFT JOIN companies c ON m.company_id = c.id ORDER BY m.last_status DESC, m.name');
    const companies = safeAll('SELECT id, name FROM companies ORDER BY name');
    res.render(V('monitoring'), { user: req.session.user, monitors, companies, settings: getSettings(), page: 'monitoring' });
  });

  router.post('/monitoring', (req, res) => {
    const { company_id, name, type, target, check_type, interval_min, alert_email, notes } = req.body;
    try {
      db.prepare('INSERT INTO equipment_monitors (company_id, name, type, target, check_type, interval_min, alert_email, notes) VALUES (?,?,?,?,?,?,?,?)').run(
        company_id ? parseInt(company_id) : null, name, type || 'server', target, check_type || 'ping', parseInt(interval_min) || 5, alert_email || null, notes || null
      );
    } catch(e) { console.error('Monitor create error:', e.message); }
    res.redirect('/admin/monitoring');
  });

  // Helper: run a single monitor check
  async function runCheck(mon) {
    const httpMod = require('http');
    const httpsMod = require('https');
    const net = require('net');
    let status = 'down', responseMs = 0, error = null;
    const start = Date.now();
    const target = (mon.target || '').trim();
    if (!target) return { status: 'down', responseMs: 0, error: 'No target specified' };

    try {
      if (mon.check_type === 'http' || mon.check_type === 'https' || target.startsWith('http')) {
        const url = target.startsWith('http') ? target : (mon.check_type === 'https' ? 'https://' : 'http://') + target;
        const mod = url.startsWith('https') ? httpsMod : httpMod;
        await new Promise((resolve) => {
          const r = mod.get(url, { timeout: 8000, rejectUnauthorized: false }, (resp) => {
            responseMs = Date.now() - start;
            status = (resp.statusCode >= 200 && resp.statusCode < 500) ? 'up' : 'down';
            if (status === 'down') error = 'HTTP ' + resp.statusCode;
            resp.resume();
            resolve();
          });
          r.on('error', (e) => { responseMs = Date.now() - start; error = e.message; resolve(); });
          r.on('timeout', () => { r.destroy(); responseMs = Date.now() - start; error = 'Timeout (8s)'; resolve(); });
        });
      } else {
        // TCP port check — for IP addresses, routers, servers
        const parts = target.split(':');
        const host = parts[0];
        const port = parseInt(parts[1]) || (mon.check_type === 'port' ? 22 : 80);
        await new Promise((resolve) => {
          const sock = new net.Socket();
          sock.setTimeout(5000);
          sock.on('connect', () => { responseMs = Date.now() - start; status = 'up'; sock.destroy(); resolve(); });
          sock.on('error', (e) => { responseMs = Date.now() - start; error = e.message; resolve(); });
          sock.on('timeout', () => { sock.destroy(); responseMs = Date.now() - start; error = 'Timeout (5s)'; resolve(); });
          sock.connect(port, host);
        });
      }
    } catch (e) {
      error = e.message;
      responseMs = Date.now() - start;
    }
    return { status, responseMs, error };
  }

  function saveCheckResult(monId, result) {
    try {
      db.prepare("UPDATE equipment_monitors SET last_check = datetime('now'), last_status = ?, last_response_ms = ? WHERE id = ?").run(result.status, result.responseMs, monId);
      db.prepare('INSERT INTO monitor_logs (monitor_id, status, response_ms, error) VALUES (?,?,?,?)').run(monId, result.status, result.responseMs, result.error);
      const total = db.prepare('SELECT COUNT(*) as c FROM monitor_logs WHERE monitor_id = ?').get(monId);
      const upCount = db.prepare("SELECT COUNT(*) as c FROM monitor_logs WHERE monitor_id = ? AND status = 'up'").get(monId);
      const uptimePct = total.c > 0 ? (upCount.c / total.c * 100) : 0;
      db.prepare('UPDATE equipment_monitors SET uptime_pct = ? WHERE id = ?').run(uptimePct, monId);
    } catch(e) { console.error('Monitor save error:', e.message); }
  }

  // Check ALL monitors — MUST be before /:id routes
  router.post('/monitoring/check-all', async (req, res) => {
    const monitors = safeAll('SELECT * FROM equipment_monitors WHERE is_active = 1');
    for (const mon of monitors) {
      try {
        const result = await runCheck(mon);
        saveCheckResult(mon.id, result);
      } catch(e) { console.error('Check-all error for', mon.name, ':', e.message); }
    }
    res.redirect('/admin/monitoring');
  });

  // Check single monitor
  router.post('/monitoring/:id/check', async (req, res) => {
    try {
      const mon = db.prepare('SELECT * FROM equipment_monitors WHERE id = ?').get(req.params.id);
      if (!mon) return res.redirect('/admin/monitoring');
      const result = await runCheck(mon);
      saveCheckResult(mon.id, result);
    } catch(e) { console.error('Check error:', e.message); }
    res.redirect('/admin/monitoring');
  });

  router.post('/monitoring/:id/delete', (req, res) => {
    try {
      db.prepare('DELETE FROM monitor_logs WHERE monitor_id = ?').run(req.params.id);
      db.prepare('DELETE FROM equipment_monitors WHERE id = ?').run(req.params.id);
    } catch(e) { console.error('Monitor delete error:', e.message); }
    res.redirect('/admin/monitoring');
  });

  // === ALL USERS (across all companies) ===
  router.get('/all-users', (req, res) => {
    const users = safeAll("SELECT cu.*, c.name as company_name FROM company_users cu LEFT JOIN companies c ON cu.company_id = c.id ORDER BY c.name, cu.name");
    const companies = safeAll('SELECT id, name FROM companies ORDER BY name');
    const filterCompany = req.query.company || '';
    const filterDept = req.query.dept || '';
    const search = req.query.q || '';
    let filtered = users;
    if (filterCompany) filtered = filtered.filter(u => u.company_id == filterCompany);
    if (filterDept) filtered = filtered.filter(u => u.department === filterDept);
    if (search) { const s = search.toLowerCase(); filtered = filtered.filter(u => (u.name||'').toLowerCase().includes(s) || (u.email||'').toLowerCase().includes(s) || (u.email_account||'').toLowerCase().includes(s) || (u.phone||'').includes(s)); }
    const depts = [...new Set(users.map(u => u.department).filter(Boolean))].sort();
    const totalEmails = users.filter(u => u.email_account).length;
    const totalPhones = users.filter(u => u.phone).length;
    const activeCount = users.filter(u => u.is_active).length;
    res.render(V('all-users'), { user: req.session.user, users: filtered, allUsers: users, companies, depts, filterCompany, filterDept, search, totalEmails, totalPhones, activeCount, settings: getSettings(), page: 'all-users' });
  });

  router.get('/monitoring/:id/history', (req, res) => {
    const mon = safeGet('SELECT m.*, c.name as company_name FROM equipment_monitors m LEFT JOIN companies c ON m.company_id = c.id WHERE m.id = ?', [req.params.id]);
    if (!mon) return res.redirect('/admin/monitoring');
    const logs = safeAll('SELECT * FROM monitor_logs WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT 100', [req.params.id]);
    res.render(V('monitor-history'), { user: req.session.user, mon, logs, settings: getSettings(), page: 'monitoring' });
  });

  // === SERVICE SCHEDULE ===
  router.get('/schedule', (req, res) => {
    const filterCompany = req.query.company || '';
    let where = filterCompany ? 'WHERE ss.company_id = ' + parseInt(filterCompany) : '';
    const schedules = safeAll(`SELECT ss.*, c.name as company_name, s.name as service_name FROM service_schedule ss LEFT JOIN companies c ON ss.company_id = c.id LEFT JOIN services s ON ss.service_id = s.id ${where} ORDER BY CASE ss.frequency WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 WHEN 'biweekly' THEN 3 WHEN 'monthly' THEN 4 WHEN 'quarterly' THEN 5 WHEN 'yearly' THEN 6 ELSE 7 END, ss.next_due ASC`);
    const companies = safeAll('SELECT id, name FROM companies ORDER BY name');
    const services = safeAll('SELECT id, name FROM services WHERE is_active = 1 ORDER BY name');
    const allPeople = [{name:'admin'}].concat(safeAll("SELECT DISTINCT name FROM company_users WHERE name IS NOT NULL AND name != '' ORDER BY name"));
    // Overdue count
    const today = new Date().toISOString().slice(0,10);
    const overdue = schedules.filter(s => s.is_active && s.next_due && s.next_due < today);
    const upcoming = schedules.filter(s => s.is_active && s.next_due && s.next_due >= today && s.next_due <= new Date(Date.now()+7*86400000).toISOString().slice(0,10));
    res.render(V('schedule'), { user: req.session.user, schedules, companies, services, allPeople, filterCompany, overdue, upcoming, today, settings: getSettings(), page: 'schedule' });
  });

  router.post('/schedule', (req, res) => {
    const { company_id, service_id, title, description, frequency, day_of_month, day_of_week, time_slot, assigned_to, next_due, notes } = req.body;
    db.prepare('INSERT INTO service_schedule (company_id, service_id, title, description, frequency, day_of_month, day_of_week, time_slot, assigned_to, next_due, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      company_id, service_id || null, title, description, frequency || 'monthly', parseInt(day_of_month) || 1, day_of_week, time_slot, assigned_to, next_due, notes
    );
    res.redirect('/admin/schedule');
  });

  router.post('/schedule/:id/complete', (req, res) => {
    const sched = safeGet('SELECT * FROM service_schedule WHERE id = ?', [req.params.id]);
    if (!sched) return res.redirect('/admin/schedule');
    const today = new Date().toISOString().slice(0,10);
    // Calculate next due based on frequency
    var nextDue = '';
    var d = new Date();
    if (sched.frequency === 'daily') { d.setDate(d.getDate()+1); nextDue = d.toISOString().slice(0,10); }
    else if (sched.frequency === 'weekly') { d.setDate(d.getDate()+7); nextDue = d.toISOString().slice(0,10); }
    else if (sched.frequency === 'biweekly') { d.setDate(d.getDate()+14); nextDue = d.toISOString().slice(0,10); }
    else if (sched.frequency === 'monthly') { d.setMonth(d.getMonth()+1); nextDue = d.toISOString().slice(0,10); }
    else if (sched.frequency === 'quarterly') { d.setMonth(d.getMonth()+3); nextDue = d.toISOString().slice(0,10); }
    else if (sched.frequency === 'yearly') { d.setFullYear(d.getFullYear()+1); nextDue = d.toISOString().slice(0,10); }
    db.prepare('UPDATE service_schedule SET last_completed = ?, next_due = ? WHERE id = ?').run(today, nextDue, sched.id);
    res.redirect('/admin/schedule');
  });

  router.post('/schedule/:id/delete', (req, res) => {
    db.prepare('DELETE FROM service_schedule WHERE id = ?').run(req.params.id);
    res.redirect('/admin/schedule');
  });

  router.get('/schedule/:id/edit', (req, res) => {
    const sched = safeGet('SELECT ss.*, c.name as company_name FROM service_schedule ss LEFT JOIN companies c ON ss.company_id = c.id WHERE ss.id = ?', [req.params.id]);
    if (!sched) return res.redirect('/admin/schedule');
    const companies = safeAll('SELECT id, name FROM companies ORDER BY name');
    const services = safeAll('SELECT id, name FROM services WHERE is_active = 1 ORDER BY name');
    const allPeople = [{name:'admin'}].concat(safeAll("SELECT DISTINCT name FROM company_users WHERE name IS NOT NULL AND name != '' ORDER BY name"));
    res.render(V('schedule-edit'), { user: req.session.user, sched, companies, services, allPeople, settings: getSettings(), page: 'schedule' });
  });

  router.post('/schedule/:id/edit', (req, res) => {
    const { company_id, service_id, title, description, frequency, day_of_month, day_of_week, time_slot, assigned_to, next_due, is_active, notes } = req.body;
    db.prepare('UPDATE service_schedule SET company_id=?, service_id=?, title=?, description=?, frequency=?, day_of_month=?, day_of_week=?, time_slot=?, assigned_to=?, next_due=?, is_active=?, notes=? WHERE id=?').run(
      company_id, service_id || null, title, description, frequency, parseInt(day_of_month) || 1, day_of_week, time_slot, assigned_to, next_due, is_active ? 1 : 0, notes, req.params.id
    );
    res.redirect('/admin/schedule');
  });

  // === SOPs (expanded) ===
  router.get('/sops', (req, res) => {
    const filterCo = req.query.company || '';
    const filterCat = req.query.category || '';
    const filterDept = req.query.dept || '';
    const filterRole = req.query.role || '';
    let where = [];
    if (filterCo) where.push('s.company_id = ' + parseInt(filterCo));
    if (filterCat) where.push("s.category = '" + filterCat.replace(/'/g,'') + "'");
    if (filterDept) where.push("s.department = '" + filterDept.replace(/'/g,'') + "'");
    if (filterRole) where.push("s.target_role = '" + filterRole.replace(/'/g,'') + "'");
    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const sops = safeAll('SELECT s.*, c.name as company_name FROM sops s LEFT JOIN companies c ON s.company_id = c.id ' + whereStr + ' ORDER BY s.is_template DESC, s.title');
    const companies = safeAll('SELECT id, name FROM companies ORDER BY name');
    const categories = [...new Set(sops.map(s => s.category).filter(Boolean))].sort();
    const depts = safeAll('SELECT * FROM departments ORDER BY sort_order');
    const roles = safeAll('SELECT * FROM roles ORDER BY sort_order');
    res.render(V('sops'), { user: req.session.user, sops, companies, categories, depts, roles, filterCo, filterCat, filterDept, filterRole, settings: getSettings(), page: 'sops' });
  });

  router.post('/sops', (req, res) => {
    const { title, sop_number, category, department, target_role, description, purpose, company_id, owner, status } = req.body;
    try {
      db.prepare('INSERT INTO sops (title, sop_number, category, department, target_role, description, purpose, company_id, owner, status) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
        title, sop_number, category, department, target_role, description, purpose, company_id || null, owner, status || 'draft'
      );
    } catch(e) { console.error('SOP create:', e.message); }
    res.redirect('/admin/sops');
  });

  router.get('/sops/:id', (req, res) => {
    const sop = safeGet('SELECT s.*, c.name as company_name FROM sops s LEFT JOIN companies c ON s.company_id = c.id WHERE s.id = ?', [req.params.id]);
    if (!sop) return res.redirect('/admin/sops');
    const tab = req.query.tab || 'overview';
    const steps = safeAll('SELECT * FROM sop_steps WHERE sop_id = ? ORDER BY step_number', [sop.id]);
    const revisions = safeAll('SELECT * FROM sop_revisions WHERE sop_id = ? ORDER BY date DESC', [sop.id]);
    const refs = safeAll('SELECT * FROM sop_references WHERE sop_id = ?', [sop.id]);
    const acks = safeAll('SELECT * FROM sop_acknowledgments WHERE sop_id = ? ORDER BY acknowledged_at DESC', [sop.id]);
    const companies = safeAll('SELECT id, name FROM companies ORDER BY name');
    const depts = safeAll('SELECT * FROM departments ORDER BY sort_order');
    const roles = safeAll('SELECT * FROM roles ORDER BY sort_order');
    res.render(V('sop-detail'), { user: req.session.user, sop, tab, steps, revisions, refs, acks, companies, depts, roles, settings: getSettings(), page: 'sops' });
  });

  router.post('/sops/:id/edit', (req, res) => {
    const b = req.body;
    try {
      db.prepare("UPDATE sops SET title=?, sop_number=?, category=?, department=?, target_role=?, purpose=?, scope_applies=?, scope_excludes=?, materials=?, equipment=?, definitions=?, safety_warnings=?, compliance_reqs=?, exceptions=?, description=?, company_id=?, owner=?, status=?, version=?, prepared_by=?, prepared_date=?, reviewed_by=?, reviewed_date=?, approved_by=?, approved_date=?, review_date=?, updated_at=datetime('now') WHERE id=?").run(
        b.title, b.sop_number, b.category, b.department, b.target_role, b.purpose, b.scope_applies, b.scope_excludes, b.materials, b.equipment, b.definitions, b.safety_warnings, b.compliance_reqs, b.exceptions, b.description, b.company_id || null, b.owner, b.status, b.version, b.prepared_by, b.prepared_date, b.reviewed_by, b.reviewed_date, b.approved_by, b.approved_date, b.review_date, req.params.id
      );
    } catch(e) { console.error('SOP edit:', e.message); }
    res.redirect('/admin/sops/' + req.params.id + '?tab=' + (req.body.redirect_tab || 'overview'));
  });

  router.post('/sops/:id/steps', (req, res) => {
    const { title, description, responsible, warning } = req.body;
    const maxStep = safeGet('SELECT MAX(step_number) as m FROM sop_steps WHERE sop_id = ?', [req.params.id]);
    try {
      db.prepare('INSERT INTO sop_steps (sop_id, step_number, title, description, responsible, warning) VALUES (?,?,?,?,?,?)').run(
        req.params.id, (maxStep && maxStep.m || 0) + 1, title, description, responsible, warning
      );
    } catch(e) {}
    res.redirect('/admin/sops/' + req.params.id + '?tab=procedures');
  });

  router.post('/sops/:id/steps/:sid/delete', (req, res) => {
    try { db.prepare('DELETE FROM sop_steps WHERE id = ? AND sop_id = ?').run(req.params.sid, req.params.id); } catch(e) {}
    res.redirect('/admin/sops/' + req.params.id + '?tab=procedures');
  });

  // Revisions
  router.post('/sops/:id/revisions', (req, res) => {
    const { version, date, changed_by, description } = req.body;
    try { db.prepare('INSERT INTO sop_revisions (sop_id, version, date, changed_by, description) VALUES (?,?,?,?,?)').run(req.params.id, version, date, changed_by, description); } catch(e) {}
    res.redirect('/admin/sops/' + req.params.id + '?tab=revisions');
  });

  router.post('/sops/:id/revisions/:rid/delete', (req, res) => {
    try { db.prepare('DELETE FROM sop_revisions WHERE id = ?').run(req.params.rid); } catch(e) {}
    res.redirect('/admin/sops/' + req.params.id + '?tab=revisions');
  });

  // References
  router.post('/sops/:id/references', (req, res) => {
    const { title, link } = req.body;
    try { db.prepare('INSERT INTO sop_references (sop_id, title, link) VALUES (?,?,?)').run(req.params.id, title, link); } catch(e) {}
    res.redirect('/admin/sops/' + req.params.id + '?tab=references');
  });

  router.post('/sops/:id/references/:rid/delete', (req, res) => {
    try { db.prepare('DELETE FROM sop_references WHERE id = ?').run(req.params.rid); } catch(e) {}
    res.redirect('/admin/sops/' + req.params.id + '?tab=references');
  });

  // Acknowledgments
  router.post('/sops/:id/acknowledge', (req, res) => {
    const { user_name, company_id } = req.body;
    try { db.prepare('INSERT INTO sop_acknowledgments (sop_id, user_name, company_id) VALUES (?,?,?)').run(req.params.id, user_name, company_id || null); } catch(e) {}
    res.redirect('/admin/sops/' + req.params.id + '?tab=compliance');
  });

  router.post('/sops/:id/delete', (req, res) => {
    try {
      db.prepare('DELETE FROM sop_steps WHERE sop_id = ?').run(req.params.id);
      db.prepare('DELETE FROM sop_revisions WHERE sop_id = ?').run(req.params.id);
      db.prepare('DELETE FROM sop_references WHERE sop_id = ?').run(req.params.id);
      db.prepare('DELETE FROM sop_acknowledgments WHERE sop_id = ?').run(req.params.id);
      db.prepare('DELETE FROM sops WHERE id = ?').run(req.params.id);
    } catch(e) {}
    res.redirect('/admin/sops');
  });

  router.post('/sops/:id/clone', (req, res) => {
    const { company_id } = req.body;
    const sop = safeGet('SELECT * FROM sops WHERE id = ?', [req.params.id]);
    if (!sop) return res.redirect('/admin/sops');
    try {
      const r = db.prepare('INSERT INTO sops (title, sop_number, category, department, target_role, purpose, scope_applies, scope_excludes, materials, equipment, definitions, safety_warnings, compliance_reqs, exceptions, description, company_id, owner, status, version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        sop.title, sop.sop_number, sop.category, sop.department, sop.target_role, sop.purpose, sop.scope_applies, sop.scope_excludes, sop.materials, sop.equipment, sop.definitions, sop.safety_warnings, sop.compliance_reqs, sop.exceptions, sop.description, company_id || null, sop.owner, 'draft', '1.0'
      );
      const steps = safeAll('SELECT * FROM sop_steps WHERE sop_id = ? ORDER BY step_number', [sop.id]);
      steps.forEach(st => {
        db.prepare('INSERT INTO sop_steps (sop_id, step_number, title, description, responsible, warning) VALUES (?,?,?,?,?,?)').run(r.lastInsertRowid, st.step_number, st.title, st.description, st.responsible, st.warning);
      });
      res.redirect('/admin/sops/' + r.lastInsertRowid);
    } catch(e) { res.redirect('/admin/sops'); }
  });

  // === PROCESS FLOWS ===
  router.get('/flows', (req, res) => {
    const filterCo = req.query.company || '';
    let where = filterCo ? 'WHERE f.company_id = ' + parseInt(filterCo) : '';
    const flows = safeAll('SELECT f.*, c.name as company_name FROM process_flows f LEFT JOIN companies c ON f.company_id = c.id ' + where + ' ORDER BY f.is_template DESC, f.title');
    const companies = safeAll('SELECT id, name FROM companies ORDER BY name');
    res.render(V('flows'), { user: req.session.user, flows, companies, filterCo, settings: getSettings(), page: 'flows' });
  });

  router.post('/flows', (req, res) => {
    const { title, category, description, trigger_event, company_id, owner, status } = req.body;
    try {
      db.prepare('INSERT INTO process_flows (title, category, description, trigger_event, company_id, owner, status) VALUES (?,?,?,?,?,?,?)').run(
        title, category, description, trigger_event, company_id || null, owner, status || 'draft'
      );
    } catch(e) {}
    res.redirect('/admin/flows');
  });

  router.get('/flows/:id', (req, res) => {
    const flow = safeGet('SELECT f.*, c.name as company_name FROM process_flows f LEFT JOIN companies c ON f.company_id = c.id WHERE f.id = ?', [req.params.id]);
    if (!flow) return res.redirect('/admin/flows');
    const nodes = safeAll('SELECT * FROM flow_nodes WHERE flow_id = ? ORDER BY node_order', [flow.id]);
    const companies = safeAll('SELECT id, name FROM companies ORDER BY name');
    res.render(V('flow-detail'), { user: req.session.user, flow, nodes, companies, settings: getSettings(), page: 'flows' });
  });

  router.post('/flows/:id/edit', (req, res) => {
    const { title, category, description, trigger_event, company_id, owner, status } = req.body;
    try {
      db.prepare("UPDATE process_flows SET title=?, category=?, description=?, trigger_event=?, company_id=?, owner=?, status=?, updated_at=datetime('now') WHERE id=?").run(
        title, category, description, trigger_event, company_id || null, owner, status, req.params.id
      );
    } catch(e) {}
    res.redirect('/admin/flows/' + req.params.id);
  });

  router.post('/flows/:id/nodes', (req, res) => {
    const { type, label, description, responsible, yes_label, no_label } = req.body;
    const maxOrder = safeGet('SELECT MAX(node_order) as m FROM flow_nodes WHERE flow_id = ?', [req.params.id]);
    try {
      db.prepare('INSERT INTO flow_nodes (flow_id, node_order, type, label, description, responsible, yes_label, no_label) VALUES (?,?,?,?,?,?,?,?)').run(
        req.params.id, (maxOrder && maxOrder.m || 0) + 1, type || 'process', label, description, responsible, yes_label, no_label
      );
    } catch(e) {}
    res.redirect('/admin/flows/' + req.params.id);
  });

  router.post('/flows/:id/nodes/:nid/delete', (req, res) => {
    try { db.prepare('DELETE FROM flow_nodes WHERE id = ? AND flow_id = ?').run(req.params.nid, req.params.id); } catch(e) {}
    res.redirect('/admin/flows/' + req.params.id);
  });

  router.post('/flows/:id/delete', (req, res) => {
    try {
      db.prepare('DELETE FROM flow_nodes WHERE flow_id = ?').run(req.params.id);
      db.prepare('DELETE FROM process_flows WHERE id = ?').run(req.params.id);
    } catch(e) {}
    res.redirect('/admin/flows');
  });

  router.post('/flows/:id/clone', (req, res) => {
    const { company_id } = req.body;
    const flow = safeGet('SELECT * FROM process_flows WHERE id = ?', [req.params.id]);
    if (!flow) return res.redirect('/admin/flows');
    try {
      const r = db.prepare('INSERT INTO process_flows (title, category, description, trigger_event, company_id, owner, status) VALUES (?,?,?,?,?,?,?)').run(
        flow.title, flow.category, flow.description, flow.trigger_event, company_id || null, flow.owner, 'draft'
      );
      const nodes = safeAll('SELECT * FROM flow_nodes WHERE flow_id = ? ORDER BY node_order', [flow.id]);
      nodes.forEach(nd => {
        db.prepare('INSERT INTO flow_nodes (flow_id, node_order, type, label, description, responsible, yes_label, no_label) VALUES (?,?,?,?,?,?,?,?)').run(
          r.lastInsertRowid, nd.node_order, nd.type, nd.label, nd.description, nd.responsible, nd.yes_label, nd.no_label
        );
      });
      res.redirect('/admin/flows/' + r.lastInsertRowid);
    } catch(e) { res.redirect('/admin/flows'); }
  });

  // === INTEGRATIONS PAGE ===
  router.get('/integrations', (req, res) => {
    const s = getSettings();
    const gmailOk = !!(s.gmail_user && s.gmail_app_password);
    const twilioOk = !!(s.twilio_sid && s.twilio_token && s.twilio_from);
    const webhookKey = s.webhook_key || '';
    const companies = safeAll('SELECT id, name FROM companies ORDER BY name');
    res.render(V('integrations'), { user: req.session.user, s, gmailOk, twilioOk, webhookKey, companies, settings: s, page: 'integrations' });
  });

  router.post('/integrations/gmail', (req, res) => {
    const { gmail_user, gmail_app_password, alert_emails } = req.body;
    const set = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    set.run('gmail_user', gmail_user || '');
    set.run('gmail_app_password', gmail_app_password || '');
    set.run('alert_emails', alert_emails || '');
    // Also update env for current session
    process.env.GMAIL_USER = gmail_user || '';
    process.env.GMAIL_APP_PASSWORD = gmail_app_password || '';
    process.env.ALERT_EMAILS = alert_emails || '';
    res.redirect('/admin/integrations');
  });

  router.post('/integrations/twilio', (req, res) => {
    const { twilio_sid, twilio_token, twilio_from, alert_phones } = req.body;
    const set = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    set.run('twilio_sid', twilio_sid || '');
    set.run('twilio_token', twilio_token || '');
    set.run('twilio_from', twilio_from || '');
    set.run('alert_phones', alert_phones || '');
    process.env.TWILIO_ACCOUNT_SID = twilio_sid || '';
    process.env.TWILIO_AUTH_TOKEN = twilio_token || '';
    process.env.TWILIO_FROM_NUMBER = twilio_from || '';
    process.env.ALERT_PHONES = alert_phones || '';
    res.redirect('/admin/integrations');
  });

  router.post('/integrations/webhook', (req, res) => {
    const { webhook_key } = req.body;
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('webhook_key', webhook_key || '');
    res.redirect('/admin/integrations');
  });

  // Per-company webhook generation
  router.post('/integrations/webhook-company', (req, res) => {
    const { company_id } = req.body;
    if (!company_id) return res.redirect('/admin/integrations');
    const crypto = require('crypto');
    const key = crypto.randomBytes(16).toString('hex');
    const existing = safeGet('SELECT value FROM settings WHERE key = ?', ['webhook_keys']);
    let keyMap = {};
    try { keyMap = JSON.parse((existing || {}).value || '{}'); } catch(e) {}
    keyMap[key] = parseInt(company_id);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('webhook_keys', JSON.stringify(keyMap));
    res.redirect('/admin/integrations');
  });

  router.post('/integrations/webhook-delete', (req, res) => {
    const { key } = req.body;
    const existing = safeGet('SELECT value FROM settings WHERE key = ?', ['webhook_keys']);
    let keyMap = {};
    try { keyMap = JSON.parse((existing || {}).value || '{}'); } catch(e) {}
    delete keyMap[key];
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('webhook_keys', JSON.stringify(keyMap));
    res.redirect('/admin/integrations');
  });

  // Test email
  router.post('/integrations/test-email', async (req, res) => {
    try {
      const { sendEmail } = require('../lib/alerts');
      const ok = await sendEmail(
        '🔔 Test Email — IT Services Manager',
        '<div style="font-family:Arial;padding:20px;"><h2 style="color:#10b981;">✅ Email Integration Working!</h2><p>This confirms your Gmail SMTP is configured correctly.</p><p>Time: ' + new Date().toLocaleString() + '</p><p style="color:#6b7280;font-size:12px;">— IT Services Manager</p></div>'
      );
      console.log('  Test email:', ok ? 'SUCCESS' : 'FAILED');
    } catch(e) { console.error('Test email error:', e.message); }
    res.redirect('/admin/integrations');
  });

  // Test SMS
  router.post('/integrations/test-sms', async (req, res) => {
    try {
      const { sendSMS } = require('../lib/alerts');
      const ok = await sendSMS('✅ IT Services Manager — SMS integration working! ' + new Date().toLocaleTimeString());
      console.log('  Test SMS:', ok ? 'SUCCESS' : 'FAILED');
    } catch(e) { console.error('Test SMS error:', e.message); }
    res.redirect('/admin/integrations');
  });

  // Test webhook (self-test)
  router.post('/integrations/test-webhook', (req, res) => {
    try {
      db.prepare('INSERT INTO alerts (title, description, severity, source, status) VALUES (?,?,?,?,?)').run(
        '🧪 Test Webhook Alert', 'This is a test alert from the integrations page.', 'info', 'test', 'open'
      );
      console.log('  Test webhook alert created');
    } catch(e) {}
    res.redirect('/admin/alerts');
  });

  // === ALERTS DASHBOARD ===
  router.get('/alerts', (req, res) => {
    const filter = req.query.filter || 'open';
    let where = '';
    if (filter === 'open') where = "WHERE a.resolved_at IS NULL";
    else if (filter === 'resolved') where = "WHERE a.resolved_at IS NOT NULL";
    const alerts = safeAll('SELECT a.*, m.name as monitor_name, m.target as monitor_target, c.name as company_name FROM alerts a LEFT JOIN equipment_monitors m ON a.monitor_id = m.id LEFT JOIN companies c ON m.company_id = c.id ' + where + ' ORDER BY a.created_at DESC LIMIT 200');
    res.render(V('alerts'), { user: req.session.user, alerts, filter, settings: getSettings(), page: 'monitoring' });
  });

  router.post('/alerts/:id/resolve', (req, res) => {
    const { resolution } = req.body;
    try { db.prepare("UPDATE alerts SET resolved_at = datetime('now'), resolved_by = ?, resolution = ? WHERE id = ?").run(req.session.user.username, resolution || 'Resolved', req.params.id); } catch(e) {}
    res.redirect('/admin/alerts');
  });

  // === ROLES MANAGEMENT ===
  router.get('/roles', (req, res) => {
    const roles = safeAll('SELECT * FROM roles ORDER BY sort_order');
    res.render(V('roles'), { user: req.session.user, roles, settings: getSettings(), page: 'settings' });
  });
  router.post('/roles', (req, res) => {
    const { name, description } = req.body;
    if (!name) return res.redirect('/admin/roles');
    const max = safeGet('SELECT MAX(sort_order) as m FROM roles');
    try { db.prepare('INSERT OR IGNORE INTO roles (name, description, sort_order) VALUES (?,?,?)').run(name.trim(), description || '', (max && max.m || 0) + 1); } catch(e) {}
    res.redirect('/admin/roles');
  });
  router.post('/roles/:id/delete', (req, res) => {
    try { db.prepare('DELETE FROM roles WHERE id = ?').run(req.params.id); } catch(e) {}
    res.redirect('/admin/roles');
  });

  // === DEPARTMENTS MANAGEMENT ===
  router.get('/departments', (req, res) => {
    const depts = safeAll('SELECT * FROM departments ORDER BY sort_order');
    res.render(V('departments'), { user: req.session.user, depts, settings: getSettings(), page: 'settings' });
  });
  router.post('/departments', (req, res) => {
    const { name, description } = req.body;
    if (!name) return res.redirect('/admin/departments');
    const max = safeGet('SELECT MAX(sort_order) as m FROM departments');
    try { db.prepare('INSERT OR IGNORE INTO departments (name, description, sort_order) VALUES (?,?,?)').run(name.trim(), description || '', (max && max.m || 0) + 1); } catch(e) {}
    res.redirect('/admin/departments');
  });
  router.post('/departments/:id/delete', (req, res) => {
    try { db.prepare('DELETE FROM departments WHERE id = ?').run(req.params.id); } catch(e) {}
    res.redirect('/admin/departments');
  });

  // === USER PROFILE (detailed view per user) ===
  router.get('/companies/:cid/users/:uid/profile', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.cid);
    if (!company) return res.redirect('/admin/companies');
    const usr = safeGet('SELECT * FROM company_users WHERE id = ? AND company_id = ?', [req.params.uid, req.params.cid]);
    if (!usr) return res.redirect('/admin/companies/' + req.params.cid + '?tab=users');
    const manager = usr.manager_id ? safeGet('SELECT id, name, title FROM company_users WHERE id = ?', [usr.manager_id]) : null;
    const directReports = safeAll('SELECT id, name, title, role, department FROM company_users WHERE manager_id = ? AND company_id = ?', [usr.id, company.id]);
    const assignedEquip = safeAll('SELECT * FROM inventory WHERE company_id = ? AND assigned_to = ?', [company.id, usr.name]);
    const assignedSoftware = safeAll('SELECT * FROM user_software WHERE company_id = ? AND user_id = ?', [company.id, usr.id]);
    const assignedSubs = safeAll("SELECT * FROM subscriptions WHERE company_id = ? AND notes LIKE '%' || ? || '%'", [company.id, usr.name]);
    const tasks = safeAll("SELECT * FROM tasks WHERE company_id = ? AND assigned_to = ? ORDER BY status ASC, due_date ASC", [company.id, usr.name]);
    const allUsers = safeAll('SELECT id, name, title FROM company_users WHERE company_id = ? AND id != ? ORDER BY name', [company.id, usr.id]);
    res.render(V('user-profile'), { user: req.session.user, company, usr, manager, directReports, assignedEquip, assignedSoftware, assignedSubs, tasks, allUsers, settings: getSettings(), page: 'companies' });
  });

  // Assign equipment to user
  router.post('/companies/:cid/users/:uid/assign-equipment', (req, res) => {
    const { inventory_id } = req.body;
    if (inventory_id) {
      const usr = safeGet('SELECT name FROM company_users WHERE id = ?', [req.params.uid]);
      if (usr) {
        try { db.prepare('UPDATE inventory SET assigned_to = ? WHERE id = ? AND company_id = ?').run(usr.name, inventory_id, req.params.cid); } catch(e) {}
      }
    }
    res.redirect('/admin/companies/' + req.params.cid + '/users/' + req.params.uid + '/profile');
  });

  // Assign software to user
  router.post('/companies/:cid/users/:uid/assign-software', (req, res) => {
    const { name, vendor, license_key, cost } = req.body;
    try {
      db.prepare('INSERT INTO user_software (company_id, user_id, name, vendor, license_key, cost) VALUES (?,?,?,?,?,?)').run(
        req.params.cid, req.params.uid, name, vendor || null, license_key || null, parseFloat(cost) || 0
      );
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/users/' + req.params.uid + '/profile');
  });

  router.post('/companies/:cid/users/:uid/software/:sid/delete', (req, res) => {
    try { db.prepare('DELETE FROM user_software WHERE id = ? AND company_id = ?').run(req.params.sid, req.params.cid); } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/users/' + req.params.uid + '/profile');
  });

  // Update user manager
  router.post('/companies/:cid/users/:uid/set-manager', (req, res) => {
    const { manager_id } = req.body;
    try { db.prepare('UPDATE company_users SET manager_id = ? WHERE id = ? AND company_id = ?').run(manager_id || null, req.params.uid, req.params.cid); } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/users/' + req.params.uid + '/profile');
  });

  // === CSV IMPORT / EXPORT ===
  const csvTableConfig = {
    contacts:      { fields: ['name','role','email','phone','is_primary'], label: 'Contacts' },
    users:         { fields: ['name','title','email','phone','department','role','email_account','hire_date','photo_url','is_active'], label: 'Users', dbTable: 'company_users' },
    servers:       { fields: ['name','type','ip','os','purpose','location','is_active','notes'], label: 'Servers' },
    subscriptions: { fields: ['name','vendor','type','seats','cost_per_unit','billing_cycle','renewal_date','auto_renew','notes'], label: 'Subscriptions' },
    assets:        { fields: ['name','type','provider','expires_at','login_url','notes'], label: 'Assets' },
    inventory:     { fields: ['name','type','manufacturer','model','serial_number','quantity','cost','condition','assigned_to','purchase_date','warranty_expires','notes'], label: 'Inventory' }
  };

  // Download CSV template (blank)
  router.get('/companies/:cid/:table/csv-template', (req, res) => {
    const cfg = csvTableConfig[req.params.table];
    if (!cfg) return res.status(404).send('Unknown table');
    const csv = cfg.fields.join(',') + '\n';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=' + req.params.table + '-template.csv');
    res.send(csv);
  });

  // Export current data as CSV
  router.get('/companies/:cid/:table/csv-export', (req, res) => {
    const cfg = csvTableConfig[req.params.table];
    if (!cfg) return res.status(404).send('Unknown table');
    const dbTable = cfg.dbTable || req.params.table;
    const rows = safeAll('SELECT * FROM ' + dbTable + ' WHERE company_id = ? ORDER BY name', [req.params.cid]);
    const csv = toCSV(cfg.fields, rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=' + req.params.table + '-export.csv');
    res.send(csv);
  });

  // Import CSV
  router.post('/companies/:cid/:table/csv-import', upload.single('csvfile'), (req, res) => {
    const { cid, table } = req.params;
    const cfg = csvTableConfig[table];
    if (!cfg || !req.file) return res.redirect('/admin/companies/' + cid + '?tab=' + table);
    const dbTable = cfg.dbTable || table;

    try {
      const text = fs.readFileSync(req.file.path, 'utf-8');
      const { headers, rows } = parseCSV(text);

      // Map CSV headers to known fields
      const validFields = cfg.fields.filter(f => headers.includes(f));
      if (validFields.length === 0 || !validFields.includes('name')) {
        fs.unlinkSync(req.file.path);
        return res.redirect('/admin/companies/' + cid + '?tab=' + table + '&importError=Missing+required+columns.+Must+include+name.');
      }

      let imported = 0;
      const insert = db.prepare('INSERT INTO ' + dbTable + ' (company_id, ' + validFields.join(',') + ') VALUES (?, ' + validFields.map(() => '?').join(',') + ')');
      const insertMany = db.transaction((items) => {
        for (const row of items) {
          const vals = validFields.map(f => {
            let v = row[f] || '';
            if (['is_active','is_primary','auto_renew'].includes(f)) return (v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes') ? 1 : 0;
            if (['seats','cost_per_unit','cost'].includes(f)) return parseFloat(v) || 0;
            if (f === 'quantity') return parseInt(v) || 1;
            return v || null;
          });
          if (!row.name) return; // skip rows without name
          insert.run(cid, ...vals);
          imported++;
        }
      });
      insertMany(rows);
      fs.unlinkSync(req.file.path);
      res.redirect('/admin/companies/' + cid + '?tab=' + table + '&imported=' + imported);
    } catch(e) {
      console.error('CSV import error:', e.message);
      try { fs.unlinkSync(req.file.path); } catch(x) {}
      res.redirect('/admin/companies/' + cid + '?tab=' + table + '&importError=' + encodeURIComponent(e.message));
    }
  });

  // === ORG CHART ===
  router.get('/companies/:cid/org-chart', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.cid);
    if (!company) return res.redirect('/admin/companies');
    const users = safeAll('SELECT * FROM company_users WHERE company_id = ? AND is_active = 1 ORDER BY name', [company.id]);
    const depts = safeAll('SELECT * FROM departments ORDER BY sort_order');
    res.render(V('org-chart'), { user: req.session.user, company, users, depts, settings: getSettings(), page: 'companies' });
  });

  // === INVENTORY LOCATIONS ===
  router.post('/companies/:cid/locations', (req, res) => {
    const { name, type, address, parent_id, notes } = req.body;
    try {
      db.prepare('INSERT INTO inventory_locations (company_id, name, type, address, parent_id, notes) VALUES (?,?,?,?,?,?)').run(
        req.params.cid, name, type || 'office', address || null, parent_id || null, notes || null
      );
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '?tab=inventory');
  });

  router.post('/companies/:cid/locations/:lid/edit', (req, res) => {
    const { name, type, address, parent_id, notes } = req.body;
    try {
      db.prepare('UPDATE inventory_locations SET name=?, type=?, address=?, parent_id=?, notes=? WHERE id=? AND company_id=?').run(
        name, type || 'office', address || null, parent_id || null, notes || null, req.params.lid, req.params.cid
      );
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '?tab=inventory');
  });

  router.post('/companies/:cid/locations/:lid/delete', (req, res) => {
    try {
      db.prepare('UPDATE inventory SET location_id = NULL WHERE location_id = ? AND company_id = ?').run(req.params.lid, req.params.cid);
      db.prepare('UPDATE inventory_locations SET parent_id = NULL WHERE parent_id = ? AND company_id = ?').run(req.params.lid, req.params.cid);
      db.prepare('DELETE FROM inventory_locations WHERE id = ? AND company_id = ?').run(req.params.lid, req.params.cid);
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '?tab=inventory');
  });

  // === SECURITY POLICIES ===
  router.get('/policies', (req, res) => {
    const filterCo = req.query.company || '';
    let where = filterCo ? 'WHERE p.company_id = ' + parseInt(filterCo) : '';
    const policies = safeAll('SELECT p.*, c.name as company_name FROM security_policies p LEFT JOIN companies c ON p.company_id = c.id ' + where + ' ORDER BY p.company_id IS NULL DESC, p.title');
    policies.forEach(p => {
      p.ack_count = (safeGet('SELECT COUNT(*) as c FROM policy_acknowledgments WHERE policy_id = ?', [p.id]) || {}).c || 0;
    });
    const companies = safeAll('SELECT id, name FROM companies ORDER BY name');
    res.render(V('policies'), { user: req.session.user, policies, companies, filterCo, settings: getSettings(), page: 'policies' });
  });

  router.post('/policies', (req, res) => {
    const { title, category, description, content, company_id, status, requires_ack } = req.body;
    try {
      db.prepare('INSERT INTO security_policies (title, category, description, content, company_id, status, requires_ack, created_by) VALUES (?,?,?,?,?,?,?,?)').run(
        title, category || 'general', description, content, company_id || null, status || 'draft', requires_ack ? 1 : 0, req.session.user.full_name || 'admin'
      );
    } catch(e) {}
    res.redirect('/admin/policies');
  });

  router.get('/policies/:id', (req, res) => {
    const policy = safeGet('SELECT p.*, c.name as company_name FROM security_policies p LEFT JOIN companies c ON p.company_id = c.id WHERE p.id = ?', [req.params.id]);
    if (!policy) return res.redirect('/admin/policies');
    const acks = safeAll('SELECT pa.*, c.name as company_name FROM policy_acknowledgments pa LEFT JOIN companies c ON pa.company_id = c.id WHERE pa.policy_id = ? ORDER BY pa.acknowledged_at DESC', [policy.id]);
    const companies = safeAll('SELECT id, name FROM companies ORDER BY name');
    // get company users for ack tracking
    let companyUsers = [];
    if (policy.company_id) {
      companyUsers = safeAll('SELECT id, name, department, role FROM company_users WHERE company_id = ? AND is_active = 1 ORDER BY name', [policy.company_id]);
    }
    res.render(V('policy-detail'), { user: req.session.user, policy, acks, companies, companyUsers, settings: getSettings(), page: 'policies' });
  });

  router.post('/policies/:id/edit', (req, res) => {
    const { title, category, description, content, company_id, status, requires_ack, review_date } = req.body;
    try {
      db.prepare("UPDATE security_policies SET title=?, category=?, description=?, content=?, company_id=?, status=?, requires_ack=?, review_date=?, updated_at=datetime('now') WHERE id=?").run(
        title, category, description, content, company_id || null, status, requires_ack ? 1 : 0, review_date || null, req.params.id
      );
    } catch(e) {}
    res.redirect('/admin/policies/' + req.params.id);
  });

  router.post('/policies/:id/acknowledge', (req, res) => {
    const { user_name, company_id } = req.body;
    if (!user_name) return res.redirect('/admin/policies/' + req.params.id);
    try {
      db.prepare('INSERT INTO policy_acknowledgments (policy_id, user_name, company_id) VALUES (?,?,?)').run(req.params.id, user_name, company_id || null);
    } catch(e) {}
    res.redirect('/admin/policies/' + req.params.id);
  });

  router.post('/policies/:id/delete', (req, res) => {
    try {
      db.prepare('DELETE FROM policy_acknowledgments WHERE policy_id = ?').run(req.params.id);
      db.prepare('DELETE FROM security_policies WHERE id = ?').run(req.params.id);
    } catch(e) {}
    res.redirect('/admin/policies');
  });

  router.post('/policies/:id/clone', (req, res) => {
    const { company_id } = req.body;
    const p = safeGet('SELECT * FROM security_policies WHERE id = ?', [req.params.id]);
    if (!p) return res.redirect('/admin/policies');
    try {
      const r = db.prepare('INSERT INTO security_policies (title, category, description, content, company_id, status, requires_ack, created_by) VALUES (?,?,?,?,?,?,?,?)').run(
        p.title, p.category, p.description, p.content, company_id || null, 'draft', p.requires_ack, req.session.user.full_name || 'admin'
      );
      res.redirect('/admin/policies/' + r.lastInsertRowid);
    } catch(e) { res.redirect('/admin/policies'); }
  });

  // === PASSWORD VAULT ===
  router.get('/vault', (req, res) => {
    const filterCo = req.query.company || '';
    const filterCat = req.query.category || '';
    let where = [];
    if (filterCo) where.push('v.company_id = ' + parseInt(filterCo));
    if (filterCat) where.push("v.category = '" + filterCat.replace(/'/g,'') + "'");
    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const entries = safeAll('SELECT v.*, c.name as company_name FROM password_vault v LEFT JOIN companies c ON v.company_id = c.id ' + whereStr + ' ORDER BY v.category, v.title');
    const companies = safeAll('SELECT id, name FROM companies ORDER BY name');
    const categories = safeAll('SELECT DISTINCT category FROM password_vault WHERE category IS NOT NULL ORDER BY category');
    res.render(V('vault'), { user: req.session.user, entries, companies, categories, filterCo, filterCat, settings: getSettings(), page: 'vault' });
  });

  router.post('/vault', (req, res) => {
    const { title, username, password_val, url, category, company_id, notes, share_type, share_dept, shared_with } = req.body;
    try {
      db.prepare('INSERT INTO password_vault (title, username, password_enc, url, category, company_id, notes, share_type, share_dept, shared_with, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
        title, username, password_val, url, category || 'general', company_id || null, notes, share_type || 'private', share_dept || null, shared_with || null, req.session.user.full_name || 'admin'
      );
    } catch(e) {}
    res.redirect('/admin/vault');
  });

  router.post('/vault/:id/edit', (req, res) => {
    const { title, username, password_val, url, category, company_id, notes, share_type, share_dept, shared_with } = req.body;
    try {
      db.prepare("UPDATE password_vault SET title=?, username=?, password_enc=?, url=?, category=?, company_id=?, notes=?, share_type=?, share_dept=?, shared_with=?, updated_at=datetime('now') WHERE id=?").run(
        title, username, password_val, url, category, company_id || null, notes, share_type || 'private', share_dept || null, shared_with || null, req.params.id
      );
    } catch(e) {}
    res.redirect('/admin/vault');
  });

  router.post('/vault/:id/delete', (req, res) => {
    try { db.prepare('DELETE FROM password_vault WHERE id = ?').run(req.params.id); } catch(e) {}
    res.redirect('/admin/vault');
  });


  // === PASSWORD RESET (send link via email) ===
  router.get('/users-manage', (req, res) => {
    const allUsers = safeAll('SELECT u.*, c.name as company_name FROM users u LEFT JOIN companies c ON u.company_id = c.id ORDER BY u.role, u.username');
    res.render(V('users-manage'), { user: req.session.user, allUsers, settings: getSettings(), page: 'settings' });
  });

  router.post('/users/:uid/send-reset', async (req, res) => {
    const targetUser = safeGet('SELECT * FROM users WHERE id = ?', [req.params.uid]);
    if (!targetUser || !targetUser.email) return res.redirect('/admin/users-manage');
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    try {
      db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?,?,?)').run(targetUser.id, token, expires);
      const { sendEmail } = require('../lib/alerts');
      const resetUrl = (req.protocol + '://' + req.get('host')) + '/reset-password?token=' + token;
      await sendEmail(
        '🔐 Password Reset — IT Services Manager',
        '<div style="font-family:Arial;padding:20px;max-width:500px;margin:0 auto;">' +
        '<h2 style="color:#0891b2;">Password Reset</h2>' +
        '<p>Hello <strong>' + (targetUser.full_name || targetUser.username) + '</strong>,</p>' +
        '<p>A password reset was requested for your account. Click the link below to set a new password:</p>' +
        '<p style="margin:20px 0;"><a href="' + resetUrl + '" style="background:#0891b2;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;">Reset Password</a></p>' +
        '<p style="font-size:12px;color:#6b7280;">This link expires in 24 hours. If you did not request this, ignore this email.</p>' +
        '<p style="font-size:12px;color:#6b7280;">— IT Services Manager</p></div>'
      );
    } catch(e) { console.error('Reset email error:', e.message); }
    res.redirect('/admin/users-manage');
  });

  // === CHAT PAGE ===
  router.get('/chat', (req, res) => {
    const companies = safeAll('SELECT id, name FROM companies ORDER BY name');
    res.render(V('chat'), { user: req.session.user, companies, settings: getSettings(), page: 'chat' });
  });

  return router;
};
