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
    const tab = req.query.tab || 'dashboard';
    res.render('client' + '/portal', { user: req.session.user, company, users, servers, subs, assets, inventory, invoices, unpaid, contacts, tasks, software, emailCount, phoneCount, tab, settings: getSettings(), page: 'client' });
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

  router.get('/services', (req, res) => {
    const services = safeAll('SELECT * FROM services WHERE is_public = 1 AND is_active = 1 ORDER BY name');
    res.render('client' + '/services', { user: req.session.user, services, settings: getSettings(), page: 'services' });
  });

  // Chat page
  router.get('/chat', (req, res) => {
    res.render('client/chat', { user: req.session.user, settings: getSettings(), page: 'chat' });
  });

  return router;
};
