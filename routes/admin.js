const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');

// Multer setup
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
// CSV-only upload
const upload = multer({ dest: uploadDir, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
  if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) cb(null, true);
  else cb(new Error('Only CSV files allowed'));
}});
// General file upload (50MB limit)
const fileUpload = multer({ dest: uploadDir, limits: { fileSize: 50 * 1024 * 1024 } });
// Logo upload (5MB, images only)
const logoDir = path.join(__dirname, '..', 'uploads', 'logos');
if (!fs.existsSync(logoDir)) fs.mkdirSync(logoDir, { recursive: true });
const logoUpload = multer({
  dest: logoDir, limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpeg|jpg|gif|webp|svg\+xml)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files allowed (png, jpg, gif, webp, svg)'));
  }
});

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

  // Company access helper — filters companies by admin permissions
  const getVisibleCompanyIds = (req) => {
    const u = req.session.user;
    if (u.is_super || !u.assignedCompanies) return null; // null = all
    return u.assignedCompanies || [];
  };

  const filterCompanies = (companies, req) => {
    const ids = getVisibleCompanyIds(req);
    if (!ids) return companies; // super admin sees all
    return companies.filter(c => ids.includes(c.id));
  };

  const canAccessCompany = (req, companyId) => {
    const ids = getVisibleCompanyIds(req);
    if (!ids) return true;
    return ids.includes(parseInt(companyId));
  };

  const getSettings = () => {
    const s = {};
    try { db.prepare('SELECT key, value FROM settings').all().forEach(r => { s[r.key] = r.value; }); } catch(e) {}
    return s;
  };

  // Notifications — tasks + schedules grouped by time
  const getNotifications = () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const weekEnd = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

      // Open tasks
      const allOpen = db.prepare("SELECT t.*, c.name as company_name, 'task' as item_type FROM tasks t LEFT JOIN companies c ON t.company_id = c.id WHERE t.status != 'done' ORDER BY CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, t.due_date ASC LIMIT 30").all();
      const clientTasks = allOpen.filter(t => t.created_by === 'client');
      const myTasks = allOpen.filter(t => t.created_by !== 'client');

      // Schedules — show ALL active (not just overdue/today/this week)
      const schedules = safeAll("SELECT s.*, c.name as company_name, sv.name as service_name, 'schedule' as item_type FROM service_schedule s LEFT JOIN companies c ON s.company_id = c.id LEFT JOIN services sv ON s.service_id = sv.id WHERE s.is_active = 1 AND (s.last_completed IS NULL OR s.last_completed < s.next_due) ORDER BY s.next_due ASC");

      // Categorize by time
      const overdueTasks = allOpen.filter(t => t.due_date && t.due_date < today);
      const todayTasks = allOpen.filter(t => t.due_date === today);
      const upcomingTasks = allOpen.filter(t => t.due_date && t.due_date > today && t.due_date <= weekEnd);

      const overdueSchedules = schedules.filter(s => s.next_due && s.next_due < today);
      const todaySchedules = schedules.filter(s => s.next_due === today);
      const upcomingSchedules = schedules.filter(s => s.next_due && s.next_due > today && s.next_due <= weekEnd);
      // Future schedules — beyond this week, still not done
      const futureSchedules = schedules.filter(s => !s.next_due || s.next_due > weekEnd);

      const totalCount = allOpen.length + overdueSchedules.length + todaySchedules.length + upcomingSchedules.length + futureSchedules.length;

      return {
        allOpen, clientTasks, myTasks,
        overdueTasks, todayTasks, upcomingTasks,
        overdueSchedules, todaySchedules, upcomingSchedules, futureSchedules,
        schedules,
        count: totalCount
      };
    } catch(e) { return { allOpen: [], clientTasks: [], myTasks: [], overdueTasks: [], todayTasks: [], upcomingTasks: [], overdueSchedules: [], todaySchedules: [], upcomingSchedules: [], futureSchedules: [], schedules: [], count: 0 }; }
  };

  // Inject notifications + XP into every admin render
  const { getRank, getUserXP, checkDailyLogin } = require('../lib/xp');
  router.use((req, res, next) => {
    res.locals.notifications = getNotifications();
    const username = req.session.user.full_name || req.session.user.username;
    const totalXp = getUserXP(db, username);
    res.locals.userRank = getRank(totalXp);
    // XP flash from session
    if (req.session.xpFlash) {
      res.locals.xpFlash = req.session.xpFlash;
      delete req.session.xpFlash;
    }
    checkDailyLogin(db, username);
    next();
  });

  const { awardXP, getLeaderboard, getRecentXP } = require('../lib/xp');
  const xpUser = (req) => req.session.user.full_name || req.session.user.username;

  // Notification API (for live polling)
  router.get('/api/notifications', (req, res) => {
    res.json(getNotifications());
  });

  // Leaderboard
  router.get('/leaderboard', (req, res) => {
    const leaders = getLeaderboard(db, 50);
    leaders.forEach(l => { l.rank = getRank(l.total); });
    const myXP = getRecentXP(db, xpUser(req), 20);
    res.render(V('leaderboard'), { user: req.session.user, leaders, myXP, settings: getSettings(), page: 'leaderboard' });
  });

  // Safe query helper — returns [] if table doesn't exist
  const safeAll = (sql, params) => { try { return params ? db.prepare(sql).all(...(Array.isArray(params)?params:[params])) : db.prepare(sql).all(); } catch(e) { return []; } };
  const safeGet = (sql, params) => { try { return params ? db.prepare(sql).get(...(Array.isArray(params)?params:[params])) : db.prepare(sql).get(); } catch(e) { return null; } };

  // === DASHBOARD ===
  router.get('/', (req, res) => {
    const allCompanies = safeAll('SELECT * FROM companies ORDER BY name');
    const companies = filterCompanies(allCompanies, req);
    const activeCount = companies.filter(c => c.status === 'active').length;
    const cids = companies.map(c => c.id);
    const invoices = cids.length > 0 ? safeAll('SELECT * FROM invoices ORDER BY date DESC').filter(i => cids.includes(i.company_id)) : [];
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
    let where = []; let params = [];
    if (filter === 'open') where.push("t.status != 'done'");
    else if (filter === 'done') where.push("t.status = 'done'");
    if (filterCompany) { where.push("t.company_id = ?"); params.push(parseInt(filterCompany)); }
    if (filterPriority) { where.push("t.priority = ?"); params.push(filterPriority); }
    if (filterAssigned) { where.push("t.assigned_to = ?"); params.push(filterAssigned); }
    const whereStr = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    const tasks = safeAll("SELECT t.*, c.name as company_name FROM tasks t LEFT JOIN companies c ON t.company_id = c.id " + whereStr + " ORDER BY CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, t.due_date ASC", params);
    const companies = safeAll('SELECT id, name FROM companies ORDER BY name');
    const allPeople = [{name:'admin'}].concat(safeAll("SELECT DISTINCT name FROM company_users WHERE name IS NOT NULL AND name != '' ORDER BY name"));
    res.render(V('tasks'), { user: req.session.user, tasks, companies, allPeople, filter, filterCompany, filterPriority, filterAssigned, settings: getSettings(), page: 'tasks' });
  });

  router.post('/tasks', (req, res) => {
    const { title, description, company_id, related_table, related_id, priority, due_date, assigned_to, status } = req.body;
    db.prepare('INSERT INTO tasks (title, description, company_id, related_table, related_id, priority, due_date, assigned_to, status) VALUES (?,?,?,?,?,?,?,?,?)').run(
      title, description, company_id || null, related_table || null, related_id || null, priority || 'medium', due_date || null, assigned_to || null, status || 'todo'
    );
    awardXP(db, xpUser(req), 'create_task', null, req);
    res.redirect(req.body.redirect || '/admin/tasks');
  });

  router.post('/tasks/:id/status', (req, res) => {
    const newStatus = req.body.status;
    const task = safeGet('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
    db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(newStatus, req.params.id);

    // Track SLA timestamps
    if (task) {
      // First response (any status change from 'todo')
      if (!task.first_response_at && task.status === 'todo' && newStatus !== 'todo') {
        const responseMin = task.created_at ? Math.round((Date.now() - new Date(task.created_at + 'Z').getTime()) / 60000) : null;
        try { db.prepare("UPDATE tasks SET first_response_at = datetime('now'), sla_response_min = ? WHERE id = ?").run(responseMin, req.params.id); } catch(e) {}
      }
      // Started
      if (!task.started_at && newStatus === 'in-progress') {
        try { db.prepare("UPDATE tasks SET started_at = datetime('now') WHERE id = ?").run(req.params.id); } catch(e) {}
      }
      // Completed
      if (newStatus === 'done' && !task.completed_at) {
        const resolveMin = task.created_at ? Math.round((Date.now() - new Date(task.created_at + 'Z').getTime()) / 60000) : null;
        try { db.prepare("UPDATE tasks SET completed_at = datetime('now'), sla_resolve_min = ? WHERE id = ?").run(resolveMin, req.params.id); } catch(e) {}
        awardXP(db, xpUser(req), 'complete_task', null, req);
      }
    }

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

  // Specific edit routes MUST come before the generic /:table/:itemId/edit
  router.post('/companies/:cid/email-providers/:eid/edit', (req, res) => {
    const { provider, domain, admin_url, mfa_enabled, spf_configured, dkim_configured, dmarc_configured, backup_codes_stored, password_policy, retention_days, notes, last_audit_date } = req.body;
    try {
      db.prepare('UPDATE email_providers SET provider=?, domain=?, admin_url=?, mfa_enabled=?, spf_configured=?, dkim_configured=?, dmarc_configured=?, backup_codes_stored=?, password_policy=?, retention_days=?, notes=?, last_audit_date=? WHERE id=? AND company_id=?').run(
        provider || null, domain || null, admin_url || null, mfa_enabled ? 1 : 0, spf_configured ? 1 : 0, dkim_configured ? 1 : 0, dmarc_configured ? 1 : 0, backup_codes_stored ? 1 : 0, password_policy || null, parseInt(retention_days) || 0, notes || null, last_audit_date || null, req.params.eid, req.params.cid
      );
    } catch(e) { console.error('Email provider update error:', e.message); }
    res.redirect('/admin/companies/' + req.params.cid + '/email-security');
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
    awardXP(db, xpUser(req), 'create_project', null, req);
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
    companies = filterCompanies(companies, req);
    res.render(V('companies'), { user: req.session.user, companies, settings: getSettings(), page: 'companies' });
  });

  router.post('/companies', (req, res) => {
    try {
      const { name, status, address, city, state, zip, notes, contact_name, contact_email, contact_phone, client_username, client_password } = req.body;
      if (!name) return res.redirect('/admin/companies');
      const result = db.prepare('INSERT INTO companies (name, status, address, city, state, zip, notes) VALUES (?,?,?,?,?,?,?)').run(name, status || 'active', address || null, city || null, state || null, zip || null, notes || null);
      const companyId = result.lastInsertRowid;
      // Create default modules
      try { db.prepare('INSERT INTO company_modules (company_id) VALUES (?)').run(companyId); } catch(e2) {}
      if (contact_name) {
        try { db.prepare('INSERT INTO contacts (company_id, name, email, phone, is_primary) VALUES (?,?,?,?,1)').run(companyId, contact_name, contact_email || null, contact_phone || null); } catch(e2) {}
      }
      if (client_username && client_password) {
        try {
          const hash = bcrypt.hashSync(client_password, 10);
          db.prepare('INSERT INTO users (username, password, role, company_id, full_name, email) VALUES (?,?,?,?,?,?)').run(client_username, hash, 'client', companyId, contact_name || client_username, contact_email || null);
        } catch(e2) {}
      }
      res.redirect('/admin/companies/' + companyId);
    } catch(e) {
      console.error('Company create error:', e.message);
      res.redirect('/admin/companies');
    }
  });

  router.get('/companies/:id', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
    if (!company) return res.redirect('/admin/companies');
    if (!canAccessCompany(req, company.id)) return res.redirect('/admin/companies');
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
    let modules = safeGet('SELECT * FROM company_modules WHERE company_id = ?', [company.id]);
    if (!modules) { try { db.prepare('INSERT INTO company_modules (company_id) VALUES (?)').run(company.id); } catch(e) {} modules = safeGet('SELECT * FROM company_modules WHERE company_id = ?', [company.id]) || {}; }
    res.render(V('company-detail'), { user: req.session.user, company, tab, contacts, users, servers, subs, assets, inventory, locations, agreements, invoices, tasks, clientUsers, allServices, allPeople, roles, depts, imported, importError, modules, settings: getSettings(), page: 'companies' });
  });

  router.post('/companies/:id/delete', (req, res) => {
    db.prepare('DELETE FROM companies WHERE id = ?').run(req.params.id);
    db.prepare('DELETE FROM users WHERE company_id = ?').run(req.params.id);
    db.prepare('DELETE FROM tasks WHERE company_id = ?').run(req.params.id);
    res.redirect('/admin/companies');
  });

  // === COMPANY MODULES (enable/disable features) ===
  router.get('/companies/:cid/modules', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.cid);
    if (!company) return res.redirect('/admin/companies');
    let modules = safeGet('SELECT * FROM company_modules WHERE company_id = ?', [company.id]);
    if (!modules) {
      try { db.prepare('INSERT INTO company_modules (company_id) VALUES (?)').run(company.id); } catch(e) {}
      modules = safeGet('SELECT * FROM company_modules WHERE company_id = ?', [company.id]) || {};
    }
    res.render(V('company-modules'), { user: req.session.user, company, modules, settings: getSettings(), page: 'companies' });
  });

  router.post('/companies/:cid/modules', (req, res) => {
    const b = req.body;
    const fields = ['tms','fleet','monitoring','files','chat','sops','policies','passwords','eld','domains','rdp','expenses'];
    const existing = safeGet('SELECT id FROM company_modules WHERE company_id = ?', [req.params.cid]);
    if (existing) {
      const sets = fields.map(f => f + '=?').join(',');
      const vals = fields.map(f => b[f] ? 1 : 0);
      vals.push(req.params.cid);
      db.prepare('UPDATE company_modules SET ' + sets + ' WHERE company_id = ?').run(...vals);
    } else {
      db.prepare('INSERT INTO company_modules (company_id, ' + fields.join(',') + ') VALUES (?, ' + fields.map(() => '?').join(',') + ')').run(req.params.cid, ...fields.map(f => b[f] ? 1 : 0));
    }
    res.redirect('/admin/companies/' + req.params.cid + '/modules');
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

  router.post('/companies/:cid/email-providers/:eid/delete', (req, res) => {
    try { db.prepare('DELETE FROM email_providers WHERE id = ? AND company_id = ?').run(req.params.eid, req.params.cid); } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/email-security');
  });

  // === FILE MANAGEMENT (must be before generic /:id/:table) ===
  router.get('/companies/:cid/files', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.cid);
    if (!company) return res.redirect('/admin/companies');
    const folderId = req.query.folder || null;
    const folders = safeAll('SELECT * FROM file_folders WHERE company_id = ? AND parent_id IS ? ORDER BY name', [company.id, folderId]);
    const files = safeAll('SELECT * FROM company_files WHERE company_id = ? AND folder_id IS ? ORDER BY original_name', [company.id, folderId]);
    const currentFolder = folderId ? safeGet('SELECT * FROM file_folders WHERE id = ? AND company_id = ?', [folderId, company.id]) : null;
    // Breadcrumb
    const breadcrumbs = [];
    if (currentFolder) {
      let f = currentFolder;
      while (f) { breadcrumbs.unshift(f); f = f.parent_id ? safeGet('SELECT * FROM file_folders WHERE id = ?', [f.parent_id]) : null; }
    }
    // Folder access
    const folderAccess = folderId ? safeAll('SELECT * FROM folder_access WHERE folder_id = ?', [folderId]) : [];
    const companyUsers = safeAll('SELECT id, name, department, role FROM company_users WHERE company_id = ? AND is_active = 1 ORDER BY name', [company.id]);
    // Stats
    const totalFiles = safeGet('SELECT COUNT(*) as c FROM company_files WHERE company_id = ?', [company.id]);
    const totalFolders = safeGet('SELECT COUNT(*) as c FROM file_folders WHERE company_id = ?', [company.id]);
    const totalSize = safeGet('SELECT SUM(size) as s FROM company_files WHERE company_id = ?', [company.id]);
    const allFolders = safeAll('SELECT * FROM file_folders WHERE company_id = ? ORDER BY name', [company.id]);
    const storageQuota = (company.storage_quota || 500) * 1024 * 1024; // MB to bytes
    const usedBytes = totalSize.s || 0;
    const usedPct = storageQuota > 0 ? Math.round(usedBytes / storageQuota * 100) : 0;
    res.render(V('company-files'), { user: req.session.user, company, folders, files, currentFolder, folderId, breadcrumbs, folderAccess, companyUsers, allFolders, totalFiles: totalFiles.c, totalFolders: totalFolders.c, totalSize: usedBytes, storageQuota, usedPct, settings: getSettings(), page: 'companies' });
  });

  // Create folder
  router.post('/companies/:cid/folders', (req, res) => {
    const { name, parent_id } = req.body;
    if (!name) return res.redirect('/admin/companies/' + req.params.cid + '/files' + (req.body.parent_id ? '?folder=' + req.body.parent_id : ''));
    try {
      db.prepare('INSERT INTO file_folders (company_id, parent_id, name, created_by) VALUES (?,?,?,?)').run(
        req.params.cid, parent_id || null, name.trim(), req.session.user.full_name || 'admin'
      );
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/files' + (parent_id ? '?folder=' + parent_id : ''));
  });

  // Delete folder
  router.post('/companies/:cid/folders/:fid/delete', (req, res) => {
    const parentId = req.body.parent_id || null;
    try {
      // Move files to parent folder
      db.prepare('UPDATE company_files SET folder_id = ? WHERE folder_id = ? AND company_id = ?').run(parentId, req.params.fid, req.params.cid);
      // Move sub-folders to parent
      db.prepare('UPDATE file_folders SET parent_id = ? WHERE parent_id = ? AND company_id = ?').run(parentId, req.params.fid, req.params.cid);
      db.prepare('DELETE FROM folder_access WHERE folder_id = ?').run(req.params.fid);
      db.prepare('DELETE FROM file_folders WHERE id = ? AND company_id = ?').run(req.params.fid, req.params.cid);
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/files' + (parentId ? '?folder=' + parentId : ''));
  });

  // Rename folder
  router.post('/companies/:cid/folders/:fid/rename', (req, res) => {
    const { name } = req.body;
    try { db.prepare('UPDATE file_folders SET name = ? WHERE id = ? AND company_id = ?').run(name, req.params.fid, req.params.cid); } catch(e) {}
    const folder = safeGet('SELECT parent_id FROM file_folders WHERE id = ?', [req.params.fid]);
    res.redirect('/admin/companies/' + req.params.cid + '/files' + (folder && folder.parent_id ? '?folder=' + folder.parent_id : ''));
  });

  // Add/remove folder access
  router.post('/companies/:cid/folders/:fid/access', (req, res) => {
    const { user_name, permission } = req.body;
    if (!user_name) return res.redirect('/admin/companies/' + req.params.cid + '/files?folder=' + req.params.fid);
    try {
      const exists = safeGet('SELECT id FROM folder_access WHERE folder_id = ? AND user_name = ?', [req.params.fid, user_name]);
      if (exists) {
        db.prepare('UPDATE folder_access SET permission = ? WHERE id = ?').run(permission || 'view', exists.id);
      } else {
        db.prepare('INSERT INTO folder_access (folder_id, user_name, permission) VALUES (?,?,?)').run(req.params.fid, user_name, permission || 'view');
      }
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/files?folder=' + req.params.fid);
  });

  router.post('/companies/:cid/folders/:fid/access/:aid/delete', (req, res) => {
    try { db.prepare('DELETE FROM folder_access WHERE id = ?').run(req.params.aid); } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/files?folder=' + req.params.fid);
  });

  // Upload file
  router.post('/companies/:cid/files/upload', fileUpload.single('file'), (req, res) => {
    const folderId = req.body.folder_id || null;
    if (!req.file) return res.redirect('/admin/companies/' + req.params.cid + '/files' + (folderId ? '?folder=' + folderId : ''));
    try {
      db.prepare('INSERT INTO company_files (company_id, folder_id, filename, original_name, size, mime_type, uploaded_by) VALUES (?,?,?,?,?,?,?)').run(
        req.params.cid, folderId, req.file.filename, req.file.originalname, req.file.size, req.file.mimetype, req.session.user.full_name || 'admin'
      );
      awardXP(db, xpUser(req), 'upload_file', null, req);
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/files' + (folderId ? '?folder=' + folderId : ''));
  });

  // Serve file inline (for preview)
  router.get('/companies/:cid/files/:fileId/view', (req, res) => {
    const file = safeGet('SELECT * FROM company_files WHERE id = ? AND company_id = ?', [req.params.fileId, req.params.cid]);
    if (!file) return res.status(404).send('File not found');
    const filePath = require('path').resolve(__dirname, '..', 'uploads', file.filename);
    const mime = file.mime_type || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', 'inline; filename="' + file.original_name + '"');
    res.sendFile(filePath);
  });

  // Download file
  router.get('/companies/:cid/files/:fileId/download', (req, res) => {
    const file = safeGet('SELECT * FROM company_files WHERE id = ? AND company_id = ?', [req.params.fileId, req.params.cid]);
    if (!file) return res.status(404).send('File not found');
    const filePath = require('path').resolve(__dirname, '..', 'uploads', file.filename);
    res.download(filePath, file.original_name);
  });

  // Delete file
  router.post('/companies/:cid/files/:fileId/delete', (req, res) => {
    const file = safeGet('SELECT * FROM company_files WHERE id = ? AND company_id = ?', [req.params.fileId, req.params.cid]);
    const folderId = req.body.folder_id || null;
    if (file) {
      try {
        const filePath = require('path').join(__dirname, '..', 'uploads', file.filename);
        require('fs').unlinkSync(filePath);
      } catch(e) {}
      try { db.prepare('DELETE FROM company_files WHERE id = ?').run(file.id); } catch(e) {}
    }
    res.redirect('/admin/companies/' + req.params.cid + '/files' + (folderId ? '?folder=' + folderId : ''));
  });

  // Move file to folder
  router.post('/companies/:cid/files/:fileId/move', (req, res) => {
    const { folder_id } = req.body;
    try { db.prepare('UPDATE company_files SET folder_id = ? WHERE id = ? AND company_id = ?').run(folder_id || null, req.params.fileId, req.params.cid); } catch(e) {}
    res.redirect(req.body.redirect || '/admin/companies/' + req.params.cid + '/files');
  });

  // === RDP CONNECTIONS (must be before generic /:id/:table) ===
  router.get('/companies/:cid/rdp', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.cid);
    if (!company) return res.redirect('/admin/companies');
    const connections = safeAll('SELECT * FROM rdp_connections WHERE company_id = ? ORDER BY name', [company.id]);
    res.render(V('rdp'), { user: req.session.user, company, connections, settings: getSettings(), page: 'companies' });
  });

  router.post('/companies/:cid/rdp', (req, res) => {
    const { name, type, hostname, port, username, password_enc, domain, gateway, os, purpose, assigned_to, notes } = req.body;
    try {
      db.prepare('INSERT INTO rdp_connections (company_id, name, type, hostname, port, username, password_enc, domain, gateway, os, purpose, assigned_to, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        req.params.cid, name, type || 'rdp', hostname, parseInt(port) || 3389, username, password_enc, domain, gateway, os, purpose, assigned_to, notes
      );
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/rdp');
  });

  router.post('/companies/:cid/rdp/:rid/edit', (req, res) => {
    const { name, type, hostname, port, username, password_enc, domain, gateway, os, purpose, assigned_to, is_active, notes } = req.body;
    try {
      db.prepare('UPDATE rdp_connections SET name=?, type=?, hostname=?, port=?, username=?, password_enc=?, domain=?, gateway=?, os=?, purpose=?, assigned_to=?, is_active=?, notes=? WHERE id=? AND company_id=?').run(
        name, type || 'rdp', hostname, parseInt(port) || 3389, username, password_enc, domain, gateway, os, purpose, assigned_to, is_active ? 1 : 0, notes, req.params.rid, req.params.cid
      );
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/rdp');
  });

  router.post('/companies/:cid/rdp/:rid/delete', (req, res) => {
    try { db.prepare('DELETE FROM rdp_connections WHERE id = ? AND company_id = ?').run(req.params.rid, req.params.cid); } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/rdp');
  });

  // === AGREEMENT DETAIL + ATTACHMENT ===
  router.get('/companies/:cid/agreements/:aid', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.cid);
    if (!company) return res.redirect('/admin/companies');
    const agreement = safeGet('SELECT a.*, s.name as service_name, s.base_price, s.description as service_desc FROM agreements a LEFT JOIN services s ON a.service_id = s.id WHERE a.id = ? AND a.company_id = ?', [req.params.aid, req.params.cid]);
    if (!agreement) return res.redirect('/admin/companies/' + req.params.cid + '?tab=agreements');
    res.render(V('agreement-detail'), { user: req.session.user, company, agreement, settings: getSettings(), page: 'companies' });
  });

  router.post('/companies/:cid/agreements/:aid/edit', (req, res) => {
    const { title, custom_price, billing_cycle, start_date, end_date, auto_renew, sla_response, sla_resolution, scope, exclusions, terms, signed_by, signed_date, is_active, notes } = req.body;
    try {
      db.prepare('UPDATE agreements SET title=?, custom_price=?, billing_cycle=?, start_date=?, end_date=?, auto_renew=?, sla_response=?, sla_resolution=?, scope=?, exclusions=?, terms=?, signed_by=?, signed_date=?, is_active=?, notes=? WHERE id=? AND company_id=?').run(
        title || null, parseFloat(custom_price) || null, billing_cycle, start_date || null, end_date || null, auto_renew ? 1 : 0, sla_response || null, sla_resolution || null, scope || null, exclusions || null, terms || null, signed_by || null, signed_date || null, is_active ? 1 : 0, notes || null, req.params.aid, req.params.cid
      );
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/agreements/' + req.params.aid);
  });

  router.post('/companies/:cid/agreements/:aid/upload', fileUpload.single('file'), (req, res) => {
    if (!req.file) return res.redirect('/admin/companies/' + req.params.cid + '/agreements/' + req.params.aid);
    try {
      db.prepare('UPDATE agreements SET attachment = ?, attachment_name = ? WHERE id = ? AND company_id = ?').run(
        req.file.filename, req.file.originalname, req.params.aid, req.params.cid
      );
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/agreements/' + req.params.aid);
  });

  router.get('/companies/:cid/agreements/:aid/download', (req, res) => {
    const agr = safeGet('SELECT attachment, attachment_name FROM agreements WHERE id = ? AND company_id = ?', [req.params.aid, req.params.cid]);
    if (!agr || !agr.attachment) return res.status(404).send('No attachment');
    const filePath = require('path').resolve(__dirname, '..', 'uploads', agr.attachment);
    res.download(filePath, agr.attachment_name);
  });

  // === CENTRALIZED DISPATCH (cross-company) ===
  router.get('/dispatch', (req, res) => {
    const visibleIds = getVisibleCompanyIds(req);
    let whereCompany = '';
    if (visibleIds) whereCompany = ' AND l.company_id IN (' + visibleIds.join(',') + ')';

    const allLoads = safeAll("SELECT l.*, c.name as company_name, d.name as driver_name, v.unit_number as vehicle_unit, t.unit_number as trailer_unit FROM tms_loads l LEFT JOIN companies c ON l.company_id = c.id LEFT JOIN company_users d ON l.driver_id = d.id LEFT JOIN fleet_vehicles v ON l.vehicle_id = v.id LEFT JOIN fleet_trailers t ON l.trailer_id = t.id WHERE l.status NOT IN ('delivered','cancelled')" + whereCompany + " ORDER BY CASE l.status WHEN 'in-transit' THEN 1 WHEN 'dispatched' THEN 2 WHEN 'at-pickup' THEN 3 WHEN 'at-delivery' THEN 4 WHEN 'available' THEN 5 END, l.pickup_date ASC");

    // Available equipment across all companies
    let vWhere = visibleIds ? ' AND fv.company_id IN (' + visibleIds.join(',') + ')' : '';
    const availTrucks = safeAll("SELECT fv.*, c.name as company_name, cu.name as driver_name, ev.last_location, ev.last_lat, ev.last_lng, ev.last_speed FROM fleet_vehicles fv LEFT JOIN companies c ON fv.company_id = c.id LEFT JOIN company_users cu ON fv.driver_id = cu.id LEFT JOIN eld_vehicles ev ON fv.eld_vehicle_id = ev.id WHERE fv.status = 'active'" + vWhere + " ORDER BY c.name, fv.unit_number");
    const availTrailers = safeAll("SELECT ft.*, c.name as company_name, fv2.unit_number as assigned_truck, ev.last_location, ev.last_lat, ev.last_lng FROM fleet_trailers ft LEFT JOIN companies c ON ft.company_id = c.id LEFT JOIN fleet_vehicles fv2 ON ft.assigned_vehicle_id = fv2.id LEFT JOIN eld_vehicles ev ON ft.eld_vehicle_id = ev.id WHERE ft.status = 'active'" + (visibleIds ? ' AND ft.company_id IN (' + visibleIds.join(',') + ')' : '') + " ORDER BY c.name, ft.unit_number");

    // Drivers: who has a load, who doesn't
    const driversOnLoad = new Set(allLoads.filter(l => l.driver_id).map(l => l.driver_id));
    let dWhere = visibleIds ? ' AND cu.company_id IN (' + visibleIds.join(',') + ')' : '';
    const allDrivers = safeAll("SELECT cu.*, c.name as company_name FROM company_users cu LEFT JOIN companies c ON cu.company_id = c.id WHERE cu.is_active = 1" + dWhere + " ORDER BY c.name, cu.name");
    allDrivers.forEach(d => { d.on_load = driversOnLoad.has(d.id); });

    // Trucks on loads
    const trucksOnLoad = new Set(allLoads.filter(l => l.vehicle_id).map(l => l.vehicle_id));
    availTrucks.forEach(t => { t.on_load = trucksOnLoad.has(t.id); });
    const trailersOnLoad = new Set(allLoads.filter(l => l.trailer_id).map(l => l.trailer_id));
    availTrailers.forEach(t => { t.on_load = trailersOnLoad.has(t.id); });

    const companies = filterCompanies(safeAll('SELECT id, name FROM companies ORDER BY name'), req);
    const tab = req.query.tab || 'board';

    res.render(V('dispatch'), { user: req.session.user, allLoads, availTrucks, availTrailers, allDrivers, companies, tab, settings: getSettings(), page: 'dispatch' });
  });

  // === TMS — DISPATCH BOARD ===
  router.get('/companies/:cid/tms', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.cid);
    if (!company) return res.redirect('/admin/companies');
    const tab = req.query.tab || 'board';
    const loads = safeAll("SELECT l.*, d.name as driver_name, v.unit_number as vehicle_unit, t.unit_number as trailer_unit, disp.name as dispatcher_name FROM tms_loads l LEFT JOIN company_users d ON l.driver_id = d.id LEFT JOIN fleet_vehicles v ON l.vehicle_id = v.id LEFT JOIN fleet_trailers t ON l.trailer_id = t.id LEFT JOIN company_users disp ON l.dispatcher_id = disp.id WHERE l.company_id = ? ORDER BY CASE l.status WHEN 'in-transit' THEN 1 WHEN 'dispatched' THEN 2 WHEN 'available' THEN 3 WHEN 'at-pickup' THEN 4 WHEN 'at-delivery' THEN 5 ELSE 6 END, l.pickup_date ASC", [company.id]);
    const trips = safeAll("SELECT tr.*, d.name as driver_name, v.unit_number as vehicle_unit FROM tms_trips tr LEFT JOIN company_users d ON tr.driver_id = d.id LEFT JOIN fleet_vehicles v ON tr.vehicle_id = v.id WHERE tr.company_id = ? ORDER BY tr.start_date DESC LIMIT 50", [company.id]);
    const settlements = safeAll("SELECT s.*, d.name as driver_name FROM tms_driver_pay s LEFT JOIN company_users d ON s.driver_id = d.id WHERE s.company_id = ? ORDER BY s.period_end DESC LIMIT 50", [company.id]);
    const drivers = safeAll("SELECT id, name, department, role, pay_type, pay_rate, is_driver FROM company_users WHERE company_id = ? AND is_active = 1 ORDER BY name", [company.id]);
    const vehicles = safeAll("SELECT id, unit_number, make, model FROM fleet_vehicles WHERE company_id = ? AND status = 'active' ORDER BY unit_number", [company.id]);
    const trailers = safeAll("SELECT id, unit_number, type FROM fleet_trailers WHERE company_id = ? AND status = 'active' ORDER BY unit_number", [company.id]);
    const dispatchers = safeAll("SELECT d.*, u.name FROM tms_dispatchers d JOIN company_users u ON d.user_id = u.id WHERE d.company_id = ? AND d.is_active = 1", [company.id]);

    // Stats
    const stats = {
      active: loads.filter(l => ['dispatched','in-transit','at-pickup','at-delivery'].includes(l.status)).length,
      available: loads.filter(l => l.status === 'available').length,
      delivered: loads.filter(l => l.status === 'delivered').length,
      totalRevenue: loads.filter(l => l.status === 'delivered').reduce((s,l) => s + (l.total_pay||0), 0),
      totalMiles: loads.filter(l => l.status === 'delivered').reduce((s,l) => s + (l.total_miles||0), 0),
      avgRpm: 0,
      unpaidSettlements: settlements.filter(s => s.status !== 'paid').reduce((s,p) => s + (p.net_pay||0), 0)
    };
    if (stats.totalMiles > 0) stats.avgRpm = (stats.totalRevenue / stats.totalMiles).toFixed(2);

    res.render(V('tms'), { user: req.session.user, company, tab, loads, trips, settlements, drivers, vehicles, trailers, dispatchers, stats, settings: getSettings(), page: 'companies' });
  });

  // Create load
  router.post('/companies/:cid/tms/loads', (req, res) => {
    const b = req.body;
    const loadNum = 'LD-' + Date.now().toString(36).toUpperCase();
    const totalPay = (parseFloat(b.rate)||0) + (parseFloat(b.fuel_surcharge)||0) + (parseFloat(b.detention_pay)||0) + (parseFloat(b.accessorial)||0);
    const rpm = (parseInt(b.total_miles)||0) > 0 ? (totalPay / parseInt(b.total_miles)).toFixed(2) : 0;
    try {
      db.prepare('INSERT INTO tms_loads (company_id, load_number, status, broker, broker_mc, broker_contact, broker_phone, broker_email, customer, reference_number, commodity, weight, pieces, temperature, equipment_type, rate, rate_type, fuel_surcharge, detention_pay, accessorial, total_pay, total_miles, rate_per_mile, pickup_city, pickup_state, pickup_address, pickup_date, pickup_time, pickup_notes, delivery_city, delivery_state, delivery_address, delivery_date, delivery_time, delivery_notes, driver_id, vehicle_id, trailer_id, dispatcher_id, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        req.params.cid, loadNum, b.status||'available', b.broker, b.broker_mc, b.broker_contact, b.broker_phone, b.broker_email, b.customer, b.reference_number, b.commodity, parseInt(b.weight)||null, parseInt(b.pieces)||null, b.temperature, b.equipment_type||'dry-van', parseFloat(b.rate)||0, b.rate_type||'flat', parseFloat(b.fuel_surcharge)||0, parseFloat(b.detention_pay)||0, parseFloat(b.accessorial)||0, totalPay, parseInt(b.total_miles)||0, rpm, b.pickup_city, b.pickup_state, b.pickup_address, b.pickup_date, b.pickup_time, b.pickup_notes, b.delivery_city, b.delivery_state, b.delivery_address, b.delivery_date, b.delivery_time, b.delivery_notes, b.driver_id||null, b.vehicle_id||null, b.trailer_id||null, b.dispatcher_id||null, b.notes
      );
      awardXP(db, xpUser(req), 'create_task', 'Created load ' + loadNum, req);
    } catch(e) { console.error('TMS Load create:', e.message); }
    res.redirect('/admin/companies/' + req.params.cid + '/tms');
  });

  // Update load status
  router.post('/companies/:cid/tms/loads/:lid/status', (req, res) => {
    const { status } = req.body;
    const now = "datetime('now')";
    try {
      db.prepare('UPDATE tms_loads SET status = ? WHERE id = ? AND company_id = ?').run(status, req.params.lid, req.params.cid);
      db.prepare('INSERT INTO tms_status_log (load_id, status, changed_by) VALUES (?,?,?)').run(req.params.lid, status, xpUser(req));
      if (status === 'dispatched') db.prepare("UPDATE tms_loads SET dispatched_at = datetime('now') WHERE id = ?").run(req.params.lid);
      if (status === 'at-pickup' || status === 'in-transit') db.prepare("UPDATE tms_loads SET picked_up_at = COALESCE(picked_up_at, datetime('now')) WHERE id = ?").run(req.params.lid);
      if (status === 'delivered') db.prepare("UPDATE tms_loads SET delivered_at = datetime('now') WHERE id = ?").run(req.params.lid);
    } catch(e) {}
    res.redirect(req.body.redirect || '/admin/companies/' + req.params.cid + '/tms');
  });

  // Edit load
  router.post('/companies/:cid/tms/loads/:lid/edit', (req, res) => {
    const b = req.body;
    const totalPay = (parseFloat(b.rate)||0) + (parseFloat(b.fuel_surcharge)||0) + (parseFloat(b.detention_pay)||0) + (parseFloat(b.accessorial)||0);
    const rpm = (parseInt(b.total_miles)||0) > 0 ? (totalPay / parseInt(b.total_miles)).toFixed(2) : 0;
    try {
      db.prepare('UPDATE tms_loads SET status=?, broker=?, broker_mc=?, broker_contact=?, broker_phone=?, customer=?, reference_number=?, commodity=?, weight=?, equipment_type=?, rate=?, rate_type=?, fuel_surcharge=?, detention_pay=?, accessorial=?, total_pay=?, total_miles=?, rate_per_mile=?, pickup_city=?, pickup_state=?, pickup_address=?, pickup_date=?, pickup_time=?, delivery_city=?, delivery_state=?, delivery_address=?, delivery_date=?, delivery_time=?, driver_id=?, vehicle_id=?, trailer_id=?, dispatcher_id=?, pod_received=?, notes=? WHERE id=? AND company_id=?').run(
        b.status, b.broker, b.broker_mc, b.broker_contact, b.broker_phone, b.customer, b.reference_number, b.commodity, parseInt(b.weight)||null, b.equipment_type, parseFloat(b.rate)||0, b.rate_type, parseFloat(b.fuel_surcharge)||0, parseFloat(b.detention_pay)||0, parseFloat(b.accessorial)||0, totalPay, parseInt(b.total_miles)||0, rpm, b.pickup_city, b.pickup_state, b.pickup_address, b.pickup_date, b.pickup_time, b.delivery_city, b.delivery_state, b.delivery_address, b.delivery_date, b.delivery_time, b.driver_id||null, b.vehicle_id||null, b.trailer_id||null, b.dispatcher_id||null, b.pod_received?1:0, b.notes, req.params.lid, req.params.cid
      );
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/tms?tab=board');
  });

  // Load detail page
  router.get('/companies/:cid/tms/loads/:lid', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.cid);
    if (!company) return res.redirect('/admin/companies');
    const load = safeGet("SELECT l.*, d.name as driver_name, v.unit_number as vehicle_unit, t.unit_number as trailer_unit, disp.name as dispatcher_name FROM tms_loads l LEFT JOIN company_users d ON l.driver_id = d.id LEFT JOIN fleet_vehicles v ON l.vehicle_id = v.id LEFT JOIN fleet_trailers t ON l.trailer_id = t.id LEFT JOIN company_users disp ON l.dispatcher_id = disp.id WHERE l.id = ? AND l.company_id = ?", [req.params.lid, req.params.cid]);
    if (!load) return res.redirect('/admin/companies/' + req.params.cid + '/tms');
    const stops = safeAll('SELECT * FROM tms_stops WHERE load_id = ? ORDER BY stop_order', [load.id]);
    const timeline = safeAll('SELECT * FROM tms_status_log WHERE load_id = ? ORDER BY created_at DESC', [load.id]);
    const docs = safeAll('SELECT * FROM tms_documents WHERE load_id = ? ORDER BY created_at DESC', [load.id]);
    const drivers = safeAll("SELECT id, name FROM company_users WHERE company_id = ? AND is_active = 1 ORDER BY name", [company.id]);
    const vehicles = safeAll("SELECT id, unit_number FROM fleet_vehicles WHERE company_id = ? AND status = 'active' ORDER BY unit_number", [company.id]);
    const trailers = safeAll("SELECT id, unit_number FROM fleet_trailers WHERE company_id = ? AND status = 'active' ORDER BY unit_number", [company.id]);
    res.render(V('tms-load'), { user: req.session.user, company, load, stops, timeline, docs, drivers, vehicles, trailers, settings: getSettings(), page: 'companies' });
  });

  // Upload load document
  router.post('/companies/:cid/tms/loads/:lid/docs', fileUpload.single('file'), (req, res) => {
    if (!req.file) return res.redirect('/admin/companies/' + req.params.cid + '/tms/loads/' + req.params.lid);
    try {
      db.prepare('INSERT INTO tms_documents (load_id, type, filename, original_name, uploaded_by) VALUES (?,?,?,?,?)').run(
        req.params.lid, req.body.doc_type || 'other', req.file.filename, req.file.originalname, xpUser(req)
      );
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/tms/loads/' + req.params.lid);
  });

  // Download load document
  router.get('/companies/:cid/tms/loads/:lid/docs/:did', (req, res) => {
    const doc = safeGet('SELECT * FROM tms_documents WHERE id = ? AND load_id = ?', [req.params.did, req.params.lid]);
    if (!doc) return res.status(404).send('Not found');
    res.download(require('path').resolve(__dirname, '..', 'uploads', doc.filename), doc.original_name);
  });

  // Add stop
  router.post('/companies/:cid/tms/loads/:lid/stops', (req, res) => {
    const b = req.body;
    const maxOrder = safeGet('SELECT MAX(stop_order) as m FROM tms_stops WHERE load_id = ?', [req.params.lid]);
    try {
      db.prepare('INSERT INTO tms_stops (load_id, stop_order, type, city, state, address, date, time, contact, phone, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
        req.params.lid, (maxOrder && maxOrder.m || 0) + 1, b.type || 'pickup', b.city, b.state, b.address, b.date, b.time, b.contact, b.phone, b.notes
      );
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/tms/loads/' + req.params.lid);
  });

  // Add status update
  router.post('/companies/:cid/tms/loads/:lid/update', (req, res) => {
    const { note, location } = req.body;
    const load = safeGet('SELECT status FROM tms_loads WHERE id = ?', [req.params.lid]);
    try {
      db.prepare('INSERT INTO tms_status_log (load_id, status, note, location, changed_by) VALUES (?,?,?,?,?)').run(
        req.params.lid, load ? load.status : 'update', note, location, xpUser(req)
      );
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/tms/loads/' + req.params.lid);
  });

  // Rate confirmation print
  router.get('/companies/:cid/tms/loads/:lid/rate-con', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.cid);
    const load = safeGet("SELECT l.*, d.name as driver_name, v.unit_number as vehicle_unit, t.unit_number as trailer_unit FROM tms_loads l LEFT JOIN company_users d ON l.driver_id = d.id LEFT JOIN fleet_vehicles v ON l.vehicle_id = v.id LEFT JOIN fleet_trailers t ON l.trailer_id = t.id WHERE l.id = ? AND l.company_id = ?", [req.params.lid, req.params.cid]);
    if (!load) return res.status(404).send('Not found');
    const stops = safeAll('SELECT * FROM tms_stops WHERE load_id = ? ORDER BY stop_order', [load.id]);
    const settings2 = {};
    try { db.prepare('SELECT key, value FROM settings').all().forEach(r => { settings2[r.key] = r.value; }); } catch(e) {}
    res.render('tms-rate-con', { company, load, stops, settings: settings2 });
  });

  router.post('/companies/:cid/tms/loads/:lid/delete', (req, res) => {
    try {
      db.prepare('DELETE FROM tms_stops WHERE load_id = ?').run(req.params.lid);
      db.prepare('DELETE FROM tms_status_log WHERE load_id = ?').run(req.params.lid);
      db.prepare('DELETE FROM tms_documents WHERE load_id = ?').run(req.params.lid);
      db.prepare('DELETE FROM tms_loads WHERE id = ? AND company_id = ?').run(req.params.lid, req.params.cid);
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/tms');
  });

  // Create trip (links loads together)
  router.post('/companies/:cid/tms/trips', (req, res) => {
    const b = req.body;
    const tripNum = 'TR-' + Date.now().toString(36).toUpperCase();
    try {
      const r = db.prepare('INSERT INTO tms_trips (company_id, trip_number, driver_id, vehicle_id, trailer_id, status, start_date, end_date, start_odometer, end_odometer, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
        req.params.cid, tripNum, b.driver_id||null, b.vehicle_id||null, b.trailer_id||null, b.status||'planned', b.start_date||null, b.end_date||null, parseInt(b.start_odometer)||null, parseInt(b.end_odometer)||null, b.notes||null
      );
      // Link selected loads to this trip
      let loadIds = b.load_ids;
      if (loadIds) {
        if (!Array.isArray(loadIds)) loadIds = [loadIds];
        let totalMiles = 0, totalRevenue = 0;
        loadIds.forEach(lid => {
          try {
            db.prepare('UPDATE tms_loads SET trip_id = ? WHERE id = ? AND company_id = ?').run(r.lastInsertRowid, parseInt(lid), req.params.cid);
            const ld = safeGet('SELECT total_miles, total_pay FROM tms_loads WHERE id = ?', [parseInt(lid)]);
            if (ld) { totalMiles += (ld.total_miles||0); totalRevenue += (ld.total_pay||0); }
          } catch(e2) {}
        });
        db.prepare('UPDATE tms_trips SET total_miles = ?, total_revenue = ? WHERE id = ?').run(totalMiles, totalRevenue, r.lastInsertRowid);
      }
    } catch(e) { console.error('Trip create:', e.message); }
    res.redirect('/admin/companies/' + req.params.cid + '/tms?tab=loads');
  });

  // Generate settlement from trips
  router.post('/companies/:cid/tms/generate-settlement', (req, res) => {
    const { driver_id, period_start, period_end } = req.body;
    if (!driver_id) return res.redirect('/admin/companies/' + req.params.cid + '/tms?tab=pay');

    // Get driver pay info
    const driver = safeGet('SELECT * FROM company_users WHERE id = ? AND company_id = ?', [driver_id, req.params.cid]);
    if (!driver) return res.redirect('/admin/companies/' + req.params.cid + '/tms?tab=pay');

    // Find delivered loads for this driver in the period
    let where = "l.driver_id = ? AND l.company_id = ? AND l.status = 'delivered'";
    const params = [driver_id, req.params.cid];
    if (period_start) { where += " AND l.delivered_at >= ?"; params.push(period_start); }
    if (period_end) { where += " AND l.delivered_at <= ?"; params.push(period_end + 'T23:59:59'); }
    const driverLoads = safeAll("SELECT * FROM tms_loads l WHERE " + where, params);

    const totalMiles = driverLoads.reduce((s,l) => s + (l.total_miles||0), 0);
    const totalRevenue = driverLoads.reduce((s,l) => s + (l.total_pay||0), 0);
    const totalLoads = driverLoads.length;

    // Calculate pay based on driver's pay type
    let grossPay = 0;
    const payType = driver.pay_type || 'per-mile';
    const payRate = driver.pay_rate || 0;

    if (payType === 'per-mile') {
      grossPay = totalMiles * payRate;
    } else if (payType === 'percentage') {
      grossPay = totalRevenue * (payRate / 100);
    } else if (payType === 'flat') {
      grossPay = payRate;
    } else if (payType === 'per-load') {
      grossPay = totalLoads * payRate;
    }

    try {
      const r = db.prepare('INSERT INTO tms_driver_pay (company_id, driver_id, period_start, period_end, pay_type, rate, total_miles, total_loads, gross_pay, net_pay, status, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
        req.params.cid, driver_id, period_start||null, period_end||null, payType, payRate, totalMiles, totalLoads, Math.round(grossPay*100)/100, Math.round(grossPay*100)/100, 'draft',
        'Auto-generated: ' + totalLoads + ' loads, ' + totalMiles + ' miles, $' + totalRevenue.toFixed(2) + ' revenue'
      );
      // Link trips to this settlement
      const tripIds = [...new Set(driverLoads.map(l => l.trip_id).filter(Boolean))];
      tripIds.forEach(tid => {
        try { db.prepare('UPDATE tms_trips SET settlement_id = ? WHERE id = ?').run(r.lastInsertRowid, tid); } catch(e2) {}
      });
    } catch(e) { console.error('Settlement generation:', e.message); }
    res.redirect('/admin/companies/' + req.params.cid + '/tms?tab=pay');
  });

  // Create settlement
  router.post('/companies/:cid/tms/settlements', (req, res) => {
    const b = req.body;
    const gross = parseFloat(b.gross_pay) || 0;
    const net = gross + (parseFloat(b.bonus)||0) + (parseFloat(b.reimbursements)||0) - (parseFloat(b.deductions)||0);
    try {
      db.prepare('INSERT INTO tms_driver_pay (company_id, driver_id, period_start, period_end, pay_type, rate, total_miles, total_loads, gross_pay, bonus, deductions, reimbursements, net_pay, status, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        req.params.cid, b.driver_id, b.period_start, b.period_end, b.pay_type||'per-mile', parseFloat(b.rate)||0, parseInt(b.total_miles)||0, parseInt(b.total_loads)||0, gross, parseFloat(b.bonus)||0, parseFloat(b.deductions)||0, parseFloat(b.reimbursements)||0, net, b.status||'draft', b.notes
      );
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/tms?tab=pay');
  });

  router.post('/companies/:cid/tms/settlements/:sid/pay', (req, res) => {
    try { db.prepare("UPDATE tms_driver_pay SET status = 'paid', paid_date = datetime('now') WHERE id = ? AND company_id = ?").run(req.params.sid, req.params.cid); } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/tms?tab=pay');
  });

  // Update driver pay rate
  router.post('/companies/:cid/tms/driver-rate/:did', (req, res) => {
    const { pay_type, pay_rate } = req.body;
    try {
      db.prepare('UPDATE company_users SET pay_type = ?, pay_rate = ?, is_driver = 1 WHERE id = ? AND company_id = ?').run(
        pay_type || 'per-mile', parseFloat(pay_rate) || 0, req.params.did, req.params.cid
      );
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/tms?tab=pay');
  });

  // Add dispatcher
  router.post('/companies/:cid/tms/dispatchers', (req, res) => {
    const { user_id, team_name, max_drivers } = req.body;
    try { db.prepare('INSERT INTO tms_dispatchers (company_id, user_id, team_name, max_drivers) VALUES (?,?,?,?)').run(req.params.cid, user_id, team_name, parseInt(max_drivers)||20); } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/tms?tab=team');
  });

  // === FLEET MANAGEMENT ===
  router.get('/companies/:cid/fleet', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.cid);
    if (!company) return res.redirect('/admin/companies');
    const vehicles = safeAll('SELECT v.*, cu.name as driver_name FROM fleet_vehicles v LEFT JOIN company_users cu ON v.driver_id = cu.id WHERE v.company_id = ? ORDER BY v.unit_number', [company.id]);
    const trailers = safeAll('SELECT t.*, fv.unit_number as vehicle_unit FROM fleet_trailers t LEFT JOIN fleet_vehicles fv ON t.assigned_vehicle_id = fv.id WHERE t.company_id = ? ORDER BY t.unit_number', [company.id]);
    const maintenance = safeAll('SELECT m.*, fv.unit_number as vehicle_unit, ft.unit_number as trailer_unit FROM fleet_maintenance m LEFT JOIN fleet_vehicles fv ON m.vehicle_id = fv.id LEFT JOIN fleet_trailers ft ON m.trailer_id = ft.id WHERE m.company_id = ? ORDER BY m.date DESC LIMIT 50', [company.id]);
    const fuel = safeAll('SELECT f.*, fv.unit_number as vehicle_unit FROM fleet_fuel f LEFT JOIN fleet_vehicles fv ON f.vehicle_id = fv.id WHERE f.company_id = ? ORDER BY f.date DESC LIMIT 50', [company.id]);
    const drivers = safeAll('SELECT id, name FROM company_users WHERE company_id = ? AND is_active = 1 ORDER BY name', [company.id]);
    const eldVehicles = safeAll('SELECT ev.*, ei.provider, ei.label as integration_label FROM eld_vehicles ev LEFT JOIN eld_integrations ei ON ev.integration_id = ei.id WHERE ev.company_id = ?', [company.id]);
    // Enrich fleet vehicles with ELD data
    vehicles.forEach(v => {
      if (v.eld_vehicle_id) {
        const ev = safeGet('SELECT last_lat, last_lng, last_location, last_speed, fuel_pct, odometer, status as eld_status, driver_name as eld_driver FROM eld_vehicles WHERE id = ?', [v.eld_vehicle_id]);
        if (ev) Object.assign(v, ev);
      }
    });
    res.render(V('fleet'), { user: req.session.user, company, vehicles, trailers, maintenance, fuel, drivers, eldVehicles, settings: getSettings(), page: 'companies' });
  });

  router.post('/companies/:cid/fleet/vehicles', (req, res) => {
    const b = req.body;
    try {
      db.prepare('INSERT INTO fleet_vehicles (company_id, unit_number, type, make, model, year, vin, license_plate, state, color, status, driver_id, fuel_type, odometer, purchase_date, purchase_price, insurance_policy, insurance_expires, registration_expires, inspection_expires, gps_unit, eld_provider, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        req.params.cid, b.unit_number, b.type||'truck', b.make, b.model, parseInt(b.year)||null, b.vin, b.license_plate, b.state, b.color, b.status||'active', b.driver_id||null, b.fuel_type||'diesel', parseInt(b.odometer)||0, b.purchase_date||null, parseFloat(b.purchase_price)||0, b.insurance_policy, b.insurance_expires||null, b.registration_expires||null, b.inspection_expires||null, b.gps_unit, b.eld_provider, b.notes
      );
    } catch(e) { console.error('Fleet vehicle error:', e.message); }
    res.redirect('/admin/companies/' + req.params.cid + '/fleet');
  });

  router.post('/companies/:cid/fleet/vehicles/:vid/edit', (req, res) => {
    const b = req.body;
    try {
      db.prepare('UPDATE fleet_vehicles SET unit_number=?, type=?, make=?, model=?, year=?, vin=?, license_plate=?, state=?, color=?, status=?, driver_id=?, fuel_type=?, odometer=?, purchase_date=?, purchase_price=?, insurance_policy=?, insurance_expires=?, registration_expires=?, inspection_expires=?, gps_unit=?, eld_provider=?, eld_vehicle_id=?, notes=? WHERE id=? AND company_id=?').run(
        b.unit_number, b.type, b.make, b.model, parseInt(b.year)||null, b.vin, b.license_plate, b.state, b.color, b.status, b.driver_id||null, b.fuel_type, parseInt(b.odometer)||0, b.purchase_date||null, parseFloat(b.purchase_price)||0, b.insurance_policy, b.insurance_expires||null, b.registration_expires||null, b.inspection_expires||null, b.gps_unit, b.eld_provider, b.eld_vehicle_id||null, b.notes, req.params.vid, req.params.cid
      );
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/fleet');
  });

  router.post('/companies/:cid/fleet/vehicles/:vid/delete', (req, res) => {
    try { db.prepare('DELETE FROM fleet_vehicles WHERE id = ? AND company_id = ?').run(req.params.vid, req.params.cid); } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/fleet');
  });

  router.post('/companies/:cid/fleet/trailers', (req, res) => {
    const b = req.body;
    try {
      db.prepare('INSERT INTO fleet_trailers (company_id, unit_number, type, make, model, year, vin, license_plate, state, length_ft, status, assigned_vehicle_id, purchase_date, purchase_price, registration_expires, inspection_expires, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        req.params.cid, b.unit_number, b.type||'dry-van', b.make, b.model, parseInt(b.year)||null, b.vin, b.license_plate, b.state, parseInt(b.length_ft)||53, b.status||'active', b.assigned_vehicle_id||null, b.purchase_date||null, parseFloat(b.purchase_price)||0, b.registration_expires||null, b.inspection_expires||null, b.notes
      );
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/fleet');
  });

  router.post('/companies/:cid/fleet/trailers/:tid/delete', (req, res) => {
    try { db.prepare('DELETE FROM fleet_trailers WHERE id = ? AND company_id = ?').run(req.params.tid, req.params.cid); } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/fleet');
  });

  router.post('/companies/:cid/fleet/maintenance', (req, res) => {
    const b = req.body;
    try {
      db.prepare('INSERT INTO fleet_maintenance (company_id, vehicle_id, trailer_id, type, description, vendor, cost, odometer, date, next_due_date, next_due_miles, status, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        req.params.cid, b.vehicle_id||null, b.trailer_id||null, b.type||'repair', b.description, b.vendor, parseFloat(b.cost)||0, parseInt(b.odometer)||null, b.date||null, b.next_due_date||null, parseInt(b.next_due_miles)||null, b.status||'completed', b.notes
      );
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/fleet');
  });

  router.post('/companies/:cid/fleet/fuel', (req, res) => {
    const b = req.body;
    const total = (parseFloat(b.gallons)||0) * (parseFloat(b.cost_per_gallon)||0);
    try {
      db.prepare('INSERT INTO fleet_fuel (company_id, vehicle_id, date, gallons, cost_per_gallon, total_cost, odometer, station, city, state, fuel_card, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
        req.params.cid, b.vehicle_id||null, b.date||null, parseFloat(b.gallons)||0, parseFloat(b.cost_per_gallon)||0, total, parseInt(b.odometer)||null, b.station, b.city, b.state, b.fuel_card, b.notes
      );
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/fleet');
  });

  // === ELD INTEGRATIONS (Samsara, Motive) ===
  router.get('/companies/:cid/eld', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.cid);
    if (!company) return res.redirect('/admin/companies');
    const integrations = safeAll('SELECT * FROM eld_integrations WHERE company_id = ? ORDER BY provider, label', [company.id]);
    const eldVehicles = safeAll('SELECT ev.*, ei.provider, ei.label as integration_label FROM eld_vehicles ev JOIN eld_integrations ei ON ev.integration_id = ei.id WHERE ev.company_id = ? ORDER BY ei.provider, ev.name', [company.id]);
    res.render(V('eld'), { user: req.session.user, company, integrations, eldVehicles, settings: getSettings(), page: 'companies' });
  });

  router.post('/companies/:cid/eld', (req, res) => {
    const { provider, label, api_key, base_url } = req.body;
    if (!api_key) return res.redirect('/admin/companies/' + req.params.cid + '/eld');
    const defaults = { samsara: 'https://api.samsara.com', motive: 'https://api.keeptruckin.com' };
    try {
      db.prepare('INSERT INTO eld_integrations (company_id, provider, label, api_key, base_url) VALUES (?,?,?,?,?)').run(
        req.params.cid, provider || 'samsara', label || null, api_key, base_url || defaults[provider] || ''
      );
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/eld');
  });

  router.post('/companies/:cid/eld/:eid/sync', async (req, res) => {
    const integration = safeGet('SELECT * FROM eld_integrations WHERE id = ? AND company_id = ?', [req.params.eid, req.params.cid]);
    if (!integration) return res.redirect('/admin/companies/' + req.params.cid + '/eld');
    const { syncIntegration } = require('../lib/eld-sync');
    const result = await syncIntegration(db, integration);
    console.log('ELD sync:', result);
    res.redirect('/admin/companies/' + req.params.cid + '/eld');
  });

  router.post('/companies/:cid/eld/:eid/delete', (req, res) => {
    try {
      db.prepare('DELETE FROM eld_vehicles WHERE integration_id = ? AND company_id = ?').run(req.params.eid, req.params.cid);
      db.prepare('DELETE FROM eld_integrations WHERE id = ? AND company_id = ?').run(req.params.eid, req.params.cid);
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/eld');
  });

  // Sync all integrations for a company
  router.post('/companies/:cid/eld/sync-all', async (req, res) => {
    const integrations = safeAll('SELECT * FROM eld_integrations WHERE company_id = ? AND is_active = 1', [req.params.cid]);
    const { syncIntegration } = require('../lib/eld-sync');
    for (const intg of integrations) {
      await syncIntegration(db, intg);
    }
    res.redirect('/admin/companies/' + req.params.cid + '/eld');
  });

  // === FLEET MAP ===
  router.get('/companies/:cid/fleet/map', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.cid);
    if (!company) return res.redirect('/admin/companies');
    const eldVehicles = safeAll("SELECT ev.*, ei.provider, ei.label as integration_label FROM eld_vehicles ev LEFT JOIN eld_integrations ei ON ev.integration_id = ei.id WHERE ev.company_id = ?", [company.id]);
    const fleetVehicles = safeAll("SELECT fv.*, cu.name as driver_name, ev.last_lat, ev.last_lng, ev.last_location, ev.last_speed, ev.status as eld_status, ev.driver_name as eld_driver, ev.fuel_pct, ev.odometer as eld_odometer FROM fleet_vehicles fv LEFT JOIN company_users cu ON fv.driver_id = cu.id LEFT JOIN eld_vehicles ev ON fv.eld_vehicle_id = ev.id WHERE fv.company_id = ?", [company.id]);
    res.render(V('fleet-map'), { user: req.session.user, company, eldVehicles, fleetVehicles, settings: getSettings(), page: 'companies' });
  });

  // Bulk import ELD vehicles into fleet
  router.post('/companies/:cid/fleet/import-eld', (req, res) => {
    let eldIds = req.body.eld_ids;
    console.log('ELD Import - raw body:', req.body);
    console.log('ELD Import - eld_ids:', eldIds);
    if (!eldIds) {
      console.log('ELD Import - No eld_ids received!');
      return res.redirect('/admin/companies/' + req.params.cid + '/fleet');
    }
    if (!Array.isArray(eldIds)) eldIds = [eldIds];
    console.log('ELD Import - Processing', eldIds.length, 'IDs:', eldIds);

    let imported = 0, skipped = 0;
    for (const eid of eldIds) {
      const ev = safeGet('SELECT * FROM eld_vehicles WHERE id = ? AND company_id = ?', [parseInt(eid), req.params.cid]);
      if (!ev) { console.log('ELD Import - Not found:', eid); skipped++; continue; }

      const assetType = ev.asset_type || 'vehicle';

      if (assetType === 'trailer') {
        // Import as trailer
        const existing = safeGet('SELECT id FROM fleet_trailers WHERE eld_vehicle_id = ? AND company_id = ?', [ev.id, req.params.cid]);
        if (existing) { skipped++; continue; }
        try {
          db.prepare('INSERT INTO fleet_trailers (company_id, unit_number, type, make, model, year, vin, license_plate, status, eld_vehicle_id) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
            req.params.cid, ev.name || 'TR-' + ev.id, 'dry-van', ev.make || null, ev.model || null, ev.year || null, ev.vin || null, ev.license_plate || null, 'active', ev.id
          );
          imported++;
        } catch(e) { console.error('ELD Trailer Import error:', e.message); }
      } else {
        // Import as truck
        const existing = safeGet('SELECT id FROM fleet_vehicles WHERE eld_vehicle_id = ? AND company_id = ?', [ev.id, req.params.cid]);
        if (existing) { skipped++; continue; }
        try {
          db.prepare('INSERT INTO fleet_vehicles (company_id, unit_number, type, make, model, year, vin, license_plate, status, eld_vehicle_id) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
            req.params.cid, ev.name || 'ELD-' + ev.id, 'truck', ev.make || null, ev.model || null, ev.year || null, ev.vin || null, ev.license_plate || null, 'active', ev.id
          );
          imported++;
        } catch(e) { console.error('ELD Vehicle Import error:', e.message); }
      }
    }
    console.log('ELD Import - Done. Imported:', imported, 'Skipped:', skipped);
    res.redirect('/admin/companies/' + req.params.cid + '/fleet');
  });

  // Link ELD vehicle to fleet vehicle
  router.post('/companies/:cid/fleet/vehicles/:vid/link-eld', (req, res) => {
    const { eld_vehicle_id } = req.body;
    try { db.prepare('UPDATE fleet_vehicles SET eld_vehicle_id = ? WHERE id = ? AND company_id = ?').run(eld_vehicle_id || null, req.params.vid, req.params.cid); } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/fleet');
  });

  // API endpoint for live map data (AJAX polling)
  router.get('/companies/:cid/fleet/map-data', (req, res) => {
    const eldWithGps = safeAll("SELECT ev.*, ei.provider, ei.label as integration_label, fv.unit_number as fleet_unit, fv.make as fleet_make, fv.model as fleet_model, fv.type as fleet_type, ft.unit_number as trailer_unit FROM eld_vehicles ev LEFT JOIN eld_integrations ei ON ev.integration_id = ei.id LEFT JOIN fleet_vehicles fv ON fv.eld_vehicle_id = ev.id LEFT JOIN fleet_trailers ft ON ft.eld_vehicle_id = ev.id WHERE ev.company_id = ? AND ev.last_lat IS NOT NULL AND ev.last_lat != 0", [req.params.cid]);
    res.json(eldWithGps);
  });

  // === DOMAIN MANAGEMENT ===
  router.get('/companies/:cid/domains', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.cid);
    if (!company) return res.redirect('/admin/companies');
    const domainList = safeAll('SELECT * FROM domains WHERE company_id = ? ORDER BY domain', [company.id]);
    res.render(V('domains'), { user: req.session.user, company, domainList, settings: getSettings(), page: 'companies' });
  });

  router.post('/companies/:cid/domains', (req, res) => {
    const b = req.body;
    try {
      db.prepare('INSERT INTO domains (company_id, domain, registrar, dns_provider, hosting_provider, ssl_provider, ssl_expires, domain_expires, nameservers, a_records, mx_records, auto_renew, admin_url, login_email, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        req.params.cid, b.domain, b.registrar, b.dns_provider, b.hosting_provider, b.ssl_provider, b.ssl_expires||null, b.domain_expires||null, b.nameservers, b.a_records, b.mx_records, b.auto_renew?1:0, b.admin_url, b.login_email, b.notes
      );
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/domains');
  });

  router.post('/companies/:cid/domains/:did/edit', (req, res) => {
    const b = req.body;
    try {
      db.prepare('UPDATE domains SET domain=?, registrar=?, dns_provider=?, hosting_provider=?, ssl_provider=?, ssl_expires=?, domain_expires=?, nameservers=?, a_records=?, mx_records=?, auto_renew=?, admin_url=?, login_email=?, notes=? WHERE id=? AND company_id=?').run(
        b.domain, b.registrar, b.dns_provider, b.hosting_provider, b.ssl_provider, b.ssl_expires||null, b.domain_expires||null, b.nameservers, b.a_records, b.mx_records, b.auto_renew?1:0, b.admin_url, b.login_email, b.notes, req.params.did, req.params.cid
      );
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/domains');
  });

  router.post('/companies/:cid/domains/:did/delete', (req, res) => {
    try { db.prepare('DELETE FROM domains WHERE id = ? AND company_id = ?').run(req.params.did, req.params.cid); } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/domains');
  });

  // === INVENTORY LOCATIONS (must be before generic /:id/:table) ===
  router.post('/companies/:cid/locations', (req, res) => {
    const { name, type, address, parent_id, notes } = req.body;
    try {
      db.prepare('INSERT INTO inventory_locations (company_id, name, type, address, parent_id, notes) VALUES (?,?,?,?,?,?)').run(
        req.params.cid, name, type || 'office', address || null, parent_id || null, notes || null
      );
      awardXP(db, xpUser(req), 'add_location', null, req);
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

  // === GRANT PORTAL ACCESS from company user ===
  router.post('/companies/:id/grant-portal-access', (req, res) => {
    const { company_user_id, username, password } = req.body;
    if (!username || !password) return res.redirect('/admin/companies/' + req.params.id + '?tab=overview');
    try {
      const cu = safeGet('SELECT * FROM company_users WHERE id = ? AND company_id = ?', [company_user_id, req.params.id]);
      const hash = bcrypt.hashSync(password, 10);
      db.prepare('INSERT INTO users (username, password, role, company_id, full_name, email, phone, is_active) VALUES (?,?,?,?,?,?,?,1)').run(
        username, hash, 'client', req.params.id,
        cu ? cu.name : null,
        cu ? (cu.email_account || cu.email) : null,
        cu ? cu.phone : null
      );
      awardXP(db, xpUser(req), 'grant_portal', null, req);
    } catch(e) { console.error('Grant portal access error:', e.message); }
    res.redirect('/admin/companies/' + req.params.id + '?tab=overview');
  });

  // === COMPANY LOGO (file upload) ===
  router.post('/companies/:id/logo', logoUpload.single('logo'), (req, res) => {
    if (!req.file) return res.redirect('/admin/companies/' + req.params.id + '?tab=overview');
    const ext = path.extname(req.file.originalname).toLowerCase() || '.png';
    const newName = 'logo-' + req.params.id + '-' + Date.now() + ext;
    const newPath = path.join(logoDir, newName);
    try {
      fs.renameSync(req.file.path, newPath);
      // Delete old logo file if it exists
      const old = db.prepare('SELECT logo FROM companies WHERE id = ?').get(req.params.id);
      if (old && old.logo && old.logo.startsWith('/uploads/logos/')) {
        const oldPath = path.join(__dirname, '..', old.logo);
        try { fs.unlinkSync(oldPath); } catch(e) {}
      }
      db.prepare('UPDATE companies SET logo = ? WHERE id = ?').run('/uploads/logos/' + newName, req.params.id);
    } catch(e) { console.error('Logo upload error:', e.message); }
    res.redirect('/admin/companies/' + req.params.id + '?tab=overview');
  });

  router.post('/companies/:id/logo/remove', (req, res) => {
    const old = db.prepare('SELECT logo FROM companies WHERE id = ?').get(req.params.id);
    if (old && old.logo && old.logo.startsWith('/uploads/logos/')) {
      try { fs.unlinkSync(path.join(__dirname, '..', old.logo)); } catch(e) {}
    }
    db.prepare('UPDATE companies SET logo = NULL WHERE id = ?').run(req.params.id);
    res.redirect('/admin/companies/' + req.params.id + '?tab=overview');
  });

  router.post('/companies/:id/storage-quota', (req, res) => {
    const { storage_quota } = req.body;
    try { db.prepare('UPDATE companies SET storage_quota = ? WHERE id = ?').run(parseInt(storage_quota) || 500, req.params.id); } catch(e) {}
    res.redirect('/admin/companies/' + req.params.id + '/files');
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
      const { service_id, title, custom_price, billing_cycle, start_date, sla_response, sla_resolution, scope, notes } = req.body;
      db.prepare('INSERT INTO agreements (company_id, service_id, title, custom_price, billing_cycle, start_date, sla_response, sla_resolution, scope, notes, is_active) VALUES (?,?,?,?,?,?,?,?,?,?,1)').run(
        req.params.id, service_id || null, title || null, custom_price ? parseFloat(custom_price) : null, billing_cycle, start_date || null, sla_response || null, sla_resolution || null, scope || null, notes || null
      );
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
    if (!cols || !/^[a-z_]+$/.test(table)) return res.status(400).send('Invalid table');
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
    // Award XP
    const xpMap = {contacts:'add_contact',company_users:'add_user',servers:'add_server',subscriptions:'add_subscription',assets:'add_asset',inventory:'add_inventory'};
    if (xpMap[table]) awardXP(db, xpUser(req), xpMap[table], null, req);
    res.redirect('/admin/companies/' + req.params.id + '?tab=' + table.replace('company_', ''));
  });

  // === BULK ACTIONS (mass delete / archive) — admin only ===
  router.post('/companies/:id/:table/bulk-action', (req, res) => {
    const u = req.session.user;
    if (u.role !== 'admin' && !u.is_super) return res.status(403).send('Admin only');
    const table = req.params.table;
    const cid = req.params.id;
    const action = req.body.action; // 'delete' or 'archive'
    let ids = req.body.ids;
    if (typeof ids === 'string') ids = [ids];
    if (!ids || !Array.isArray(ids) || ids.length === 0) return res.redirect('/admin/companies/' + cid + '?tab=' + table.replace('company_', ''));

    // Validate table name
    const dbTable = table === 'users' ? 'company_users' : table;
    if (!tables[dbTable] && dbTable !== 'agreements') return res.status(400).send('Invalid table');

    const safeIds = ids.map(id => parseInt(id)).filter(id => id > 0);
    if (safeIds.length === 0) return res.redirect('/admin/companies/' + cid + '?tab=' + table.replace('company_', ''));

    const placeholders = safeIds.map(() => '?').join(',');

    try {
      if (action === 'delete') {
        db.prepare('DELETE FROM ' + dbTable + ' WHERE id IN (' + placeholders + ') AND company_id = ?').run(...safeIds, cid);
        // Clean up related records for users
        if (dbTable === 'company_users') {
          db.prepare('DELETE FROM user_emails WHERE user_id IN (' + placeholders + ') AND company_id = ?').run(...safeIds, cid);
          db.prepare('DELETE FROM user_phones WHERE user_id IN (' + placeholders + ') AND company_id = ?').run(...safeIds, cid);
          db.prepare('DELETE FROM user_division_assignments WHERE user_id IN (' + placeholders + ') AND company_id = ?').run(...safeIds, cid);
          db.prepare('DELETE FROM user_software WHERE user_id IN (' + placeholders + ') AND company_id = ?').run(...safeIds, cid);
        }
      } else if (action === 'archive') {
        // For tables with is_active: set to 0
        if (['company_users','servers','inventory','contacts'].includes(dbTable)) {
          db.prepare('UPDATE ' + dbTable + ' SET is_active = 0 WHERE id IN (' + placeholders + ') AND company_id = ?').run(...safeIds, cid);
        }
        // For subscriptions/assets: set status to 'inactive'/'archived'
        else if (['subscriptions','assets'].includes(dbTable)) {
          db.prepare("UPDATE " + dbTable + " SET status = 'inactive' WHERE id IN (" + placeholders + ") AND company_id = ?").run(...safeIds, cid);
        }
      } else if (action === 'activate') {
        if (['company_users','servers','inventory','contacts'].includes(dbTable)) {
          db.prepare('UPDATE ' + dbTable + ' SET is_active = 1 WHERE id IN (' + placeholders + ') AND company_id = ?').run(...safeIds, cid);
        } else if (['subscriptions','assets'].includes(dbTable)) {
          db.prepare("UPDATE " + dbTable + " SET status = 'active' WHERE id IN (" + placeholders + ") AND company_id = ?").run(...safeIds, cid);
        }
      }
    } catch(e) { console.error('Bulk action error:', e.message); }

    const redirectTab = table === 'users' ? 'users' : table.replace('company_', '');
    res.redirect('/admin/companies/' + cid + '?tab=' + redirectTab);
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
    const { name, category, description, price_type, base_price, is_public, show_on_landing } = req.body;
    db.prepare('INSERT INTO services (name, category, description, price_type, base_price, is_public, show_on_landing) VALUES (?,?,?,?,?,?,?)').run(name, category, description, price_type, parseFloat(base_price) || 0, is_public ? 1 : 0, show_on_landing ? 1 : 0);
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
    const { name, category, description, price_type, base_price, is_public, is_active, show_on_landing } = req.body;
    db.prepare('UPDATE services SET name=?, category=?, description=?, price_type=?, base_price=?, is_public=?, is_active=?, show_on_landing=? WHERE id=?').run(
      name, category, description, price_type, parseFloat(base_price) || 0, is_public ? 1 : 0, is_active ? 1 : 0, show_on_landing ? 1 : 0, req.params.id
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
    awardXP(db, xpUser(req), 'create_invoice', null, req);
    res.redirect(req.body.redirect || '/admin/billing');
  });

  // Invoice detail view
  router.get('/invoices/:id', (req, res) => {
    const invoice = safeGet('SELECT i.*, c.name as company_name, c.address, c.city, c.state, c.zip FROM invoices i LEFT JOIN companies c ON i.company_id = c.id WHERE i.id = ?', [req.params.id]);
    if (!invoice) return res.redirect('/admin/billing');
    const items = safeAll('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id', [invoice.id]);
    res.render(V('invoice-detail'), { user: req.session.user, invoice, items, settings: getSettings(), page: 'billing' });
  });

  // Add line item
  router.post('/invoices/:id/items', (req, res) => {
    const { description, quantity, unit_price } = req.body;
    const qty = parseFloat(quantity) || 1;
    const price = parseFloat(unit_price) || 0;
    const total = qty * price;
    db.prepare('INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total) VALUES (?,?,?,?,?)').run(req.params.id, description, qty, price, total);
    // Recalculate invoice total
    const sum = safeGet('SELECT SUM(total) as s FROM invoice_items WHERE invoice_id = ?', [req.params.id]);
    db.prepare('UPDATE invoices SET subtotal = ?, total = ? WHERE id = ?').run(sum.s || 0, sum.s || 0, req.params.id);
    res.redirect('/admin/invoices/' + req.params.id);
  });

  // Delete line item
  router.post('/invoices/:id/items/:itemId/delete', (req, res) => {
    db.prepare('DELETE FROM invoice_items WHERE id = ? AND invoice_id = ?').run(req.params.itemId, req.params.id);
    const sum = safeGet('SELECT SUM(total) as s FROM invoice_items WHERE invoice_id = ?', [req.params.id]);
    db.prepare('UPDATE invoices SET subtotal = ?, total = ? WHERE id = ?').run(sum.s || 0, sum.s || 0, req.params.id);
    res.redirect('/admin/invoices/' + req.params.id);
  });

  // Edit invoice
  router.post('/invoices/:id/edit', (req, res) => {
    const { invoice_number, date, due_date, status, notes, tax } = req.body;
    const taxAmt = parseFloat(tax) || 0;
    const sub = safeGet('SELECT SUM(total) as s FROM invoice_items WHERE invoice_id = ?', [req.params.id]);
    const total = (sub.s || 0) + taxAmt;
    db.prepare('UPDATE invoices SET invoice_number=?, date=?, due_date=?, status=?, notes=?, tax=?, subtotal=?, total=? WHERE id=?').run(
      invoice_number, date, due_date, status, notes || null, taxAmt, sub.s || 0, total, req.params.id
    );
    res.redirect('/admin/invoices/' + req.params.id);
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
    const currentUser = safeGet('SELECT totp_enabled, email, phone FROM users WHERE id = ?', [req.session.user.id]);
    const has2fa = !!(currentUser && currentUser.totp_enabled);
    const adminEmail = currentUser ? currentUser.email || '' : '';
    const adminPhone = currentUser ? currentUser.phone || '' : '';
    res.render(V('settings'), { user: req.session.user, has2fa, adminEmail, adminPhone, settings: getSettings(), page: 'settings' });
  });

  router.post('/settings', logoUpload.single('business_logo_file'), (req, res) => {
    const { business_name, business_email, business_phone, business_address } = req.body;
    const set = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    set.run('business_name', business_name || '');
    set.run('business_email', business_email || '');
    set.run('business_phone', business_phone || '');
    set.run('business_address', business_address || '');
    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase() || '.png';
      const newName = 'biz-logo-' + Date.now() + ext;
      const newPath = path.join(logoDir, newName);
      try {
        fs.renameSync(req.file.path, newPath);
        // Delete old file
        const old = safeGet("SELECT value FROM settings WHERE key = 'business_logo'");
        if (old && old.value && old.value.startsWith('/uploads/logos/')) {
          try { fs.unlinkSync(path.join(__dirname, '..', old.value)); } catch(e) {}
        }
        set.run('business_logo', '/uploads/logos/' + newName);
      } catch(e) { console.error('Biz logo upload:', e.message); }
    }
    res.redirect('/admin/settings');
  });

  router.post('/settings/profile', (req, res) => {
    const { username, full_name, email, phone } = req.body;
    try {
      db.prepare('UPDATE users SET username = ?, full_name = ?, email = ?, phone = ? WHERE id = ?').run(
        username || req.session.user.username, full_name || null, email || null, phone || null, req.session.user.id
      );
      req.session.user.username = username || req.session.user.username;
      req.session.user.full_name = full_name || req.session.user.username;
    } catch(e) { console.error('Profile update error:', e.message); }
    res.redirect('/admin/settings');
  });

  router.post('/settings/password', (req, res) => {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 8) return res.redirect('/admin/settings');
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
    awardXP(db, xpUser(req), 'add_monitor', null, req);
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
    let schWhere = ''; let schParams = [];
    if (filterCompany) { schWhere = 'WHERE ss.company_id = ?'; schParams.push(parseInt(filterCompany)); }
    const schedules = safeAll("SELECT ss.*, c.name as company_name, s.name as service_name FROM service_schedule ss LEFT JOIN companies c ON ss.company_id = c.id LEFT JOIN services s ON ss.service_id = s.id " + schWhere + " ORDER BY CASE ss.frequency WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 WHEN 'biweekly' THEN 3 WHEN 'monthly' THEN 4 WHEN 'quarterly' THEN 5 WHEN 'yearly' THEN 6 ELSE 7 END, ss.next_due ASC", schParams);
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
    let where = []; let sopParams = [];
    if (filterCo) { where.push('s.company_id = ?'); sopParams.push(parseInt(filterCo)); }
    if (filterCat) { where.push('s.category = ?'); sopParams.push(filterCat); }
    if (filterDept) { where.push('s.department = ?'); sopParams.push(filterDept); }
    if (filterRole) { where.push('s.target_role = ?'); sopParams.push(filterRole); }
    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const sops = safeAll('SELECT s.*, c.name as company_name FROM sops s LEFT JOIN companies c ON s.company_id = c.id ' + whereStr + ' ORDER BY s.is_template DESC, s.title', sopParams);
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
    awardXP(db, xpUser(req), 'create_sop', null, req);
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
    let flowWhere = ''; let flowParams = [];
    if (filterCo) { flowWhere = 'WHERE f.company_id = ?'; flowParams.push(parseInt(filterCo)); }
    const flows = safeAll('SELECT f.*, c.name as company_name FROM process_flows f LEFT JOIN companies c ON f.company_id = c.id ' + flowWhere + ' ORDER BY f.is_template DESC, f.title', flowParams);
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
    awardXP(db, xpUser(req), 'create_flow', null, req);
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
    const { type, label, description, responsible, yes_label, no_label, color, swimlane, duration, notes } = req.body;
    const maxOrder = safeGet('SELECT MAX(node_order) as m FROM flow_nodes WHERE flow_id = ?', [req.params.id]);
    try {
      db.prepare('INSERT INTO flow_nodes (flow_id, node_order, type, label, description, responsible, yes_label, no_label, color, swimlane, duration, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
        req.params.id, (maxOrder && maxOrder.m || 0) + 1, type || 'process', label, description, responsible, yes_label, no_label, color || null, swimlane || null, duration || null, notes || null
      );
    } catch(e) {}
    awardXP(db, xpUser(req), 'add_flow_node', null, req);
    res.redirect('/admin/flows/' + req.params.id);
  });

  // Edit node
  router.post('/flows/:id/nodes/:nid/edit', (req, res) => {
    const { type, label, description, responsible, yes_label, no_label, color, swimlane, duration, notes, node_order, yes_connect, no_connect } = req.body;
    try {
      db.prepare('UPDATE flow_nodes SET type=?, label=?, description=?, responsible=?, yes_label=?, no_label=?, color=?, swimlane=?, duration=?, notes=?, node_order=?, yes_connect=?, no_connect=? WHERE id=? AND flow_id=?').run(
        type || 'process', label, description || null, responsible || null, yes_label || null, no_label || null, color || null, swimlane || null, duration || null, notes || null, parseInt(node_order) || 0, yes_connect ? parseInt(yes_connect) : null, no_connect ? parseInt(no_connect) : null, req.params.nid, req.params.id
      );
    } catch(e) {}
    res.redirect('/admin/flows/' + req.params.id);
  });

  // Move node up/down
  router.post('/flows/:id/nodes/:nid/move', (req, res) => {
    const dir = req.body.direction;
    const nodes = safeAll('SELECT * FROM flow_nodes WHERE flow_id = ? ORDER BY node_order', [req.params.id]);
    const idx = nodes.findIndex(n => n.id === parseInt(req.params.nid));
    if (idx >= 0) {
      const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
      if (swapIdx >= 0 && swapIdx < nodes.length) {
        try {
          db.prepare('UPDATE flow_nodes SET node_order = ? WHERE id = ?').run(nodes[swapIdx].node_order, nodes[idx].id);
          db.prepare('UPDATE flow_nodes SET node_order = ? WHERE id = ?').run(nodes[idx].node_order, nodes[swapIdx].id);
        } catch(e) {}
      }
    }
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
    // Only update password if a new one was provided (not blank)
    if (gmail_app_password) { set.run('gmail_app_password', gmail_app_password); process.env.GMAIL_APP_PASSWORD = gmail_app_password; }
    set.run('alert_emails', alert_emails || '');
    process.env.GMAIL_USER = gmail_user || '';
    process.env.ALERT_EMAILS = alert_emails || '';
    res.redirect('/admin/integrations');
  });

  router.post('/integrations/twilio', (req, res) => {
    const { twilio_sid, twilio_token, twilio_from, alert_phones } = req.body;
    const set = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    if (twilio_sid) { set.run('twilio_sid', twilio_sid); process.env.TWILIO_ACCOUNT_SID = twilio_sid; }
    // Only update token if a new one was provided
    if (twilio_token) { set.run('twilio_token', twilio_token); process.env.TWILIO_AUTH_TOKEN = twilio_token; }
    set.run('twilio_from', twilio_from || '');
    set.run('alert_phones', alert_phones || '');
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
    // Multi-contact data
    const userEmails = safeAll('SELECT * FROM user_emails WHERE user_id = ? AND company_id = ? ORDER BY is_primary DESC, type', [usr.id, company.id]);
    const userPhones = safeAll('SELECT * FROM user_phones WHERE user_id = ? AND company_id = ? ORDER BY is_primary DESC, type', [usr.id, company.id]);
    const userDivisions = safeAll('SELECT uda.*, d.name as division_name, d.code as division_code FROM user_division_assignments uda JOIN divisions d ON uda.division_id = d.id WHERE uda.user_id = ? AND uda.company_id = ?', [usr.id, company.id]);
    const allDivisions = safeAll('SELECT * FROM divisions WHERE company_id = ? AND is_active = 1 ORDER BY name', [company.id]);
    res.render(V('user-profile'), { user: req.session.user, company, usr, manager, directReports, assignedEquip, assignedSoftware, assignedSubs, tasks, allUsers, userEmails, userPhones, userDivisions, allDivisions, settings: getSettings(), page: 'companies' });
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

  // === TERMINATE USER ===
  router.post('/companies/:cid/users/:uid/terminate', (req, res) => {
    const { cid, uid } = req.params;
    const usr = safeGet('SELECT * FROM company_users WHERE id = ? AND company_id = ?', [uid, cid]);
    if (!usr) return res.redirect('/admin/companies/' + cid + '?tab=users');
    const company = safeGet('SELECT name FROM companies WHERE id = ?', [cid]);

    // Mark user as terminated
    const now = new Date().toISOString().slice(0, 10);
    try { db.prepare('UPDATE company_users SET is_active = 0, terminated_at = ? WHERE id = ? AND company_id = ?').run(now, uid, cid); } catch(e) { console.error('Terminate user:', e.message); }

    // Gather all current accesses for the task description
    const software = safeAll('SELECT name FROM user_software WHERE user_id = ? AND company_id = ?', [uid, cid]);
    const equipment = safeAll('SELECT name, serial_number FROM inventory WHERE assigned_to = ? AND company_id = ?', [usr.name, cid]);
    const emails = safeAll('SELECT email FROM user_emails WHERE user_id = ? AND company_id = ?', [uid, cid]);
    const folders = safeAll('SELECT fa.permission, ff.name as folder_name FROM folder_access fa JOIN file_folders ff ON fa.folder_id = ff.id WHERE fa.user_name = ?', [usr.name]);
    const chatChannels = safeAll('SELECT cm.id, cc.name as channel_name FROM chat_members cm JOIN chat_channels cc ON cm.channel_id = cc.id WHERE cm.user_name = ?', [usr.name]);
    const divisions = safeAll('SELECT d.name FROM user_division_assignments uda JOIN divisions d ON uda.division_id = d.id WHERE uda.user_id = ? AND uda.company_id = ?', [uid, cid]);

    // Build checklist for the task
    let checklist = 'Employee "' + usr.name + '" from ' + (company ? company.name : 'Unknown') + ' has been terminated on ' + now + '.\n\nPlease clear all accesses:\n\n';

    if (usr.email_account) checklist += '[ ] Disable company email: ' + usr.email_account + '\n';
    if (emails.length > 0) checklist += '[ ] Remove additional emails: ' + emails.map(e => e.email).join(', ') + '\n';
    if (software.length > 0) checklist += '[ ] Revoke software licenses: ' + software.map(s => s.name).join(', ') + '\n';
    if (equipment.length > 0) checklist += '[ ] Collect equipment: ' + equipment.map(e => e.name + (e.serial_number ? ' (SN: ' + e.serial_number + ')' : '')).join(', ') + '\n';
    if (folders.length > 0) checklist += '[ ] Remove folder access: ' + folders.map(f => f.folder_name + ' (' + f.permission + ')').join(', ') + '\n';
    if (chatChannels.length > 0) checklist += '[ ] Remove from chat channels: ' + chatChannels.map(c => c.channel_name).join(', ') + '\n';
    if (divisions.length > 0) checklist += '[ ] Remove from divisions: ' + divisions.map(d => d.name).join(', ') + '\n';
    if (usr.access_level && usr.access_level !== 'none') checklist += '[ ] Revoke access level: ' + usr.access_level + '\n';

    checklist += '[ ] Disable any VPN / RDP access\n';
    checklist += '[ ] Remove from any shared password vaults\n';
    checklist += '[ ] Notify manager and HR\n';

    // Create automated task
    try {
      db.prepare('INSERT INTO tasks (title, description, company_id, related_table, related_id, priority, status, assigned_to, created_by) VALUES (?,?,?,?,?,?,?,?,?)').run(
        'Clear all accesses for terminated employee: ' + usr.name,
        checklist,
        cid,
        'company_users',
        uid,
        'urgent',
        'todo',
        'admin',
        xpUser(req)
      );
    } catch(e) { console.error('Create termination task:', e.message); }

    awardXP(db, xpUser(req), 'create_task', null, req);
    res.redirect('/admin/companies/' + cid + '/users/' + uid + '/profile');
  });

  // === USER EMAILS ===
  router.post('/companies/:cid/users/:uid/emails', (req, res) => {
    const { email, type, is_primary, notes } = req.body;
    if (!email) return res.redirect('/admin/companies/' + req.params.cid + '/users/' + req.params.uid + '/profile');
    if (is_primary) { try { db.prepare('UPDATE user_emails SET is_primary = 0 WHERE user_id = ? AND company_id = ?').run(req.params.uid, req.params.cid); } catch(e) {} }
    try { db.prepare('INSERT INTO user_emails (company_id, user_id, email, type, is_primary, notes) VALUES (?,?,?,?,?,?)').run(req.params.cid, req.params.uid, email, type || 'work', is_primary ? 1 : 0, notes || null); } catch(e) { console.error('Add email:', e.message); }
    res.redirect('/admin/companies/' + req.params.cid + '/users/' + req.params.uid + '/profile');
  });
  router.post('/companies/:cid/users/:uid/emails/:eid/delete', (req, res) => {
    try { db.prepare('DELETE FROM user_emails WHERE id = ? AND user_id = ? AND company_id = ?').run(req.params.eid, req.params.uid, req.params.cid); } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/users/' + req.params.uid + '/profile');
  });
  router.post('/companies/:cid/users/:uid/emails/:eid/primary', (req, res) => {
    try {
      db.prepare('UPDATE user_emails SET is_primary = 0 WHERE user_id = ? AND company_id = ?').run(req.params.uid, req.params.cid);
      db.prepare('UPDATE user_emails SET is_primary = 1 WHERE id = ? AND user_id = ? AND company_id = ?').run(req.params.eid, req.params.uid, req.params.cid);
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/users/' + req.params.uid + '/profile');
  });

  // === USER PHONES ===
  router.post('/companies/:cid/users/:uid/phones', (req, res) => {
    const { phone, ext, type, is_primary, notes } = req.body;
    if (!phone) return res.redirect('/admin/companies/' + req.params.cid + '/users/' + req.params.uid + '/profile');
    if (is_primary) { try { db.prepare('UPDATE user_phones SET is_primary = 0 WHERE user_id = ? AND company_id = ?').run(req.params.uid, req.params.cid); } catch(e) {} }
    try { db.prepare('INSERT INTO user_phones (company_id, user_id, phone, ext, type, is_primary, notes) VALUES (?,?,?,?,?,?,?)').run(req.params.cid, req.params.uid, phone, ext || null, type || 'work', is_primary ? 1 : 0, notes || null); } catch(e) { console.error('Add phone:', e.message); }
    res.redirect('/admin/companies/' + req.params.cid + '/users/' + req.params.uid + '/profile');
  });
  router.post('/companies/:cid/users/:uid/phones/:pid/delete', (req, res) => {
    try { db.prepare('DELETE FROM user_phones WHERE id = ? AND user_id = ? AND company_id = ?').run(req.params.pid, req.params.uid, req.params.cid); } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/users/' + req.params.uid + '/profile');
  });
  router.post('/companies/:cid/users/:uid/phones/:pid/primary', (req, res) => {
    try {
      db.prepare('UPDATE user_phones SET is_primary = 0 WHERE user_id = ? AND company_id = ?').run(req.params.uid, req.params.cid);
      db.prepare('UPDATE user_phones SET is_primary = 1 WHERE id = ? AND user_id = ? AND company_id = ?').run(req.params.pid, req.params.uid, req.params.cid);
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/users/' + req.params.uid + '/profile');
  });

  // === DIVISIONS (company-level) ===
  router.get('/companies/:cid/divisions', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.cid);
    if (!company) return res.redirect('/admin/companies');
    const divisions = safeAll('SELECT d.*, h.name as head_name, p.name as parent_name, (SELECT COUNT(*) FROM user_division_assignments WHERE division_id = d.id) as member_count FROM divisions d LEFT JOIN company_users h ON d.head_id = h.id LEFT JOIN divisions p ON d.parent_id = p.id WHERE d.company_id = ? ORDER BY d.name', [company.id]);
    const allUsers = safeAll('SELECT id, name, title FROM company_users WHERE company_id = ? AND is_active = 1 ORDER BY name', [company.id]);
    res.render(V('divisions'), { user: req.session.user, company, divisions, allUsers, settings: getSettings(), page: 'companies' });
  });
  router.post('/companies/:cid/divisions', (req, res) => {
    const { name, code, parent_id, head_id, notes } = req.body;
    if (!name) return res.redirect('/admin/companies/' + req.params.cid + '/divisions');
    try { db.prepare('INSERT INTO divisions (company_id, name, code, parent_id, head_id, notes) VALUES (?,?,?,?,?,?)').run(req.params.cid, name, code || null, parent_id || null, head_id || null, notes || null); } catch(e) { console.error('Division create:', e.message); }
    res.redirect('/admin/companies/' + req.params.cid + '/divisions');
  });
  router.post('/companies/:cid/divisions/:did/edit', (req, res) => {
    const { name, code, parent_id, head_id, notes } = req.body;
    try { db.prepare('UPDATE divisions SET name=?, code=?, parent_id=?, head_id=?, notes=? WHERE id=? AND company_id=?').run(name, code || null, parent_id || null, head_id || null, notes || null, req.params.did, req.params.cid); } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/divisions');
  });
  router.post('/companies/:cid/divisions/:did/deactivate', (req, res) => {
    const old = safeGet('SELECT is_active FROM divisions WHERE id = ? AND company_id = ?', [req.params.did, req.params.cid]);
    if (old) { try { db.prepare('UPDATE divisions SET is_active = ? WHERE id = ? AND company_id = ?').run(old.is_active ? 0 : 1, req.params.did, req.params.cid); } catch(e) {} }
    res.redirect('/admin/companies/' + req.params.cid + '/divisions');
  });

  // === USER DIVISION ASSIGNMENTS ===
  router.post('/companies/:cid/users/:uid/divisions', (req, res) => {
    const { division_id, role_in_division, is_primary } = req.body;
    if (!division_id) return res.redirect('/admin/companies/' + req.params.cid + '/users/' + req.params.uid + '/profile');
    if (is_primary) { try { db.prepare('UPDATE user_division_assignments SET is_primary = 0 WHERE user_id = ? AND company_id = ?').run(req.params.uid, req.params.cid); } catch(e) {} }
    try { db.prepare('INSERT INTO user_division_assignments (company_id, user_id, division_id, role_in_division, is_primary) VALUES (?,?,?,?,?)').run(req.params.cid, req.params.uid, division_id, role_in_division || null, is_primary ? 1 : 0); } catch(e) { console.error('Assign division:', e.message); }
    res.redirect('/admin/companies/' + req.params.cid + '/users/' + req.params.uid + '/profile');
  });
  router.post('/companies/:cid/users/:uid/divisions/:aid/delete', (req, res) => {
    try { db.prepare('DELETE FROM user_division_assignments WHERE id = ? AND user_id = ? AND company_id = ?').run(req.params.aid, req.params.uid, req.params.cid); } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/users/' + req.params.uid + '/profile');
  });

  // === CSV IMPORT / EXPORT ===
  const csvTableConfig = {
    contacts:      { fields: ['name','role','email','phone','is_primary'], label: 'Contacts' },
    users:         { fields: ['name','title','email','phone','phone_ext','direct_phone','direct_ext','mobile_phone','department','role','email_account','personal_email','hire_date','photo_url','is_active'], label: 'Users', dbTable: 'company_users', extraContactFields: ['phone_ext','direct_phone','direct_ext','mobile_phone','personal_email'] },
    servers:       { fields: ['name','type','ip','os','purpose','location','is_active','notes'], label: 'Servers' },
    subscriptions: { fields: ['name','vendor','type','seats','cost_per_unit','billing_cycle','renewal_date','auto_renew','notes'], label: 'Subscriptions' },
    assets:        { fields: ['name','type','provider','expires_at','login_url','notes'], label: 'Assets' },
    inventory:     { fields: ['name','type','manufacturer','model','serial_number','quantity','cost','condition','assigned_to','purchase_date','warranty_expires','notes'], label: 'Inventory' }
  };

  // Download CSV template (blank)
  router.get('/companies/:cid/:table/csv-template', (req, res) => {
    const cfg = csvTableConfig[req.params.table];
    if (!cfg) return res.status(404).send('Unknown table');
    let fields = cfg.fields;
    let csv = fields.join(',') + '\n';
    // Add example row for users
    if (req.params.table === 'users') {
      csv += 'John Smith,Sr Dispatcher,john@gmail.com,555-0100,1234,555-0150,5678,555-9999,Operations,Dispatcher,john@company.com,john.personal@gmail.com,2025-01-15,,1\n';
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=' + req.params.table + '-template.csv');
    res.send(csv);
  });

  // Export current data as CSV
  router.get('/companies/:cid/:table/csv-export', (req, res) => {
    const cfg = csvTableConfig[req.params.table];
    if (!cfg) return res.status(404).send('Unknown table');
    const cid = req.params.cid;
    const dbTable = cfg.dbTable || req.params.table;
    const rows = safeAll('SELECT * FROM ' + dbTable + ' WHERE company_id = ? ORDER BY name', [cid]);

    // For users: enrich with multi-contact data
    if (req.params.table === 'users') {
      const allEmails = safeAll('SELECT user_id, email, type, ext FROM user_emails WHERE company_id = ? ORDER BY is_primary DESC', [cid]);
      const allPhones = safeAll('SELECT user_id, phone, ext, type FROM user_phones WHERE company_id = ? ORDER BY is_primary DESC', [cid]);
      const allDivAssign = safeAll('SELECT uda.user_id, d.name as division_name, uda.role_in_division FROM user_division_assignments uda JOIN divisions d ON uda.division_id = d.id WHERE uda.company_id = ?', [cid]);
      const emailMap = {}, phoneMap = {}, divMap = {};
      allEmails.forEach(e => { if (!emailMap[e.user_id]) emailMap[e.user_id] = []; emailMap[e.user_id].push(e.email + (e.type ? ' (' + e.type + ')' : '')); });
      allPhones.forEach(p => { if (!phoneMap[p.user_id]) phoneMap[p.user_id] = []; phoneMap[p.user_id].push(p.phone + (p.ext ? ' x' + p.ext : '') + (p.type ? ' (' + p.type + ')' : '')); });
      allDivAssign.forEach(d => { if (!divMap[d.user_id]) divMap[d.user_id] = []; divMap[d.user_id].push(d.division_name + (d.role_in_division ? ' (' + d.role_in_division + ')' : '')); });
      rows.forEach(r => {
        r.all_emails = (emailMap[r.id] || []).join('; ');
        r.all_phones = (phoneMap[r.id] || []).join('; ');
        r.divisions = (divMap[r.id] || []).join('; ');
      });
      const enrichedFields = [...cfg.fields, 'all_emails', 'all_phones', 'divisions'];
      const csv = toCSV(enrichedFields, rows);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=users-export.csv');
      return res.send(csv);
    }

    const csv = toCSV(cfg.fields, rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=' + req.params.table + '-export.csv');
    res.send(csv);
  });

  // ================================================================
  //  CSV IMPORT WIZARD (multi-step: upload → map → preview/commit)
  // ================================================================
  const importDir = path.join(uploadDir, 'csv-staging');
  if (!fs.existsSync(importDir)) fs.mkdirSync(importDir, { recursive: true });
  const crypto = require('crypto');

  // Step 1: Upload → parse → show mapping page
  router.post('/companies/:cid/:table/csv-import', upload.single('csvfile'), (req, res) => {
    const { cid, table } = req.params;
    const cfg = csvTableConfig[table];
    if (!cfg || !req.file) return res.redirect('/admin/companies/' + cid + '?tab=' + table);

    try {
      const text = fs.readFileSync(req.file.path, 'utf-8');
      const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
      if (lines.length < 2) { fs.unlinkSync(req.file.path); return res.redirect('/admin/companies/' + cid + '?tab=' + table + '&importError=CSV+is+empty'); }

      // Parse header + raw rows
      const parseLine = (line) => { const fields=[]; let cur='',inQ=false; for(let i=0;i<line.length;i++){const ch=line[i]; if(ch==='"'){if(inQ&&line[i+1]==='"'){cur+='"';i++;}else{inQ=!inQ;}} else if(ch===','&&!inQ){fields.push(cur.trim());cur='';}else{cur+=ch;}} fields.push(cur.trim()); return fields; };
      const rawHeaders = parseLine(lines[0]);
      const dataRows = [];
      for (let i = 1; i < lines.length; i++) { const v = parseLine(lines[i]); if (v.some(x => x)) dataRows.push(v); }

      // Auto-suggest mapping
      const allFields = cfg.fields;
      const normHeaders = rawHeaders.map(h => h.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, ''));
      const autoMap = {};
      normHeaders.forEach((nh, i) => { if (allFields.includes(nh)) autoMap[i] = nh; });

      // Save staging file
      const token = crypto.randomBytes(16).toString('hex');
      const staging = { token, cid: parseInt(cid), table, filename: req.file.originalname, rawHeaders, dataRows, mapping: autoMap };
      fs.writeFileSync(path.join(importDir, 'csv-' + token + '.json'), JSON.stringify(staging));
      fs.unlinkSync(req.file.path);

      const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(cid);
      res.render(V('csv-import-wizard'), {
        user: req.session.user, company, step: 'map', staging, cfg,
        sampleRows: dataRows.slice(0, 5), importErr: null, commitResult: null,
        settings: getSettings(), page: 'companies'
      });
    } catch(e) {
      console.error('CSV import upload error:', e.message);
      try { fs.unlinkSync(req.file.path); } catch(x) {}
      res.redirect('/admin/companies/' + cid + '?tab=' + table + '&importError=' + encodeURIComponent(e.message));
    }
  });

  // Step 2: Apply mapping → preview + commit
  router.post('/companies/:cid/:table/csv-commit', (req, res) => {
    const { cid, table } = req.params;
    const cfg = csvTableConfig[table];
    if (!cfg) return res.redirect('/admin/companies/' + cid + '?tab=' + table);
    const dbTable = cfg.dbTable || table;
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(cid);
    if (!company) return res.redirect('/admin/companies');

    const token = req.body.token;
    let staging;
    try { staging = JSON.parse(fs.readFileSync(path.join(importDir, 'csv-' + token + '.json'), 'utf-8')); }
    catch(e) { return res.redirect('/admin/companies/' + cid + '?tab=' + table + '&importError=Import+session+expired'); }
    if (staging.cid !== parseInt(cid)) return res.status(403).send('Access denied');

    // Read user's column mapping
    const mapping = {};
    cfg.fields.forEach(field => {
      const colIdx = req.body['map_' + field];
      if (colIdx !== undefined && colIdx !== '' && colIdx !== '-1') mapping[parseInt(colIdx)] = field;
    });

    // Validate required: name column
    const mappedFields = Object.values(mapping);
    if (!mappedFields.includes('name')) {
      return res.render(V('csv-import-wizard'), {
        user: req.session.user, company, step: 'map', staging: { ...staging, mapping }, cfg,
        sampleRows: staging.dataRows.slice(0, 5), importErr: 'You must map at least the "name" column.',
        commitResult: null, settings: getSettings(), page: 'companies'
      });
    }

    // Build mapped rows
    const extraContactFields = cfg.extraContactFields || [];
    const coreFields = Object.values(mapping).filter(f => !extraContactFields.includes(f));

    try {
      let imported = 0, skipped = 0;
      const errors = [];

      const insertStmt = db.prepare('INSERT INTO ' + dbTable + ' (company_id, ' + coreFields.join(',') + ') VALUES (?, ' + coreFields.map(() => '?').join(',') + ')');

      let insPhone, insEmail;
      if (table === 'users') {
        insPhone = db.prepare('INSERT INTO user_phones (company_id, user_id, phone, ext, type, is_primary) VALUES (?,?,?,?,?,?)');
        insEmail = db.prepare('INSERT INTO user_emails (company_id, user_id, email, type, is_primary) VALUES (?,?,?,?,?)');
      }

      const invertMap = {};
      Object.entries(mapping).forEach(([col, field]) => { invertMap[field] = parseInt(col); });

      const importTx = db.transaction(() => {
        for (let i = 0; i < staging.dataRows.length; i++) {
          const vals = staging.dataRows[i];
          const row = {};
          Object.entries(mapping).forEach(([col, field]) => { row[field] = vals[parseInt(col)] || ''; });

          if (!row.name || !row.name.trim()) { skipped++; continue; }

          // Build insert values for core fields only
          const insertVals = coreFields.map(f => {
            let v = row[f] || '';
            if (['is_active','is_primary','auto_renew'].includes(f)) return (v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes') ? 1 : 0;
            if (['seats','cost_per_unit','cost'].includes(f)) return parseFloat(v) || 0;
            if (f === 'quantity') return parseInt(v) || 1;
            return v || null;
          });

          try {
            const result = insertStmt.run(cid, ...insertVals);
            const newId = result.lastInsertRowid;
            imported++;

            // For users: create phone/email records from extra fields
            if (table === 'users' && newId) {
              if (row.phone && row.phone_ext) { try { insPhone.run(cid, newId, row.phone, row.phone_ext, 'work', 1); } catch(e) {} }
              if (row.direct_phone) { try { insPhone.run(cid, newId, row.direct_phone, row.direct_ext || null, 'work', 0); } catch(e) {} }
              if (row.mobile_phone) { try { insPhone.run(cid, newId, row.mobile_phone, null, 'mobile', 0); } catch(e) {} }
              if (row.personal_email) { try { insEmail.run(cid, newId, row.personal_email, 'personal', 0); } catch(e) {} }
              if (row.email_account) { try { insEmail.run(cid, newId, row.email_account, 'work', 1); } catch(e) {} }
            }
          } catch(e) {
            errors.push({ line: i + 2, error: e.message });
          }
        }
      });
      importTx();

      // Cleanup staging
      try { fs.unlinkSync(path.join(importDir, 'csv-' + token + '.json')); } catch(e) {}

      if (imported > 0) awardXP(db, xpUser(req), 'csv_import', 'Imported ' + imported + ' ' + table, req);

      res.render(V('csv-import-wizard'), {
        user: req.session.user, company, step: 'done', staging, cfg,
        sampleRows: null, importErr: null,
        commitResult: { imported, skipped, errors: errors.length, errorDetails: errors.slice(0, 10) },
        settings: getSettings(), page: 'companies'
      });
    } catch(e) {
      console.error('CSV import commit error:', e.message);
      try { fs.unlinkSync(path.join(importDir, 'csv-' + token + '.json')); } catch(x) {}
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


  // === SECURITY POLICIES ===
  router.get('/policies', (req, res) => {
    const filterCo = req.query.company || '';
    let polWhere = ''; let polParams = [];
    if (filterCo) { polWhere = 'WHERE p.company_id = ?'; polParams.push(parseInt(filterCo)); }
    const policies = safeAll('SELECT p.*, c.name as company_name FROM security_policies p LEFT JOIN companies c ON p.company_id = c.id ' + polWhere + ' ORDER BY p.company_id IS NULL DESC, p.title', polParams);
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
    awardXP(db, xpUser(req), 'create_policy', null, req);
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
    let vaultWhere = []; let vaultParams = [];
    if (filterCo) { vaultWhere.push('v.company_id = ?'); vaultParams.push(parseInt(filterCo)); }
    if (filterCat) { vaultWhere.push('v.category = ?'); vaultParams.push(filterCat); }
    const whereStr = vaultWhere.length ? 'WHERE ' + vaultWhere.join(' AND ') : '';
    const entries = safeAll('SELECT v.*, c.name as company_name FROM password_vault v LEFT JOIN companies c ON v.company_id = c.id ' + whereStr + ' ORDER BY v.category, v.title', vaultParams);
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
    awardXP(db, xpUser(req), 'add_password', null, req);
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

  // === ADMIN MANAGEMENT (super admin only) ===
  router.get('/admins', (req, res) => {
    if (!req.session.user.is_super) return res.redirect('/admin');
    const admins = safeAll("SELECT * FROM users WHERE role IN ('admin','company_admin') ORDER BY is_super DESC, username");
    admins.forEach(a => {
      a.companies = safeAll('SELECT ac.company_id, c.name FROM admin_companies ac JOIN companies c ON ac.company_id = c.id WHERE ac.user_id = ?', [a.id]);
    });
    const companies = safeAll('SELECT id, name FROM companies ORDER BY name');
    res.render(V('admins'), { user: req.session.user, admins, companies, settings: getSettings(), page: 'settings' });
  });

  router.post('/admins', (req, res) => {
    if (!req.session.user.is_super) return res.redirect('/admin');
    const { username, password, full_name, email, is_super, company_ids } = req.body;
    if (!username || !password) return res.redirect('/admin/admins');
    try {
      const hash = bcrypt.hashSync(password, 10);
      const role = is_super ? 'admin' : 'company_admin';
      const r = db.prepare('INSERT INTO users (username, password, role, full_name, email, is_super, is_active) VALUES (?,?,?,?,?,?,1)').run(
        username, hash, role, full_name || null, email || null, is_super ? 1 : 0
      );
      // Assign companies
      if (!is_super && company_ids) {
        const ids = Array.isArray(company_ids) ? company_ids : [company_ids];
        ids.forEach(cid => {
          try { db.prepare('INSERT INTO admin_companies (user_id, company_id) VALUES (?,?)').run(r.lastInsertRowid, parseInt(cid)); } catch(e) {}
        });
      }
    } catch(e) { console.error('Create admin error:', e.message); }
    res.redirect('/admin/admins');
  });

  router.post('/admins/:id/companies', (req, res) => {
    if (!req.session.user.is_super) return res.redirect('/admin');
    const { company_ids } = req.body;
    db.prepare('DELETE FROM admin_companies WHERE user_id = ?').run(req.params.id);
    if (company_ids) {
      const ids = Array.isArray(company_ids) ? company_ids : [company_ids];
      ids.forEach(cid => {
        try { db.prepare('INSERT INTO admin_companies (user_id, company_id) VALUES (?,?)').run(req.params.id, parseInt(cid)); } catch(e) {}
      });
    }
    res.redirect('/admin/admins');
  });

  router.post('/admins/:id/delete', (req, res) => {
    if (!req.session.user.is_super) return res.redirect('/admin');
    if (parseInt(req.params.id) === req.session.user.id) return res.redirect('/admin/admins'); // can't delete yourself
    try {
      db.prepare('DELETE FROM admin_companies WHERE user_id = ?').run(req.params.id);
      db.prepare('DELETE FROM users WHERE id = ? AND role IN (?,?)').run(req.params.id, 'admin', 'company_admin');
    } catch(e) {}
    res.redirect('/admin/admins');
  });

  // === CHAT PAGE ===
  router.get('/chat', (req, res) => {
    const companies = safeAll('SELECT id, name FROM companies ORDER BY name');
    res.render(V('chat'), { user: req.session.user, companies, settings: getSettings(), page: 'chat' });
  });

  return router;
};
