const express = require('express');
const router = express.Router();
const { requireLogin } = require('../middleware/auth');

module.exports = function(db) {
  router.use(requireLogin);

  router.use((req, res, next) => {
    if (req.session.user.role !== 'client') return res.redirect('/admin');
    if (!req.session.user.company_id) return res.redirect('/login');
    next();
  });

  const getSettings = () => {
    const s = {};
    try { db.prepare('SELECT key, value FROM settings').all().forEach(r => { s[r.key] = r.value; }); } catch(e) {}
    return s;
  };

  const safeAll = (sql, params) => { try { return params ? db.prepare(sql).all(...(Array.isArray(params)?params:[params])) : db.prepare(sql).all(); } catch(e) { return []; } };
  const safeGet = (sql, params) => { try { return params ? db.prepare(sql).get(...(Array.isArray(params)?params:[params])) : db.prepare(sql).get(); } catch(e) { return null; } };

  // Client dashboard + tabs
  router.get('/', (req, res) => {
    const cid = req.session.user.company_id;
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(cid);
    if (!company) return res.redirect('/login');
    const users = safeAll('SELECT * FROM company_users WHERE company_id = ?', [cid]);
    const servers = safeAll('SELECT * FROM servers WHERE company_id = ?', [cid]);
    const subs = safeAll('SELECT * FROM subscriptions WHERE company_id = ?', [cid]);
    const assets = safeAll('SELECT * FROM assets WHERE company_id = ?', [cid]);
    const inventory = safeAll('SELECT * FROM inventory WHERE company_id = ?', [cid]);
    const invoices = safeAll('SELECT * FROM invoices WHERE company_id = ? ORDER BY date DESC', [cid]);
    const unpaid = invoices.filter(i => i.status === 'sent' || i.status === 'overdue');
    const contacts = safeAll('SELECT * FROM contacts WHERE company_id = ? ORDER BY is_primary DESC', [cid]);
    const tasks = safeAll("SELECT * FROM tasks WHERE company_id = ? ORDER BY CASE status WHEN 'todo' THEN 1 WHEN 'in-progress' THEN 2 ELSE 3 END, created_at DESC", [cid]);
    const software = safeAll('SELECT us.*, cu.name as user_name FROM user_software us LEFT JOIN company_users cu ON us.user_id = cu.id WHERE us.company_id = ?', [cid]);
    const emailCount = users.filter(u => u.email_account).length;
    const phoneCount = users.filter(u => u.phone).length;
    const roles = safeAll('SELECT * FROM roles ORDER BY sort_order');
    const depts = safeAll('SELECT * FROM departments ORDER BY sort_order');
    const tab = req.query.tab || 'dashboard';
    res.render('client/portal', { user: req.session.user, company, users, servers, subs, assets, inventory, invoices, unpaid, contacts, tasks, software, emailCount, phoneCount, roles, depts, tab, settings: getSettings(), page: 'client' });
  });

  // === ADD RECORDS (client can add, not delete) ===
  router.post('/users', (req, res) => {
    const cid = req.session.user.company_id;
    const { name, title, email, phone, department, role, email_account } = req.body;
    if (!name) return res.redirect('/client?tab=users');
    try {
      db.prepare('INSERT INTO company_users (company_id, name, title, email, phone, department, role, email_account, is_active) VALUES (?,?,?,?,?,?,?,?,1)').run(
        cid, name, title || null, email || null, phone || null, department || null, role || null, email_account || null
      );
    } catch(e) {}
    res.redirect('/client?tab=users');
  });

  router.post('/servers', (req, res) => {
    const cid = req.session.user.company_id;
    const { name, type, ip, os, purpose, location, notes } = req.body;
    if (!name) return res.redirect('/client?tab=servers');
    try {
      db.prepare('INSERT INTO servers (company_id, name, type, ip, os, purpose, location, notes) VALUES (?,?,?,?,?,?,?,?)').run(
        cid, name, type || null, ip || null, os || null, purpose || null, location || null, notes || null
      );
    } catch(e) {}
    res.redirect('/client?tab=servers');
  });

  router.post('/subscriptions', (req, res) => {
    const cid = req.session.user.company_id;
    const { name, vendor, type, seats, cost_per_unit, billing_cycle, renewal_date, notes } = req.body;
    if (!name) return res.redirect('/client?tab=subscriptions');
    try {
      db.prepare('INSERT INTO subscriptions (company_id, name, vendor, type, seats, cost_per_unit, billing_cycle, renewal_date, notes) VALUES (?,?,?,?,?,?,?,?,?)').run(
        cid, name, vendor || null, type || null, parseInt(seats) || 1, parseFloat(cost_per_unit) || 0, billing_cycle || 'Monthly', renewal_date || null, notes || null
      );
    } catch(e) {}
    res.redirect('/client?tab=subscriptions');
  });

  router.post('/assets', (req, res) => {
    const cid = req.session.user.company_id;
    const { name, type, provider, expires_at, login_url, notes } = req.body;
    if (!name) return res.redirect('/client?tab=assets');
    try {
      db.prepare('INSERT INTO assets (company_id, name, type, provider, expires_at, login_url, notes) VALUES (?,?,?,?,?,?,?)').run(
        cid, name, type || null, provider || null, expires_at || null, login_url || null, notes || null
      );
    } catch(e) {}
    res.redirect('/client?tab=assets');
  });

  router.post('/inventory', (req, res) => {
    const cid = req.session.user.company_id;
    const { name, type, manufacturer, model, serial_number, quantity, cost, condition, notes } = req.body;
    if (!name) return res.redirect('/client?tab=inventory');
    try {
      db.prepare('INSERT INTO inventory (company_id, name, type, manufacturer, model, serial_number, quantity, cost, condition, notes) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
        cid, name, type || null, manufacturer || null, model || null, serial_number || null, parseInt(quantity) || 1, parseFloat(cost) || 0, condition || 'New', notes || null
      );
    } catch(e) {}
    res.redirect('/client?tab=inventory');
  });

  // Client submits a task/request
  router.post('/tasks', (req, res) => {
    const cid = req.session.user.company_id;
    const { title, description, priority } = req.body;
    if (!title) return res.redirect('/client?tab=tasks');
    try {
      db.prepare("INSERT INTO tasks (title, description, company_id, priority, status, assigned_to, created_by) VALUES (?,?,?,?,'todo','admin','client')").run(
        title, description || '', cid, priority || 'medium'
      );
    } catch(e) {}
    res.redirect('/client?tab=tasks');
  });

  // === PROJECTS (view only) ===
  router.get('/projects', (req, res) => {
    const cid = req.session.user.company_id;
    const projects = safeAll('SELECT * FROM projects WHERE company_id = ? ORDER BY status ASC, due_date ASC', [cid]);
    projects.forEach(p => {
      const counts = safeAll('SELECT status, COUNT(*) as cnt FROM tasks WHERE project_id = ? GROUP BY status', [p.id]);
      p.taskTotal = counts.reduce((s, c) => s + c.cnt, 0);
      p.taskDone = (counts.find(c => c.status === 'done') || {}).cnt || 0;
    });
    const statuses = safeAll('SELECT * FROM project_statuses ORDER BY sort_order');
    res.render('client/projects', { user: req.session.user, projects, statuses, settings: getSettings(), page: 'projects' });
  });

  // === SOPs (view + acknowledge) ===
  router.get('/sops', (req, res) => {
    const cid = req.session.user.company_id;
    const sops = safeAll("SELECT * FROM sops WHERE (company_id = ? OR company_id IS NULL) AND status = 'published' ORDER BY title", [cid]);
    res.render('client/sops', { user: req.session.user, sops, settings: getSettings(), page: 'sops' });
  });

  router.get('/sops/:id', (req, res) => {
    const cid = req.session.user.company_id;
    const sop = safeGet("SELECT * FROM sops WHERE id = ? AND (company_id = ? OR company_id IS NULL) AND status = 'published'", [req.params.id, cid]);
    if (!sop) return res.redirect('/client/sops');
    const steps = safeAll('SELECT * FROM sop_steps WHERE sop_id = ? ORDER BY step_number', [sop.id]);
    const myAck = safeGet('SELECT * FROM sop_acknowledgments WHERE sop_id = ? AND user_name = ?', [sop.id, req.session.user.full_name || req.session.user.username]);
    res.render('client/sop-view', { user: req.session.user, sop, steps, myAck, settings: getSettings(), page: 'sops' });
  });

  router.post('/sops/:id/acknowledge', (req, res) => {
    const cid = req.session.user.company_id;
    const name = req.session.user.full_name || req.session.user.username;
    try {
      db.prepare('INSERT INTO sop_acknowledgments (sop_id, user_name, company_id) VALUES (?,?,?)').run(req.params.id, name, cid);
    } catch(e) {}
    res.redirect('/client/sops/' + req.params.id);
  });

  // === PASSWORDS (view shared ones only) ===
  router.get('/passwords', (req, res) => {
    const cid = req.session.user.company_id;
    const entries = safeAll("SELECT * FROM password_vault WHERE company_id = ? AND share_type != 'private' ORDER BY category, title", [cid]);
    res.render('client/passwords', { user: req.session.user, entries, settings: getSettings(), page: 'passwords' });
  });

  // === POLICIES (view + acknowledge) ===
  router.get('/policies', (req, res) => {
    const cid = req.session.user.company_id;
    const policies = safeAll("SELECT * FROM security_policies WHERE (company_id = ? OR company_id IS NULL) AND status = 'published' ORDER BY title", [cid]);
    res.render('client/policies', { user: req.session.user, policies, settings: getSettings(), page: 'policies' });
  });

  router.get('/policies/:id', (req, res) => {
    const cid = req.session.user.company_id;
    const policy = safeGet("SELECT * FROM security_policies WHERE id = ? AND (company_id = ? OR company_id IS NULL) AND status = 'published'", [req.params.id, cid]);
    if (!policy) return res.redirect('/client/policies');
    const myAck = safeGet('SELECT * FROM policy_acknowledgments WHERE policy_id = ? AND user_name = ?', [policy.id, req.session.user.full_name || req.session.user.username]);
    res.render('client/policy-view', { user: req.session.user, policy, myAck, settings: getSettings(), page: 'policies' });
  });

  router.post('/policies/:id/acknowledge', (req, res) => {
    const cid = req.session.user.company_id;
    const name = req.session.user.full_name || req.session.user.username;
    try {
      db.prepare('INSERT INTO policy_acknowledgments (policy_id, user_name, company_id) VALUES (?,?,?)').run(req.params.id, name, cid);
    } catch(e) {}
    res.redirect('/client/policies/' + req.params.id);
  });

  router.get('/services', (req, res) => {
    const services = safeAll('SELECT * FROM services WHERE is_public = 1 AND is_active = 1 ORDER BY name');
    res.render('client/services', { user: req.session.user, services, settings: getSettings(), page: 'services' });
  });

  // Chat page
  router.get('/chat', (req, res) => {
    res.render('client/chat', { user: req.session.user, settings: getSettings(), page: 'chat' });
  });

  return router;
};
