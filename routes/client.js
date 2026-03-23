const express = require('express');
const router = express.Router();
const { requireLogin } = require('../middleware/auth');

module.exports = function(db) {
  router.use(requireLogin);

  const { getRank, getUserXP, awardXP, checkDailyLogin } = require('../lib/xp');

  router.use((req, res, next) => {
    if (req.session.user.role !== 'client') return res.redirect('/admin');
    if (!req.session.user.company_id) return res.redirect('/login');
    const username = req.session.user.full_name || req.session.user.username;
    const totalXp = getUserXP(db, username);
    res.locals.userRank = getRank(totalXp);
    if (req.session.xpFlash) {
      res.locals.xpFlash = req.session.xpFlash;
      delete req.session.xpFlash;
    }
    checkDailyLogin(db, username);
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
    const emailCount = users.filter(u => u.email || u.email_account).length;
    const phoneCount = users.filter(u => u.phone).length;
    const roles = safeAll('SELECT * FROM roles ORDER BY sort_order');
    const depts = safeAll('SELECT * FROM departments ORDER BY sort_order');
    const tab = req.query.tab || 'dashboard';
    const search = req.query.q || '';
    // Files
    const folders = safeAll('SELECT * FROM file_folders WHERE company_id = ? ORDER BY name', [cid]);
    const folderId = req.query.folder || '';
    const files = folderId
      ? safeAll('SELECT * FROM company_files WHERE company_id = ? AND folder_id = ? ORDER BY created_at DESC', [cid, folderId])
      : safeAll('SELECT * FROM company_files WHERE company_id = ? ORDER BY created_at DESC LIMIT 50', [cid]);
    // Divisions
    const divisions = safeAll('SELECT * FROM divisions WHERE company_id = ? AND is_active = 1 ORDER BY name', [cid]);
    res.render('client/portal', { user: req.session.user, company, users, servers, subs, assets, inventory, invoices, unpaid, contacts, tasks, software, emailCount, phoneCount, roles, depts, tab, search, folders, files, folderId, divisions, settings: getSettings(), page: 'client' });
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
    awardXP(db, req.session.user.full_name || req.session.user.username, 'add_user', null, req);
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
    awardXP(db, req.session.user.full_name || req.session.user.username, 'add_server', null, req);
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
    awardXP(db, req.session.user.full_name || req.session.user.username, 'add_subscription', null, req);
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
    awardXP(db, req.session.user.full_name || req.session.user.username, 'add_asset', null, req);
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
    awardXP(db, req.session.user.full_name || req.session.user.username, 'add_inventory', null, req);
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
    awardXP(db, req.session.user.full_name || req.session.user.username, 'create_task', null, req);
    res.redirect(req.body.redirect || '/client?tab=tasks');
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

  // === MY ACCOUNT (profile + 2FA) ===
  router.get('/account', (req, res) => {
    const currentUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
    const has2fa = !!(currentUser && currentUser.totp_enabled);
    res.render('client/account', { user: req.session.user, currentUser, has2fa, settings: getSettings(), page: 'account' });
  });

  router.post('/account/profile', (req, res) => {
    const { full_name, email, phone } = req.body;
    try {
      db.prepare('UPDATE users SET full_name = ?, email = ?, phone = ? WHERE id = ?').run(
        full_name || null, email || null, phone || null, req.session.user.id
      );
      req.session.user.full_name = full_name || req.session.user.username;
    } catch(e) {}
    res.redirect('/client/account');
  });

  router.post('/account/password', (req, res) => {
    const { current_password, new_password } = req.body;
    if (!new_password || new_password.length < 4) return res.redirect('/client/account');
    const currentUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
    const bcrypt = require('bcryptjs');
    if (!bcrypt.compareSync(current_password, currentUser.password)) return res.redirect('/client/account');
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), req.session.user.id);
    res.redirect('/client/account');
  });

  // Client 2FA setup
  router.get('/account/2fa-setup', (req, res) => {
    const speakeasy = require('speakeasy');
    const QRCode = require('qrcode');
    const currentUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
    const isEnabled = !!(currentUser && currentUser.totp_enabled);

    if (isEnabled) {
      return res.render('client/2fa-setup', { user: req.session.user, isEnabled: true, qrDataUrl: null, secret: null, error: req.query.error || null, settings: getSettings(), page: 'account' });
    }

    let secret = currentUser.totp_secret;
    if (!secret) {
      const gen = speakeasy.generateSecret({ length: 20 });
      secret = gen.base32;
      db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret, req.session.user.id);
    }

    const otpUrl = 'otpauth://totp/ITServices:' + encodeURIComponent(req.session.user.username) + '?secret=' + secret + '&issuer=ITServices&algorithm=SHA1&digits=6&period=30';
    QRCode.toDataURL(otpUrl, (err, url) => {
      res.render('client/2fa-setup', { user: req.session.user, isEnabled: false, qrDataUrl: url, secret, error: req.query.error || null, settings: getSettings(), page: 'account' });
    });
  });

  router.post('/account/2fa-enable', (req, res) => {
    const speakeasy = require('speakeasy');
    const currentUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
    if (!currentUser || !currentUser.totp_secret) return res.redirect('/client/account');
    const verified = speakeasy.totp.verify({ secret: currentUser.totp_secret, encoding: 'base32', token: req.body.token, window: 1 });
    if (!verified) return res.redirect('/client/account/2fa-setup?error=Invalid+code');
    db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(req.session.user.id);
    res.redirect('/client/account');
  });

  router.post('/account/2fa-disable', (req, res) => {
    const speakeasy = require('speakeasy');
    const currentUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
    if (!currentUser || !currentUser.totp_secret) return res.redirect('/client/account');
    const verified = speakeasy.totp.verify({ secret: currentUser.totp_secret, encoding: 'base32', token: req.body.token, window: 1 });
    if (!verified) return res.redirect('/client/account/2fa-setup?error=Invalid+code');
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(req.session.user.id);
    res.redirect('/client/account');
  });

  // Org chart (client view)
  router.get('/org-chart', (req, res) => {
    const cid = req.session.user.company_id;
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(cid);
    if (!company) return res.redirect('/client');
    const users = safeAll('SELECT * FROM company_users WHERE company_id = ? AND is_active = 1 ORDER BY name', [cid]);
    const depts = safeAll('SELECT * FROM departments ORDER BY sort_order');
    res.render('client/org-chart', { user: req.session.user, company, users, depts, settings: getSettings(), page: 'client' });
  });

  // User profile (client view)
  router.get('/users/:uid', (req, res) => {
    const cid = req.session.user.company_id;
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(cid);
    if (!company) return res.redirect('/client');
    const usr = safeGet('SELECT * FROM company_users WHERE id = ? AND company_id = ?', [req.params.uid, cid]);
    if (!usr) return res.redirect('/client?tab=users');
    const manager = usr.manager_id ? safeGet('SELECT id, name, title FROM company_users WHERE id = ?', [usr.manager_id]) : null;
    const directReports = safeAll('SELECT id, name, title, role, department FROM company_users WHERE manager_id = ? AND company_id = ?', [usr.id, cid]);
    const userEmails = safeAll('SELECT * FROM user_emails WHERE user_id = ? AND company_id = ? ORDER BY is_primary DESC', [usr.id, cid]);
    const userPhones = safeAll('SELECT * FROM user_phones WHERE user_id = ? AND company_id = ? ORDER BY is_primary DESC', [usr.id, cid]);
    const userDivisions = safeAll('SELECT uda.*, d.name as division_name, d.code as division_code FROM user_division_assignments uda JOIN divisions d ON uda.division_id = d.id WHERE uda.user_id = ? AND uda.company_id = ?', [usr.id, cid]);
    res.render('client/user-profile', { user: req.session.user, company, usr, manager, directReports, userEmails, userPhones, userDivisions, settings: getSettings(), page: 'client' });
  });

  // === CSV EXPORT (client can export their own data) ===
  router.get('/export/:table', (req, res) => {
    const cid = req.session.user.company_id;
    const tableMap = {
      users: { fields: ['name','title','email','phone','department','role','email_account'], dbTable: 'company_users' },
      servers: { fields: ['name','type','ip','os','purpose','location'], dbTable: 'servers' },
      subscriptions: { fields: ['name','vendor','type','seats','cost_per_unit','billing_cycle','renewal_date'], dbTable: 'subscriptions' },
      assets: { fields: ['name','type','provider','expires_at','login_url'], dbTable: 'assets' },
      inventory: { fields: ['name','type','manufacturer','model','serial_number','quantity','cost','condition','assigned_to'], dbTable: 'inventory' }
    };
    const cfg = tableMap[req.params.table];
    if (!cfg) return res.status(404).send('Unknown table');
    const rows = safeAll('SELECT * FROM ' + cfg.dbTable + ' WHERE company_id = ? ORDER BY name', [cid]);
    const escape = (v) => { const s = String(v == null ? '' : v); return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const csv = [cfg.fields.join(','), ...rows.map(r => cfg.fields.map(f => escape(r[f])).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=' + req.params.table + '-export.csv');
    res.send(csv);
  });

  // === CREATE PROJECT (client) ===
  router.post('/projects', (req, res) => {
    const cid = req.session.user.company_id;
    const { name, description, due_date } = req.body;
    if (!name) return res.redirect('/client/projects');
    try {
      db.prepare('INSERT INTO projects (name, description, company_id, status, due_date) VALUES (?,?,?,?,?)').run(
        name, description || null, cid, 'planning', due_date || null
      );
    } catch(e) {}
    res.redirect('/client/projects');
  });

  // === CREATE SOP (client — draft, needs admin approval) ===
  router.post('/sops', (req, res) => {
    const cid = req.session.user.company_id;
    const { title, category, description, content } = req.body;
    if (!title) return res.redirect('/client/sops');
    try {
      db.prepare('INSERT INTO sops (title, category, description, company_id, status, owner) VALUES (?,?,?,?,?,?)').run(
        title, category || 'General', description || null, cid, 'draft', req.session.user.full_name || req.session.user.username
      );
    } catch(e) {}
    res.redirect('/client/sops');
  });

  // === CREATE POLICY (client — draft) ===
  router.post('/policies', (req, res) => {
    const cid = req.session.user.company_id;
    const { title, category, description, content } = req.body;
    if (!title) return res.redirect('/client/policies');
    try {
      db.prepare('INSERT INTO security_policies (title, category, description, content, company_id, status, requires_ack, created_by) VALUES (?,?,?,?,?,?,?,?)').run(
        title, category || 'General', description || null, content || null, cid, 'draft', 1, req.session.user.full_name || req.session.user.username
      );
    } catch(e) {}
    res.redirect('/client/policies');
  });

  // === CREATE PASSWORD ENTRY (client — shared with company) ===
  router.post('/passwords', (req, res) => {
    const cid = req.session.user.company_id;
    const { title, username, password_val, url, category, notes } = req.body;
    if (!title) return res.redirect('/client/passwords');
    try {
      db.prepare('INSERT INTO password_vault (title, username, password_enc, url, category, company_id, notes, share_type, created_by) VALUES (?,?,?,?,?,?,?,?,?)').run(
        title, username || null, password_val || null, url || null, category || 'General', cid, notes || null, 'department', req.session.user.full_name || req.session.user.username
      );
    } catch(e) {}
    res.redirect('/client/passwords');
  });

  // === DRIVER FUEL DASHBOARD ===
  // Helper: get driver's company_users ID
  function getDriverId(req) {
    const cid = req.session.user.company_id;
    const name = req.session.user.full_name;
    if (!name || !cid) return null;
    const cu = safeGet('SELECT id FROM company_users WHERE company_id = ? AND name = ?', [cid, name]);
    return cu ? cu.id : null;
  }

  router.get('/fuel', (req, res) => {
    const cid = req.session.user.company_id;
    const driverId = getDriverId(req);
    if (!driverId) return res.render('client/fuel-dashboard', { user: req.session.user, error: 'Driver profile not found', settings: getSettings(), page: 'fuel', data: null });

    const config = safeGet('SELECT * FROM fuel_config WHERE company_id = ?', [cid]) || {};
    if (!config.enabled) return res.render('client/fuel-dashboard', { user: req.session.user, error: 'Fuel incentive program not active', settings: getSettings(), page: 'fuel', data: null });

    // Current open/calculated period
    const period = safeGet("SELECT * FROM fuel_payout_periods WHERE company_id = ? AND status IN ('open','calculated') ORDER BY period_start DESC LIMIT 1", [cid]);

    // Driver's group + baseline
    const driverGroup = safeGet('SELECT g.* FROM fuel_driver_group_map m JOIN fuel_groups g ON m.group_id = g.id WHERE m.company_id = ? AND m.driver_id = ?', [cid, driverId]);
    const baseline = driverGroup ? safeGet('SELECT baseline_mpg FROM fuel_baseline_snapshots WHERE company_id = ? AND group_id = ? AND is_current = 1', [cid, driverGroup.id]) : null;
    const baselineMpg = baseline ? baseline.baseline_mpg : (config.baseline_mpg || 0);

    // Target
    const { getEffectiveTarget } = require('../lib/fuel-baseline');
    const today = new Date().toISOString().slice(0,10);
    const target = getEffectiveTarget(db, cid, driverId, today);

    // Current period measurements
    let currentMpg = 0, currentMiles = 0, currentGallons = 0;
    if (period) {
      const agg = safeGet("SELECT SUM(miles) as miles, SUM(gallons) as gal FROM fuel_measurements_daily WHERE company_id = ? AND driver_id = ? AND date >= ? AND date <= ?", [cid, driverId, period.period_start, period.period_end]);
      if (!agg || !agg.miles) {
        // Try via vehicle
        const vehicles = safeAll('SELECT id FROM fleet_vehicles WHERE company_id = ? AND driver_id = ?', [cid, driverId]);
        if (vehicles.length > 0) {
          const vids = vehicles.map(v => v.id);
          var vidPh = vids.map(() => '?').join(',');
          const agg2 = safeGet("SELECT SUM(miles) as miles, SUM(gallons) as gal FROM fuel_measurements_daily WHERE company_id = ? AND vehicle_id IN (" + vidPh + ") AND date >= ? AND date <= ?", [cid, ...vids, period.period_start, period.period_end]);
          if (agg2) { currentMiles = agg2.miles || 0; currentGallons = agg2.gal || 0; }
        }
      } else {
        currentMiles = agg.miles || 0; currentGallons = agg.gal || 0;
      }
      if (currentGallons > 0) currentMpg = Math.round(currentMiles / currentGallons * 100) / 100;
    }

    // Projected payout
    let projectedPayout = 0, projectedSavingsGal = 0;
    if (baselineMpg > 0 && currentMpg > baselineMpg && currentMiles > 0) {
      projectedSavingsGal = (currentMiles / baselineMpg) - (currentMiles / currentMpg);
      const savingsUsd = projectedSavingsGal * (config.fuel_price_manual || 0);
      projectedPayout = Math.round(savingsUsd * (config.split_driver_pct || 50) / 100 * 100) / 100;
      // Add KPI bonus if meeting target
      if (target.target_mpg && currentMpg >= target.target_mpg && target.kpi_bonus_usd) {
        projectedPayout += Math.round(projectedSavingsGal * target.kpi_bonus_usd * 100) / 100;
      }
    }

    // Existing ledger for this driver in current period
    const ledgerEntry = period ? safeGet('SELECT * FROM fuel_payout_ledgers WHERE period_id = ? AND driver_id = ? AND company_id = ?', [period.id, driverId, cid]) : null;

    res.render('client/fuel-dashboard', {
      user: req.session.user, settings: getSettings(), page: 'fuel', error: null,
      data: { config, period, driverGroup, baselineMpg, target, currentMpg, currentMiles, currentGallons, projectedPayout, projectedSavingsGal, ledgerEntry, driverId }
    });
  });

  // Driver fuel history
  router.get('/fuel/history', (req, res) => {
    const cid = req.session.user.company_id;
    const driverId = getDriverId(req);
    if (!driverId) return res.render('client/fuel-history', { user: req.session.user, settings: getSettings(), page: 'fuel', ledgers: [] });

    const ledgers = safeAll("SELECT l.*, p.period_start, p.period_end, p.status as period_status FROM fuel_payout_ledgers l JOIN fuel_payout_periods p ON l.period_id = p.id WHERE l.driver_id = ? AND l.company_id = ? ORDER BY p.period_start DESC", [driverId, cid]);
    res.render('client/fuel-history', { user: req.session.user, settings: getSettings(), page: 'fuel', ledgers });
  });

  // What-if calculator
  router.get('/fuel/calculator', (req, res) => {
    const cid = req.session.user.company_id;
    const config = safeGet('SELECT * FROM fuel_config WHERE company_id = ?', [cid]) || {};
    const driverId = getDriverId(req);
    const driverGroup = driverId ? safeGet('SELECT g.* FROM fuel_driver_group_map m JOIN fuel_groups g ON m.group_id = g.id WHERE m.company_id = ? AND m.driver_id = ?', [cid, driverId]) : null;
    const baseline = driverGroup ? safeGet('SELECT baseline_mpg FROM fuel_baseline_snapshots WHERE company_id = ? AND group_id = ? AND is_current = 1', [cid, driverGroup.id]) : null;
    const target = driverId ? require('../lib/fuel-baseline').getEffectiveTarget(db, cid, driverId, new Date().toISOString().slice(0,10)) : { target_mpg: null, kpi_bonus_usd: 0 };

    res.render('client/fuel-calculator', {
      user: req.session.user, settings: getSettings(), page: 'fuel',
      defaults: {
        baselineMpg: (baseline ? baseline.baseline_mpg : config.baseline_mpg) || 6.0,
        targetMpg: target.target_mpg || 6.5,
        fuelPrice: config.fuel_price_manual || 4.0,
        driverPct: config.split_driver_pct || 50,
        kpiBonus: target.kpi_bonus_usd || 0.10
      }
    });
  });

  // Leaderboard
  router.get('/leaderboard', (req, res) => {
    const { getLeaderboard, getRecentXP } = require('../lib/xp');
    const leaders = getLeaderboard(db, 50);
    leaders.forEach(l => { l.rank = getRank(l.total); });
    const myXP = getRecentXP(db, req.session.user.full_name || req.session.user.username, 20);
    res.render('client/leaderboard', { user: req.session.user, leaders, myXP, settings: getSettings(), page: 'leaderboard' });
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
