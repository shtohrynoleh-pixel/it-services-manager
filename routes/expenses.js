const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requireAdmin } = require('../middleware/auth');
const crypto = require('crypto');
const { dedupeHash, parseExpenseCSV, parseCSVRaw, suggestMapping, canExpense } = require('../lib/expense-utils');

const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const csvUpload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });

module.exports = function(db) {
  router.use(requireAdmin);

  const safeAll = (sql, params) => { try { return params ? db.prepare(sql).all(...(Array.isArray(params)?params:[params])) : db.prepare(sql).all(); } catch(e) { return []; } };
  const safeGet = (sql, params) => { try { return params ? db.prepare(sql).get(...(Array.isArray(params)?params:[params])) : db.prepare(sql).get(); } catch(e) { return null; } };
  const getSettings = () => { const s = {}; try { db.prepare('SELECT key, value FROM settings').all().forEach(r => { s[r.key] = r.value; }); } catch(e) {} return s; };
  const who = (req) => req.session.user.full_name || req.session.user.username;

  // Audit logger
  function auditLog(companyId, entityType, entityId, action, changes, performedBy) {
    try {
      db.prepare('INSERT INTO expense_audit_log (company_id, entity_type, entity_id, action, field_changes, performed_by) VALUES (?,?,?,?,?,?)').run(
        companyId, entityType, entityId, action,
        changes ? JSON.stringify(changes) : null,
        performedBy
      );
    } catch(e) { console.error('Expense audit log error:', e.message); }
  }

  // Build diff of changed fields between old and new objects
  function buildDiff(oldObj, newObj, fields) {
    const changes = {};
    for (const f of fields) {
      const o = oldObj[f] == null ? '' : String(oldObj[f]);
      const n = newObj[f] == null ? '' : String(newObj[f]);
      if (o !== n) changes[f] = { from: o || null, to: n || null };
    }
    return Object.keys(changes).length > 0 ? changes : null;
  }

  // Company scope check — every expense route goes through this
  router.use('/companies/:cid/expenses*', (req, res, next) => {
    const u = req.session.user;
    if (u.is_super) return next();
    if (u.assignedCompanies && !u.assignedCompanies.includes(parseInt(req.params.cid))) return res.status(403).send('Access denied');
    next();
  });

  // Helper: base URL for redirects
  const base = (cid) => '/admin/companies/' + cid + '/expenses';

  // ================================================================
  //  MAIN EXPENSES PAGE
  // ================================================================

  // Shared filter builder — used by listing, totals, and export
  function buildTxWhere(cid, f) {
    const where = ['t.company_id = ?'];
    const params = [cid];
    if (f.dateFrom) { where.push('t.date >= ?'); params.push(f.dateFrom); }
    if (f.dateTo)   { where.push('t.date <= ?'); params.push(f.dateTo); }
    if (f.category) { where.push('t.category_id = ?'); params.push(parseInt(f.category)); }
    if (f.costCenter) { where.push('t.cost_center_id = ?'); params.push(parseInt(f.costCenter)); }
    if (f.project)  { where.push('t.project_id = ?'); params.push(parseInt(f.project)); }
    if (f.vendor)   { where.push('t.vendor_id = ?'); params.push(parseInt(f.vendor)); }
    if (f.status)   { where.push('t.status = ?'); params.push(f.status); }
    if (f.source)   { where.push('t.source = ?'); params.push(f.source); }
    return { clause: where.join(' AND '), params };
  }

  router.get('/companies/:cid/expenses', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.cid);
    if (!company) return res.redirect('/admin/companies');
    const tab = req.query.tab || 'transactions';
    const txErr = req.query.txerr || '';
    const importErr = req.query.err || '';

    // Filters
    const f = {
      dateFrom: req.query.from || '', dateTo: req.query.to || '',
      category: req.query.category || '', costCenter: req.query.cc || '',
      project: req.query.project || '', vendor: req.query.vendor || '',
      status: req.query.status || '', source: req.query.source || ''
    };

    // Pagination
    const perPage = 50;
    const page = Math.max(1, parseInt(req.query.p) || 1);
    const offset = (page - 1) * perPage;

    // Transaction WHERE (shared builder)
    const tw = buildTxWhere(company.id, f);

    // Filtered totals — always matches what the user sees
    const filteredTotal = safeGet(
      'SELECT SUM(t.amount) as total, COUNT(*) as cnt FROM expense_transactions t WHERE ' + tw.clause,
      tw.params
    ) || { total: 0, cnt: 0 };
    const totalPages = Math.max(1, Math.ceil((filteredTotal.cnt || 0) / perPage));

    // Paginated rows
    const transactions = safeAll(
      'SELECT t.* FROM expense_transactions t WHERE ' + tw.clause +
      ' ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?',
      [...tw.params, perPage, offset]
    );

    // Settings tab filters
    const sf = {
      ccSearch: req.query.ccq || '', ccActive: req.query.cca || 'active',
      catSearch: req.query.catq || '', catActive: req.query.cata || 'active',
      vendorSearch: req.query.vq || '', vendorActive: req.query.va || 'active'
    };

    // Cost centers (filtered for settings tab)
    let ccWhere = ['company_id = ?']; let ccParams = [company.id];
    if (sf.ccActive === 'active') { ccWhere.push('is_active = 1'); }
    else if (sf.ccActive === 'inactive') { ccWhere.push('is_active = 0'); }
    if (sf.ccSearch) { ccWhere.push("(code LIKE ? OR name LIKE ?)"); ccParams.push('%'+sf.ccSearch+'%', '%'+sf.ccSearch+'%'); }
    const costCenters = safeAll('SELECT * FROM expense_cost_centers WHERE ' + ccWhere.join(' AND ') + ' ORDER BY code', ccParams);

    // Categories (filtered for settings tab)
    let catWhere = ['company_id = ?']; let catParams = [company.id];
    if (sf.catActive === 'active') { catWhere.push('is_active = 1'); }
    else if (sf.catActive === 'inactive') { catWhere.push('is_active = 0'); }
    if (sf.catSearch) { catWhere.push("name LIKE ?"); catParams.push('%'+sf.catSearch+'%'); }
    const categories = safeAll('SELECT * FROM expense_categories WHERE ' + catWhere.join(' AND ') + ' ORDER BY sort_order, name', catParams);

    // Active lists for dropdowns
    const activeCategories = safeAll('SELECT * FROM expense_categories WHERE company_id = ? AND is_active = 1 ORDER BY sort_order, name', [company.id]);
    const activeCostCenters = safeAll('SELECT * FROM expense_cost_centers WHERE company_id = ? AND is_active = 1 ORDER BY code', [company.id]);
    const activeVendors = safeAll('SELECT * FROM expense_vendors WHERE company_id = ? AND is_active = 1 ORDER BY name', [company.id]);

    // Vendors (filtered for settings tab)
    let vWhere = ['company_id = ?']; let vParams = [company.id];
    if (sf.vendorActive === 'active') { vWhere.push('is_active = 1'); }
    else if (sf.vendorActive === 'inactive') { vWhere.push('is_active = 0'); }
    if (sf.vendorSearch) { vWhere.push("(name LIKE ? OR contact LIKE ? OR email LIKE ?)"); vParams.push('%'+sf.vendorSearch+'%', '%'+sf.vendorSearch+'%', '%'+sf.vendorSearch+'%'); }
    const vendors = safeAll('SELECT * FROM expense_vendors WHERE ' + vWhere.join(' AND ') + ' ORDER BY name', vParams);

    // Projects — linked from existing table
    const projects = safeAll('SELECT * FROM projects WHERE company_id = ? ORDER BY name', [company.id]);

    const batches = safeAll('SELECT * FROM expense_import_batches WHERE company_id = ? ORDER BY created_at DESC LIMIT 20', [company.id]);

    // Global stats (unfiltered)
    const totalAll = safeGet('SELECT SUM(amount) as total, COUNT(*) as cnt FROM expense_transactions WHERE company_id = ?', [company.id]) || { total: 0, cnt: 0 };
    const thisMonth = safeGet("SELECT SUM(amount) as total FROM expense_transactions WHERE company_id = ? AND date >= date('now','start of month')", [company.id]) || { total: 0 };
    const pending = safeGet("SELECT COUNT(*) as cnt FROM expense_transactions WHERE company_id = ? AND status = 'pending'", [company.id]) || { cnt: 0 };

    // Report summaries (lightweight for non-reports tabs)
    const byCat = safeAll('SELECT category_name, SUM(amount) as total, COUNT(*) as cnt FROM expense_transactions WHERE company_id = ? GROUP BY category_name ORDER BY total DESC LIMIT 10', [company.id]);
    const byCC = safeAll('SELECT cost_center_code, SUM(amount) as total, COUNT(*) as cnt FROM expense_transactions WHERE company_id = ? GROUP BY cost_center_code ORDER BY total DESC LIMIT 10', [company.id]);

    // Rich analytics for reports tab
    let rpt = null;
    if (tab === 'reports') {
      const rf = { from: req.query.rfrom || '', to: req.query.rto || '' };
      let rWhere = 'company_id = ?'; let rParams = [company.id];
      if (rf.from) { rWhere += ' AND date >= ?'; rParams.push(rf.from); }
      if (rf.to)   { rWhere += ' AND date <= ?'; rParams.push(rf.to); }

      const rTotal = safeGet('SELECT SUM(amount) as total, COUNT(*) as cnt FROM expense_transactions WHERE ' + rWhere, rParams) || { total: 0, cnt: 0 };
      const rMTD = safeGet("SELECT SUM(amount) as total FROM expense_transactions WHERE company_id = ? AND date >= date('now','start of month')", [company.id]) || { total: 0 };
      const rYTD = safeGet("SELECT SUM(amount) as total FROM expense_transactions WHERE company_id = ? AND date >= date('now','start of year')", [company.id]) || { total: 0 };
      const r30d = safeGet("SELECT SUM(amount) as total FROM expense_transactions WHERE company_id = ? AND date >= date('now','-30 days')", [company.id]) || { total: 0 };
      const r90d = safeGet("SELECT SUM(amount) as total FROM expense_transactions WHERE company_id = ? AND date >= date('now','-90 days')", [company.id]) || { total: 0 };

      const topCC = safeAll('SELECT cost_center_id, cost_center_code, SUM(amount) as total, COUNT(*) as cnt FROM expense_transactions WHERE ' + rWhere + ' AND cost_center_code IS NOT NULL GROUP BY cost_center_id, cost_center_code ORDER BY total DESC LIMIT 10', rParams);
      const topCat = safeAll('SELECT category_id, category_name, SUM(amount) as total, COUNT(*) as cnt FROM expense_transactions WHERE ' + rWhere + ' AND category_name IS NOT NULL GROUP BY category_id, category_name ORDER BY total DESC LIMIT 10', rParams);
      const topProj = safeAll('SELECT project_id, project_name, SUM(amount) as total, COUNT(*) as cnt FROM expense_transactions WHERE ' + rWhere + ' AND project_name IS NOT NULL GROUP BY project_id, project_name ORDER BY total DESC LIMIT 10', rParams);
      const payrollSplit = safeGet("SELECT SUM(CASE WHEN source='salary' OR category_name='Payroll' THEN amount ELSE 0 END) as payroll, SUM(CASE WHEN source!='salary' AND (category_name IS NULL OR category_name!='Payroll') THEN amount ELSE 0 END) as non_payroll FROM expense_transactions WHERE " + rWhere, rParams) || { payroll: 0, non_payroll: 0 };

      // Monthly trend (last 12 months)
      const monthlyTrend = safeAll("SELECT strftime('%Y-%m', date) as month, SUM(amount) as total, COUNT(*) as cnt FROM expense_transactions WHERE company_id = ? AND date >= date('now','-12 months') GROUP BY strftime('%Y-%m', date) ORDER BY month", [company.id]);

      // Data freshness
      const lastImport = safeGet('SELECT created_at, imported_rows, filename FROM expense_import_batches WHERE company_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1', [company.id, 'completed']);

      rpt = { rf, rTotal, rMTD, rYTD, r30d, r90d, topCC, topCat, topProj, payrollSplit, monthlyTrend, lastImport };
    }

    // Audit log (last 50)
    const auditLogs = safeAll('SELECT * FROM expense_audit_log WHERE company_id = ? ORDER BY created_at DESC LIMIT 50', [company.id]);

    // Company users for manager assignment
    const companyUsers = safeAll('SELECT id, name FROM company_users WHERE company_id = ? AND is_active = 1 ORDER BY name', [company.id]);

    // Role check — export only for finance/admin
    const userCanExport = canExpense(req.session.user, 'export');

    // Payroll data
    const salaryProfiles = safeAll("SELECT sp.*, ecc.code as cc_code, ecc.name as cc_name, p.name as proj_name FROM salary_profiles sp LEFT JOIN expense_cost_centers ecc ON sp.cost_center_id = ecc.id LEFT JOIN projects p ON sp.project_id = p.id WHERE sp.company_id = ? ORDER BY sp.is_active DESC, sp.employee_name", [company.id]);
    const salaryRuns = safeAll('SELECT * FROM salary_runs WHERE company_id = ? ORDER BY created_at DESC LIMIT 20', [company.id]);
    // For the most recent expandable run, load its lines
    const expandRunId = parseInt(req.query.run) || (salaryRuns.length > 0 ? salaryRuns[0].id : 0);
    const runLines = expandRunId ? safeAll('SELECT * FROM salary_run_lines WHERE run_id = ? AND company_id = ?', [expandRunId, company.id]) : [];
    const payrollErr = req.query.perr || '';
    // Payroll summary
    const payrollTotal = safeGet("SELECT SUM(amount) as total, COUNT(*) as cnt FROM expense_transactions WHERE company_id = ? AND source = 'salary'", [company.id]) || { total: 0, cnt: 0 };

    res.render('admin/expenses', {
      user: req.session.user, company, tab, transactions,
      categories, activeCategories, costCenters, activeCostCenters,
      vendors, activeVendors, projects, batches, f, sf,
      totalAll, thisMonth, pending, byCat, byCC, rpt, auditLogs, companyUsers,
      filteredTotal, txPage: page, totalPages, perPage, txErr, importErr, userCanExport,
      salaryProfiles, salaryRuns, runLines, expandRunId, payrollErr, payrollTotal,
      settings: getSettings(), page: 'companies'
    });
  });

  // ================================================================
  //  TRANSACTIONS CRUD
  // ================================================================

  // Shared validation for create/edit
  function validateTx(b) {
    if (!b.date || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return 'Date is required (YYYY-MM-DD)';
    const amt = parseFloat(b.amount);
    if (isNaN(amt) || amt === 0) return 'Amount is required and must be non-zero';
    return null;
  }

  router.post('/companies/:cid/expenses/transactions', (req, res) => {
    const b = req.body;
    const cid = req.params.cid;
    const err = validateTx(b);
    if (err) return res.redirect(base(cid) + '?tab=transactions&txerr=' + encodeURIComponent(err));

    const hash = dedupeHash(cid, b.date, b.amount, b.description, b.reference, b.vendor_name);
    try {
      const result = db.prepare('INSERT INTO expense_transactions (company_id, date, amount, description, vendor_id, vendor_name, category_id, category_name, cost_center_id, cost_center_code, project_id, project_name, reference, invoice_number, source, dedupe_hash, status, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        cid, b.date, parseFloat(b.amount), b.description||null,
        b.vendor_id||null, b.vendor_name||null,
        b.category_id||null, b.category_name||null,
        b.cost_center_id||null, b.cost_center_code||null,
        b.project_id||null, b.project_name||null,
        b.reference||null, b.invoice_number||null,
        'manual', hash, b.status||'pending', b.notes||null, who(req)
      );
      auditLog(cid, 'transaction', result.lastInsertRowid, 'create', {
        date: b.date, amount: b.amount, description: b.description,
        vendor: b.vendor_name, category: b.category_name,
        cost_center: b.cost_center_code, project: b.project_name, source: 'manual'
      }, who(req));
    } catch(e) { console.error('Expense create:', e.message); }
    res.redirect(base(cid) + '?tab=transactions');
  });

  router.post('/companies/:cid/expenses/transactions/:tid/edit', (req, res) => {
    const b = req.body;
    const cid = req.params.cid;
    const err = validateTx(b);
    if (err) return res.redirect(base(cid) + '?tab=transactions&txerr=' + encodeURIComponent(err));

    const old = safeGet('SELECT * FROM expense_transactions WHERE id = ? AND company_id = ?', [req.params.tid, cid]);
    if (!old) return res.redirect(base(cid) + '?tab=transactions');
    try {
      db.prepare("UPDATE expense_transactions SET date=?, amount=?, description=?, vendor_id=?, vendor_name=?, category_id=?, category_name=?, cost_center_id=?, cost_center_code=?, project_id=?, project_name=?, reference=?, invoice_number=?, status=?, notes=?, updated_at=datetime('now') WHERE id=? AND company_id=?").run(
        b.date, parseFloat(b.amount), b.description||null,
        b.vendor_id||null, b.vendor_name||null,
        b.category_id||null, b.category_name||null,
        b.cost_center_id||null, b.cost_center_code||null,
        b.project_id||null, b.project_name||null,
        b.reference||null, b.invoice_number||null,
        b.status||'pending', b.notes||null,
        req.params.tid, cid
      );
      const diff = buildDiff(old, b, ['date','amount','description','vendor_name','category_name','cost_center_code','project_name','reference','invoice_number','status','notes']);
      auditLog(cid, 'transaction', req.params.tid, 'update', diff, who(req));
    } catch(e) {}
    res.redirect(base(cid) + '?tab=transactions');
  });

  router.post('/companies/:cid/expenses/transactions/:tid/approve', (req, res) => {
    try {
      db.prepare("UPDATE expense_transactions SET status='approved', approved_by=?, approved_at=datetime('now') WHERE id=? AND company_id=?").run(who(req), req.params.tid, req.params.cid);
      auditLog(req.params.cid, 'transaction', req.params.tid, 'approve', null, who(req));
    } catch(e) {}
    res.redirect(req.body.redirect || base(req.params.cid));
  });

  router.post('/companies/:cid/expenses/transactions/:tid/delete', (req, res) => {
    try {
      db.prepare('DELETE FROM expense_transactions WHERE id=? AND company_id=?').run(req.params.tid, req.params.cid);
      auditLog(req.params.cid, 'transaction', req.params.tid, 'delete', null, who(req));
    } catch(e) {}
    res.redirect(base(req.params.cid));
  });

  router.post('/companies/:cid/expenses/approve-all', (req, res) => {
    try {
      const cnt = db.prepare("UPDATE expense_transactions SET status='approved', approved_by=?, approved_at=datetime('now') WHERE company_id=? AND status='pending'").run(who(req), req.params.cid);
      auditLog(req.params.cid, 'transaction', null, 'bulk_approve', { count: cnt.changes }, who(req));
    } catch(e) {}
    res.redirect(base(req.params.cid));
  });

  // ================================================================
  //  COST CENTERS — full CRUD with uniqueness + audit
  // ================================================================
  router.post('/companies/:cid/expenses/cost-centers', (req, res) => {
    const { code, name, manager_id, notes } = req.body;
    const cid = req.params.cid;
    // Uniqueness check
    const existing = safeGet('SELECT id FROM expense_cost_centers WHERE company_id = ? AND code = ?', [cid, code]);
    if (existing) {
      return res.redirect(base(cid) + '?tab=settings&err=Cost+center+code+already+exists');
    }
    try {
      const result = db.prepare('INSERT INTO expense_cost_centers (company_id, code, name, manager_id, notes) VALUES (?,?,?,?,?)').run(cid, code, name, manager_id||null, notes||null);
      auditLog(cid, 'cost_center', result.lastInsertRowid, 'create', { code, name, manager_id: manager_id||null, notes: notes||null }, who(req));
    } catch(e) { console.error('CC create:', e.message); }
    res.redirect(base(cid) + '?tab=settings');
  });

  router.post('/companies/:cid/expenses/cost-centers/:ccid/edit', (req, res) => {
    const { code, name, manager_id, notes } = req.body;
    const cid = req.params.cid;
    const old = safeGet('SELECT * FROM expense_cost_centers WHERE id = ? AND company_id = ?', [req.params.ccid, cid]);
    if (!old) return res.redirect(base(cid) + '?tab=settings');
    // Uniqueness check (allow same record)
    const dup = safeGet('SELECT id FROM expense_cost_centers WHERE company_id = ? AND code = ? AND id != ?', [cid, code, req.params.ccid]);
    if (dup) {
      return res.redirect(base(cid) + '?tab=settings&err=Cost+center+code+already+exists');
    }
    try {
      db.prepare('UPDATE expense_cost_centers SET code=?, name=?, manager_id=?, notes=? WHERE id=? AND company_id=?').run(code, name, manager_id||null, notes||null, req.params.ccid, cid);
      const diff = buildDiff(old, { code, name, manager_id: manager_id||null, notes: notes||null }, ['code','name','manager_id','notes']);
      auditLog(cid, 'cost_center', req.params.ccid, 'update', diff, who(req));
    } catch(e) {}
    res.redirect(base(cid) + '?tab=settings');
  });

  router.post('/companies/:cid/expenses/cost-centers/:ccid/deactivate', (req, res) => {
    const cid = req.params.cid;
    const old = safeGet('SELECT * FROM expense_cost_centers WHERE id = ? AND company_id = ?', [req.params.ccid, cid]);
    if (!old) return res.redirect(base(cid) + '?tab=settings');
    const newStatus = old.is_active ? 0 : 1;
    try {
      db.prepare('UPDATE expense_cost_centers SET is_active = ? WHERE id = ? AND company_id = ?').run(newStatus, req.params.ccid, cid);
      auditLog(cid, 'cost_center', req.params.ccid, newStatus ? 'reactivate' : 'deactivate', { code: old.code, name: old.name }, who(req));
    } catch(e) {}
    res.redirect(base(cid) + '?tab=settings');
  });

  // ================================================================
  //  CATEGORIES — full CRUD with parent, uniqueness + audit
  // ================================================================
  router.post('/companies/:cid/expenses/categories', (req, res) => {
    const { name, parent_id, icon, sort_order } = req.body;
    const cid = req.params.cid;
    const existing = safeGet('SELECT id FROM expense_categories WHERE company_id = ? AND name = ?', [cid, name]);
    if (existing) {
      return res.redirect(base(cid) + '?tab=settings&err=Category+name+already+exists');
    }
    try {
      const result = db.prepare('INSERT INTO expense_categories (company_id, name, parent_id, icon, sort_order) VALUES (?,?,?,?,?)').run(cid, name, parent_id||null, icon||null, parseInt(sort_order)||0);
      auditLog(cid, 'category', result.lastInsertRowid, 'create', { name, parent_id: parent_id||null, icon: icon||null }, who(req));
    } catch(e) { console.error('Cat create:', e.message); }
    res.redirect(base(cid) + '?tab=settings');
  });

  router.post('/companies/:cid/expenses/categories/:catid/edit', (req, res) => {
    const { name, parent_id, icon, sort_order } = req.body;
    const cid = req.params.cid;
    const old = safeGet('SELECT * FROM expense_categories WHERE id = ? AND company_id = ?', [req.params.catid, cid]);
    if (!old) return res.redirect(base(cid) + '?tab=settings');
    // Uniqueness (allow same)
    const dup = safeGet('SELECT id FROM expense_categories WHERE company_id = ? AND name = ? AND id != ?', [cid, name, req.params.catid]);
    if (dup) {
      return res.redirect(base(cid) + '?tab=settings&err=Category+name+already+exists');
    }
    // Prevent self-parent
    const pid = (parent_id && String(parent_id) !== String(req.params.catid)) ? parent_id : null;
    try {
      db.prepare('UPDATE expense_categories SET name=?, parent_id=?, icon=?, sort_order=? WHERE id=? AND company_id=?').run(name, pid||null, icon||null, parseInt(sort_order)||0, req.params.catid, cid);
      const diff = buildDiff(old, { name, parent_id: pid||null, icon: icon||null, sort_order: parseInt(sort_order)||0 }, ['name','parent_id','icon','sort_order']);
      auditLog(cid, 'category', req.params.catid, 'update', diff, who(req));
    } catch(e) {}
    res.redirect(base(cid) + '?tab=settings');
  });

  router.post('/companies/:cid/expenses/categories/:catid/deactivate', (req, res) => {
    const cid = req.params.cid;
    const old = safeGet('SELECT * FROM expense_categories WHERE id = ? AND company_id = ?', [req.params.catid, cid]);
    if (!old) return res.redirect(base(cid) + '?tab=settings');
    const newStatus = old.is_active ? 0 : 1;
    try {
      db.prepare('UPDATE expense_categories SET is_active = ? WHERE id = ? AND company_id = ?').run(newStatus, req.params.catid, cid);
      auditLog(cid, 'category', req.params.catid, newStatus ? 'reactivate' : 'deactivate', { name: old.name }, who(req));
    } catch(e) {}
    res.redirect(base(cid) + '?tab=settings');
  });

  // ================================================================
  //  VENDORS — full CRUD with uniqueness + audit
  // ================================================================
  router.post('/companies/:cid/expenses/vendors', (req, res) => {
    const { name, contact, email, phone, address, tax_id, notes } = req.body;
    const cid = req.params.cid;
    const existing = safeGet('SELECT id FROM expense_vendors WHERE company_id = ? AND name = ?', [cid, name]);
    if (existing) {
      return res.redirect(base(cid) + '?tab=settings&err=Vendor+name+already+exists');
    }
    try {
      const result = db.prepare('INSERT INTO expense_vendors (company_id, name, contact, email, phone, address, tax_id, notes) VALUES (?,?,?,?,?,?,?,?)').run(cid, name, contact||null, email||null, phone||null, address||null, tax_id||null, notes||null);
      auditLog(cid, 'vendor', result.lastInsertRowid, 'create', { name, contact: contact||null, email: email||null, tax_id: tax_id||null }, who(req));
    } catch(e) { console.error('Vendor create:', e.message); }
    res.redirect(base(cid) + '?tab=settings');
  });

  router.post('/companies/:cid/expenses/vendors/:vid/edit', (req, res) => {
    const { name, contact, email, phone, address, tax_id, notes } = req.body;
    const cid = req.params.cid;
    const old = safeGet('SELECT * FROM expense_vendors WHERE id = ? AND company_id = ?', [req.params.vid, cid]);
    if (!old) return res.redirect(base(cid) + '?tab=settings');
    const dup = safeGet('SELECT id FROM expense_vendors WHERE company_id = ? AND name = ? AND id != ?', [cid, name, req.params.vid]);
    if (dup) {
      return res.redirect(base(cid) + '?tab=settings&err=Vendor+name+already+exists');
    }
    try {
      db.prepare('UPDATE expense_vendors SET name=?, contact=?, email=?, phone=?, address=?, tax_id=?, notes=? WHERE id=? AND company_id=?').run(name, contact||null, email||null, phone||null, address||null, tax_id||null, notes||null, req.params.vid, cid);
      const diff = buildDiff(old, { name, contact: contact||null, email: email||null, phone: phone||null, address: address||null, tax_id: tax_id||null, notes: notes||null }, ['name','contact','email','phone','address','tax_id','notes']);
      auditLog(cid, 'vendor', req.params.vid, 'update', diff, who(req));
    } catch(e) {}
    res.redirect(base(cid) + '?tab=settings');
  });

  router.post('/companies/:cid/expenses/vendors/:vid/deactivate', (req, res) => {
    const cid = req.params.cid;
    const old = safeGet('SELECT * FROM expense_vendors WHERE id = ? AND company_id = ?', [req.params.vid, cid]);
    if (!old) return res.redirect(base(cid) + '?tab=settings');
    const newStatus = old.is_active ? 0 : 1;
    try {
      db.prepare('UPDATE expense_vendors SET is_active = ? WHERE id = ? AND company_id = ?').run(newStatus, req.params.vid, cid);
      auditLog(cid, 'vendor', req.params.vid, newStatus ? 'reactivate' : 'deactivate', { name: old.name }, who(req));
    } catch(e) {}
    res.redirect(base(cid) + '?tab=settings');
  });

  // ================================================================
  //  CSV IMPORT — multi-step wizard
  // ================================================================

  // Temp file helpers for import staging
  const stagingPath = (token) => path.join(uploadDir, 'import-' + token + '.json');
  function cleanStaging(token) { try { fs.unlinkSync(stagingPath(token)); } catch(e) {} }

  // Build lookup maps for a company (used in preview + commit)
  function buildLookups(cid) {
    const catLookup = {};
    safeAll('SELECT id, name FROM expense_categories WHERE company_id = ?', [cid]).forEach(c => { catLookup[c.name.toLowerCase()] = c.id; });
    const ccByCode = {}; const ccByName = {};
    safeAll('SELECT id, code, name FROM expense_cost_centers WHERE company_id = ?', [cid]).forEach(c => {
      ccByCode[c.code.toLowerCase()] = c.id;
      ccByName[c.name.toLowerCase()] = c.id;
    });
    const vendorLookup = {};
    safeAll('SELECT id, name FROM expense_vendors WHERE company_id = ?', [cid]).forEach(v => { vendorLookup[v.name.toLowerCase()] = v.id; });
    const projByCode = {}; const projByName = {};
    safeAll('SELECT id, name FROM projects WHERE company_id = ?', [cid]).forEach(p => {
      projByName[p.name.toLowerCase()] = p.id;
      // projects table has no code column, use name only
    });
    return { catLookup, ccByCode, ccByName, vendorLookup, projByCode, projByName };
  }

  // Resolve a single mapped row into a transaction-ready object
  function resolveRow(cid, row, lookups, autoCreateVendors, performer) {
    const errors = [];
    // Required fields
    if (!row.date) errors.push('Missing date');
    if (!row.amount && row.amount !== '0' && row.amount !== 0) errors.push('Missing amount');
    const amt = parseFloat(String(row.amount || '').replace(/[$,]/g, ''));
    if (row.amount && isNaN(amt)) errors.push('Invalid amount: ' + row.amount);
    if (errors.length) return { valid: false, errors };

    const resolved = {
      date: row.date, amount: amt, description: row.description || null,
      vendor_name: row.vendor_name || null, vendor_id: null,
      category_name: row.category_name || null, category_id: null,
      cost_center_code: row.cost_center_code || null, cost_center_id: null,
      project_name: row.project_name || null, project_id: null,
      reference: row.reference || null, invoice_number: row.invoice_number || null,
      notes: row.notes || null, warnings: [], autoCreated: []
    };

    // Category — match by name; auto-create "Payroll" if missing
    if (resolved.category_name) {
      resolved.category_id = lookups.catLookup[resolved.category_name.toLowerCase()] || null;
      if (!resolved.category_id && resolved.category_name.toLowerCase() === 'payroll' && autoCreateVendors) {
        // auto-create Payroll category (reuses the ensurePayrollCategory helper pattern)
        try {
          const cr = db.prepare("INSERT INTO expense_categories (company_id, name, icon, sort_order) VALUES (?,?,?,?)").run(cid, 'Payroll', 'ti-cash', 0);
          resolved.category_id = cr.lastInsertRowid;
          lookups.catLookup['payroll'] = resolved.category_id;
          resolved.autoCreated.push('category:Payroll');
          auditLog(cid, 'category', resolved.category_id, 'auto_create_import', { name: 'Payroll' }, performer);
        } catch(e) {
          // UNIQUE constraint race — re-fetch
          resolved.category_id = lookups.catLookup['payroll'] || null;
        }
      } else if (!resolved.category_id) {
        resolved.warnings.push('Category not found: ' + resolved.category_name);
      }
    }

    // Cost center — match by code first, then name
    if (resolved.cost_center_code) {
      resolved.cost_center_id = lookups.ccByCode[resolved.cost_center_code.toLowerCase()]
        || lookups.ccByName[resolved.cost_center_code.toLowerCase()] || null;
      if (!resolved.cost_center_id) resolved.warnings.push('Cost center not found: ' + resolved.cost_center_code);
    }

    // Project — match by name
    if (resolved.project_name) {
      resolved.project_id = lookups.projByName[resolved.project_name.toLowerCase()] || null;
      if (!resolved.project_id) resolved.warnings.push('Project not found: ' + resolved.project_name);
    }

    // Vendor — match by name, optionally auto-create
    if (resolved.vendor_name) {
      resolved.vendor_id = lookups.vendorLookup[resolved.vendor_name.toLowerCase()] || null;
      if (!resolved.vendor_id && autoCreateVendors) {
        try {
          const vr = db.prepare('INSERT INTO expense_vendors (company_id, name) VALUES (?,?)').run(cid, resolved.vendor_name);
          resolved.vendor_id = vr.lastInsertRowid;
          lookups.vendorLookup[resolved.vendor_name.toLowerCase()] = resolved.vendor_id;
          resolved.autoCreated.push('vendor:' + resolved.vendor_name);
          auditLog(cid, 'vendor', resolved.vendor_id, 'auto_create_import', { name: resolved.vendor_name }, performer);
        } catch(e) {
          // may already exist from another row in same batch
          resolved.vendor_id = lookups.vendorLookup[resolved.vendor_name.toLowerCase()] || null;
        }
      } else if (!resolved.vendor_id) {
        resolved.warnings.push('Vendor not found: ' + resolved.vendor_name);
      }
    }

    // Dedupe hash
    resolved.hash = dedupeHash(cid, resolved.date, resolved.amount, resolved.description, resolved.reference, resolved.vendor_name);

    return { valid: true, resolved };
  }

  // STEP 1: Upload CSV → parse → show mapping page
  router.post('/companies/:cid/expenses/import/upload', csvUpload.single('file'), (req, res) => {
    if (!req.file) return res.redirect(base(req.params.cid) + '?tab=import');
    const cid = parseInt(req.params.cid);
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(cid);
    if (!company) return res.redirect('/admin/companies');

    try {
      const text = fs.readFileSync(req.file.path, 'utf-8');
      const { rawHeaders, dataRows } = parseCSVRaw(text);
      if (rawHeaders.length === 0 || dataRows.length === 0) {
        fs.unlinkSync(req.file.path);
        return res.redirect(base(cid) + '?tab=import&err=' + encodeURIComponent('CSV is empty or has no data rows'));
      }

      // Generate token and store staging data
      const token = crypto.randomBytes(16).toString('hex');
      const staging = {
        token, cid, filename: req.file.originalname,
        rawHeaders, dataRows,
        mapping: suggestMapping(rawHeaders),
        uploadedBy: who(req), uploadedAt: new Date().toISOString()
      };
      fs.writeFileSync(stagingPath(token), JSON.stringify(staging));
      fs.unlinkSync(req.file.path);

      // Render mapping step
      res.render('admin/expenses-import', {
        user: req.session.user, company, step: 'map',
        staging, sampleRows: dataRows.slice(0, 5),
        settings: getSettings(), page: 'companies',
        preview: null, commitResult: null, importErr: null
      });
    } catch(e) {
      console.error('Import upload error:', e.message);
      try { fs.unlinkSync(req.file.path); } catch(x) {}
      res.redirect(base(cid) + '?tab=import&err=' + encodeURIComponent('Failed to parse CSV: ' + e.message));
    }
  });

  // STEP 2: Apply mapping → preview with validation + dedupe
  router.post('/companies/:cid/expenses/import/preview', (req, res) => {
    const cid = parseInt(req.params.cid);
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(cid);
    if (!company) return res.redirect('/admin/companies');
    const token = req.body.token;
    const autoVendors = req.body.auto_vendors === '1';

    let staging;
    try { staging = JSON.parse(fs.readFileSync(stagingPath(token), 'utf-8')); }
    catch(e) { return res.redirect(base(cid) + '?tab=import&err=' + encodeURIComponent('Import session expired. Please upload again.')); }

    if (staging.cid !== cid) return res.status(403).send('Access denied');

    // Read user's column mapping from form
    const mapping = {};
    const TARGET_FIELDS = ['date','amount','description','vendor_name','category_name','cost_center_code','project_name','reference','invoice_number','notes'];
    TARGET_FIELDS.forEach(field => {
      const colIdx = req.body['map_' + field];
      if (colIdx !== undefined && colIdx !== '' && colIdx !== '-1') {
        mapping[parseInt(colIdx)] = field;
      }
    });

    // Validate required mappings
    const mappedFields = Object.values(mapping);
    if (!mappedFields.includes('date') || !mappedFields.includes('amount')) {
      return res.render('admin/expenses-import', {
        user: req.session.user, company, step: 'map',
        staging: { ...staging, mapping },
        sampleRows: staging.dataRows.slice(0, 5),
        settings: getSettings(), page: 'companies',
        preview: null, commitResult: null,
        importErr: 'You must map at least "Date" and "Amount" columns.'
      });
    }

    // Save updated mapping + options to staging
    staging.mapping = mapping;
    staging.autoVendors = autoVendors;

    // Apply mapping to all rows
    const lookups = buildLookups(cid);
    const preview = { valid: [], duplicates: [], invalid: [], warnings: 0, totalAmount: 0 };

    for (let i = 0; i < staging.dataRows.length; i++) {
      const vals = staging.dataRows[i];
      const row = {};
      for (const [colIdx, field] of Object.entries(mapping)) {
        row[field] = vals[parseInt(colIdx)] || '';
      }
      // Clean amount
      if (row.amount) row.amount = String(row.amount).replace(/[$,]/g, '');

      const result = resolveRow(cid, row, lookups, false, who(req)); // no auto-create in preview
      if (!result.valid) {
        preview.invalid.push({ line: i + 2, raw: vals, errors: result.errors });
        continue;
      }

      // Dedupe check
      const existing = safeGet('SELECT id FROM expense_transactions WHERE company_id = ? AND dedupe_hash = ?', [cid, result.resolved.hash]);
      if (existing) {
        preview.duplicates.push({ line: i + 2, raw: vals, resolved: result.resolved });
        continue;
      }

      if (result.resolved.warnings.length > 0) preview.warnings += result.resolved.warnings.length;
      preview.valid.push({ line: i + 2, raw: vals, resolved: result.resolved });
      preview.totalAmount += result.resolved.amount;
    }

    // Save staging for commit step
    fs.writeFileSync(stagingPath(token), JSON.stringify(staging));

    res.render('admin/expenses-import', {
      user: req.session.user, company, step: 'preview',
      staging, sampleRows: null,
      settings: getSettings(), page: 'companies',
      preview, commitResult: null, importErr: null
    });
  });

  // STEP 3: Commit — insert valid rows
  router.post('/companies/:cid/expenses/import/commit', (req, res) => {
    const cid = parseInt(req.params.cid);
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(cid);
    if (!company) return res.redirect('/admin/companies');
    const token = req.body.token;
    const autoVendors = req.body.auto_vendors === '1';

    let staging;
    try { staging = JSON.parse(fs.readFileSync(stagingPath(token), 'utf-8')); }
    catch(e) { return res.redirect(base(cid) + '?tab=import&err=' + encodeURIComponent('Import session expired. Please upload again.')); }

    if (staging.cid !== cid) return res.status(403).send('Access denied');

    const mapping = staging.mapping;
    const performer = who(req);

    // Create batch record
    const batch = db.prepare('INSERT INTO expense_import_batches (company_id, filename, source, status, total_rows, uploaded_by) VALUES (?,?,?,?,?,?)').run(
      cid, staging.filename, 'csv', 'processing', staging.dataRows.length, performer
    );
    const batchId = batch.lastInsertRowid;

    const lookups = buildLookups(cid);
    let imported = 0, skipped = 0;
    const errors = [];
    let totalAmount = 0;

    const insertTx = db.transaction(() => {
      for (let i = 0; i < staging.dataRows.length; i++) {
        const vals = staging.dataRows[i];
        const row = {};
        for (const [colIdx, field] of Object.entries(mapping)) {
          row[field] = vals[parseInt(colIdx)] || '';
        }
        if (row.amount) row.amount = String(row.amount).replace(/[$,]/g, '');

        const result = resolveRow(cid, row, lookups, autoVendors, performer);
        if (!result.valid) {
          errors.push({ line: i + 2, errors: result.errors });
          continue;
        }

        const r = result.resolved;

        // Dedupe check
        const existing = db.prepare('SELECT id FROM expense_transactions WHERE company_id = ? AND dedupe_hash = ?').get(cid, r.hash);
        if (existing) { skipped++; continue; }

        db.prepare('INSERT INTO expense_transactions (company_id, date, amount, description, vendor_id, vendor_name, category_id, category_name, cost_center_id, cost_center_code, project_id, project_name, reference, invoice_number, source, import_batch_id, dedupe_hash, status, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
          cid, r.date, r.amount, r.description,
          r.vendor_id, r.vendor_name,
          r.category_id, r.category_name,
          r.cost_center_id, r.cost_center_code,
          r.project_id, r.project_name,
          r.reference, r.invoice_number,
          'import', batchId, r.hash, 'pending', performer
        );
        totalAmount += r.amount;
        imported++;
      }
    });
    insertTx();

    // Update batch
    db.prepare('UPDATE expense_import_batches SET status=?, imported_rows=?, skipped_rows=?, error_rows=?, total_amount=?, errors=? WHERE id=?').run(
      'completed', imported, skipped, errors.length,
      Math.round(totalAmount * 100) / 100,
      errors.length > 0 ? JSON.stringify(errors.slice(0, 50)) : null, batchId
    );
    auditLog(cid, 'import', batchId, 'import', { filename: staging.filename, imported, skipped, errors: errors.length, autoVendors }, performer);

    cleanStaging(token);

    res.render('admin/expenses-import', {
      user: req.session.user, company, step: 'done',
      staging, sampleRows: null,
      settings: getSettings(), page: 'companies',
      preview: null, importErr: null,
      commitResult: { batchId, imported, skipped, errors: errors.length, totalAmount }
    });
  });

  // Rollback an import batch
  router.post('/companies/:cid/expenses/import/:bid/rollback', (req, res) => {
    const cid = req.params.cid;
    const batch = safeGet('SELECT * FROM expense_import_batches WHERE id = ? AND company_id = ?', [req.params.bid, cid]);
    if (!batch || batch.status !== 'completed') return res.redirect(base(cid) + '?tab=import');
    try {
      const cnt = db.prepare('DELETE FROM expense_transactions WHERE import_batch_id = ? AND company_id = ?').run(req.params.bid, cid);
      db.prepare("UPDATE expense_import_batches SET status = 'rolled_back' WHERE id = ? AND company_id = ?").run(req.params.bid, cid);
      auditLog(cid, 'import', req.params.bid, 'rollback', { deleted: cnt.changes, filename: batch.filename }, who(req));
    } catch(e) {}
    res.redirect(base(cid) + '?tab=import');
  });

  // ================================================================
  //  REPORT DRILL-DOWN PAGES
  // ================================================================

  // Shared: build date-range WHERE fragment
  function reportDateWhere(cid, req) {
    let where = 'company_id = ?'; let params = [cid];
    if (req.query.from) { where += ' AND date >= ?'; params.push(req.query.from); }
    if (req.query.to)   { where += ' AND date <= ?'; params.push(req.query.to); }
    return { where, params, from: req.query.from || '', to: req.query.to || '' };
  }

  // GET /companies/:cid/expenses/report/:type
  // type = cost-center | category | project
  router.get('/companies/:cid/expenses/report/:type', (req, res) => {
    const cid = parseInt(req.params.cid);
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(cid);
    if (!company) return res.redirect('/admin/companies');
    const type = req.params.type;
    if (!['cost-center','category','project'].includes(type)) return res.redirect(base(cid) + '?tab=reports');

    const rd = reportDateWhere(cid, req);
    // Drill-down filter: specific entity
    const drillId = req.query.id || '';
    const drillName = req.query.name || '';

    let groupCol, nameCol, idCol, title, icon;
    if (type === 'cost-center') {
      groupCol = 'cost_center_code'; nameCol = 'cost_center_code'; idCol = 'cost_center_id';
      title = 'Expenses by Cost Center'; icon = 'ti-sitemap';
    } else if (type === 'category') {
      groupCol = 'category_name'; nameCol = 'category_name'; idCol = 'category_id';
      title = 'Expenses by Category'; icon = 'ti-tags';
    } else {
      groupCol = 'project_name'; nameCol = 'project_name'; idCol = 'project_id';
      title = 'Expenses by Project'; icon = 'ti-clipboard-list';
    }

    // Summary rows grouped by entity
    const summary = safeAll(
      'SELECT ' + idCol + ' as entity_id, ' + nameCol + ' as entity_name, SUM(amount) as total, COUNT(*) as cnt FROM expense_transactions WHERE ' + rd.where + ' AND ' + nameCol + ' IS NOT NULL GROUP BY ' + idCol + ', ' + nameCol + ' ORDER BY total DESC',
      rd.params
    );
    const grandTotal = summary.reduce((s, r) => s + (r.total || 0), 0);

    // Monthly breakdown per entity
    const monthly = safeAll(
      "SELECT " + nameCol + " as entity_name, strftime('%Y-%m', date) as month, SUM(amount) as total FROM expense_transactions WHERE " + rd.where + " AND " + nameCol + " IS NOT NULL GROUP BY " + nameCol + ", strftime('%Y-%m', date) ORDER BY month",
      rd.params
    );
    // Pivot: { entityName: { month: total } }
    const monthlyMap = {};
    const allMonths = new Set();
    monthly.forEach(r => {
      if (!monthlyMap[r.entity_name]) monthlyMap[r.entity_name] = {};
      monthlyMap[r.entity_name][r.month] = r.total;
      allMonths.add(r.month);
    });
    const months = Array.from(allMonths).sort();

    // Drill-down transactions (if id or name specified)
    let drillTxns = [];
    let drillTotal = null;
    if (drillId || drillName) {
      let dWhere = rd.where;
      let dParams = [...rd.params];
      if (drillId) { dWhere += ' AND ' + idCol + ' = ?'; dParams.push(parseInt(drillId)); }
      else if (drillName) { dWhere += ' AND ' + nameCol + ' = ?'; dParams.push(drillName); }
      drillTxns = safeAll('SELECT * FROM expense_transactions WHERE ' + dWhere + ' ORDER BY date DESC LIMIT 200', dParams);
      drillTotal = safeGet('SELECT SUM(amount) as total, COUNT(*) as cnt FROM expense_transactions WHERE ' + dWhere, dParams) || { total: 0, cnt: 0 };

      // If drilling into a cost center, also show category breakdown within it
      if (type === 'cost-center' && drillTxns.length > 0) {
        drillTotal.subBreakdown = safeAll('SELECT category_name, SUM(amount) as total, COUNT(*) as cnt FROM expense_transactions WHERE ' + dWhere + ' GROUP BY category_name ORDER BY total DESC', dParams);
      }
      // If drilling into a project, show category breakdown
      if (type === 'project' && drillTxns.length > 0) {
        drillTotal.subBreakdown = safeAll('SELECT category_name, SUM(amount) as total, COUNT(*) as cnt FROM expense_transactions WHERE ' + dWhere + ' GROUP BY category_name ORDER BY total DESC', dParams);
      }
    }

    const userCanExport = canExpense(req.session.user, 'export');

    res.render('admin/expenses-report', {
      user: req.session.user, company, type, title, icon,
      summary, grandTotal, months, monthlyMap,
      drillId, drillName, drillTxns, drillTotal,
      from: rd.from, to: rd.to, userCanExport,
      settings: getSettings(), page: 'companies'
    });
  });

  // Report CSV export
  router.get('/companies/:cid/expenses/report/:type/export', (req, res) => {
    const cid = parseInt(req.params.cid);
    if (!canExpense(req.session.user, 'export')) return res.status(403).send('Access denied');
    const type = req.params.type;
    if (!['cost-center','category','project'].includes(type)) return res.status(400).send('Invalid report type');

    const rd = reportDateWhere(cid, req);
    const drillId = req.query.id || '';
    const drillName = req.query.name || '';

    let nameCol, idCol;
    if (type === 'cost-center') { nameCol = 'cost_center_code'; idCol = 'cost_center_id'; }
    else if (type === 'category') { nameCol = 'category_name'; idCol = 'category_id'; }
    else { nameCol = 'project_name'; idCol = 'project_id'; }

    let where = rd.where; let params = [...rd.params];
    if (drillId) { where += ' AND ' + idCol + ' = ?'; params.push(parseInt(drillId)); }
    else if (drillName) { where += ' AND ' + nameCol + ' = ?'; params.push(drillName); }

    const rows = safeAll('SELECT * FROM expense_transactions WHERE ' + where + ' ORDER BY date DESC', params);
    const headers = ['date','amount','description','vendor_name','category_name','cost_center_code','project_name','reference','invoice_number','status','source','created_by'];
    const esc = (v) => { const s = String(v==null?'':v); return s.includes(',')||s.includes('"')?'"'+s.replace(/"/g,'""')+'"':s; };
    const csv = [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');

    auditLog(cid, 'export', null, 'report_csv_export', { type, drillId: drillId||null, drillName: drillName||null, rows: rows.length }, who(req));

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=report-' + type + '-' + cid + '-' + new Date().toISOString().split('T')[0] + '.csv');
    res.send(csv);
  });

  // ================================================================
  //  PAYROLL — salary profiles + runs
  // ================================================================

  // Ensure a "Payroll" category exists for this company; return its id
  function ensurePayrollCategory(cid, performer) {
    let cat = safeGet("SELECT id FROM expense_categories WHERE company_id = ? AND name = 'Payroll'", [cid]);
    if (cat) return cat.id;
    try {
      const r = db.prepare("INSERT INTO expense_categories (company_id, name, icon, sort_order) VALUES (?,'Payroll','ti-cash',0)").run(cid);
      auditLog(cid, 'category', r.lastInsertRowid, 'auto_create', { name: 'Payroll', reason: 'salary_module' }, performer);
      return r.lastInsertRowid;
    } catch(e) {
      // UNIQUE constraint — race condition, re-fetch
      cat = safeGet("SELECT id FROM expense_categories WHERE company_id = ? AND name = 'Payroll'", [cid]);
      return cat ? cat.id : null;
    }
  }

  // --- Salary Profiles CRUD ---

  router.post('/companies/:cid/expenses/salary/profiles', (req, res) => {
    const b = req.body; const cid = req.params.cid;
    if (!b.employee_id || !b.amount) return res.redirect(base(cid) + '?tab=payroll&perr=' + encodeURIComponent('Employee and amount are required'));
    // Resolve employee name
    const emp = safeGet('SELECT name FROM company_users WHERE id = ? AND company_id = ?', [b.employee_id, cid]);
    if (!emp) return res.redirect(base(cid) + '?tab=payroll&perr=' + encodeURIComponent('Employee not found'));
    // Uniqueness
    const dup = safeGet('SELECT id FROM salary_profiles WHERE company_id = ? AND employee_id = ?', [cid, b.employee_id]);
    if (dup) return res.redirect(base(cid) + '?tab=payroll&perr=' + encodeURIComponent('Profile already exists for this employee'));
    try {
      const r = db.prepare('INSERT INTO salary_profiles (company_id, employee_id, employee_name, cost_center_id, project_id, pay_frequency, amount, effective_from, effective_to, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
        cid, b.employee_id, emp.name, b.cost_center_id||null, b.project_id||null,
        b.pay_frequency||'monthly', parseFloat(b.amount)||0,
        b.effective_from||null, b.effective_to||null, b.notes||null, who(req)
      );
      auditLog(cid, 'salary_profile', r.lastInsertRowid, 'create', { employee: emp.name, amount: b.amount, frequency: b.pay_frequency }, who(req));
    } catch(e) { console.error('Salary profile create:', e.message); }
    res.redirect(base(cid) + '?tab=payroll');
  });

  router.post('/companies/:cid/expenses/salary/profiles/:pid/edit', (req, res) => {
    const b = req.body; const cid = req.params.cid;
    const old = safeGet('SELECT * FROM salary_profiles WHERE id = ? AND company_id = ?', [req.params.pid, cid]);
    if (!old) return res.redirect(base(cid) + '?tab=payroll');
    try {
      db.prepare("UPDATE salary_profiles SET cost_center_id=?, project_id=?, pay_frequency=?, amount=?, effective_from=?, effective_to=?, notes=?, updated_at=datetime('now') WHERE id=? AND company_id=?").run(
        b.cost_center_id||null, b.project_id||null, b.pay_frequency||'monthly',
        parseFloat(b.amount)||0, b.effective_from||null, b.effective_to||null,
        b.notes||null, req.params.pid, cid
      );
      const diff = buildDiff(old, { amount: parseFloat(b.amount)||0, pay_frequency: b.pay_frequency, cost_center_id: b.cost_center_id||null, project_id: b.project_id||null }, ['amount','pay_frequency','cost_center_id','project_id']);
      auditLog(cid, 'salary_profile', req.params.pid, 'update', diff, who(req));
    } catch(e) {}
    res.redirect(base(cid) + '?tab=payroll');
  });

  router.post('/companies/:cid/expenses/salary/profiles/:pid/deactivate', (req, res) => {
    const cid = req.params.cid;
    const old = safeGet('SELECT * FROM salary_profiles WHERE id = ? AND company_id = ?', [req.params.pid, cid]);
    if (!old) return res.redirect(base(cid) + '?tab=payroll');
    const newStatus = old.is_active ? 0 : 1;
    try {
      db.prepare('UPDATE salary_profiles SET is_active = ? WHERE id = ? AND company_id = ?').run(newStatus, req.params.pid, cid);
      auditLog(cid, 'salary_profile', req.params.pid, newStatus ? 'reactivate' : 'deactivate', { employee: old.employee_name }, who(req));
    } catch(e) {}
    res.redirect(base(cid) + '?tab=payroll');
  });

  // --- Salary Runs ---

  // Create a new run (draft) — generates lines from active profiles
  router.post('/companies/:cid/expenses/salary/runs', (req, res) => {
    const b = req.body; const cid = req.params.cid;
    if (!b.period_start || !b.period_end || !b.pay_date) return res.redirect(base(cid) + '?tab=payroll&perr=' + encodeURIComponent('Period start, end, and pay date are required'));

    // Get active profiles effective for this period
    const profiles = safeAll(
      "SELECT sp.*, ecc.code as cc_code, p.name as proj_name FROM salary_profiles sp LEFT JOIN expense_cost_centers ecc ON sp.cost_center_id = ecc.id LEFT JOIN projects p ON sp.project_id = p.id WHERE sp.company_id = ? AND sp.is_active = 1 AND (sp.effective_from IS NULL OR sp.effective_from <= ?) AND (sp.effective_to IS NULL OR sp.effective_to >= ?)",
      [cid, b.period_end, b.period_start]
    );
    if (profiles.length === 0) return res.redirect(base(cid) + '?tab=payroll&perr=' + encodeURIComponent('No active salary profiles found for this period'));

    try {
      const total = profiles.reduce((s, p) => s + (p.amount || 0), 0);
      const run = db.prepare('INSERT INTO salary_runs (company_id, period_start, period_end, pay_date, status, total_amount, line_count, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?)').run(
        cid, b.period_start, b.period_end, b.pay_date, 'draft',
        Math.round(total * 100) / 100, profiles.length, b.notes||null, who(req)
      );
      const runId = run.lastInsertRowid;
      const ins = db.prepare('INSERT INTO salary_run_lines (run_id, company_id, profile_id, employee_id, employee_name, amount, cost_center_id, cost_center_code, project_id, project_name, description) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
      for (const p of profiles) {
        ins.run(runId, cid, p.id, p.employee_id, p.employee_name, p.amount,
          p.cost_center_id, p.cc_code||null, p.project_id, p.proj_name||null,
          'Salary ' + b.period_start + ' to ' + b.period_end + ' — ' + p.employee_name
        );
      }
      auditLog(cid, 'salary_run', runId, 'create', { period: b.period_start + ' to ' + b.period_end, employees: profiles.length, total }, who(req));
    } catch(e) { console.error('Salary run create:', e.message); }
    res.redirect(base(cid) + '?tab=payroll');
  });

  // Approve a draft run
  router.post('/companies/:cid/expenses/salary/runs/:rid/approve', (req, res) => {
    const cid = req.params.cid;
    const run = safeGet('SELECT * FROM salary_runs WHERE id = ? AND company_id = ? AND status = ?', [req.params.rid, cid, 'draft']);
    if (!run) return res.redirect(base(cid) + '?tab=payroll');
    try {
      db.prepare("UPDATE salary_runs SET status='approved', approved_by=?, approved_at=datetime('now') WHERE id=?").run(who(req), req.params.rid);
      auditLog(cid, 'salary_run', req.params.rid, 'approve', null, who(req));
    } catch(e) {}
    res.redirect(base(cid) + '?tab=payroll');
  });

  // Post an approved run — create expense transactions source='salary'
  router.post('/companies/:cid/expenses/salary/runs/:rid/post', (req, res) => {
    const cid = parseInt(req.params.cid);
    const run = safeGet('SELECT * FROM salary_runs WHERE id = ? AND company_id = ? AND status = ?', [req.params.rid, cid, 'approved']);
    if (!run) return res.redirect(base(cid) + '?tab=payroll');

    const lines = safeAll('SELECT * FROM salary_run_lines WHERE run_id = ? AND company_id = ?', [run.id, cid]);
    if (lines.length === 0) return res.redirect(base(cid) + '?tab=payroll');

    const payrollCatId = ensurePayrollCategory(cid, who(req));
    const performer = who(req);

    const postTx = db.transaction(() => {
      for (const line of lines) {
        const hash = dedupeHash(cid, run.pay_date, line.amount, line.description, 'SALARY-RUN-' + run.id, line.employee_name);
        const r = db.prepare('INSERT INTO expense_transactions (company_id, date, amount, description, vendor_name, category_id, category_name, cost_center_id, cost_center_code, project_id, project_name, reference, source, dedupe_hash, status, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
          cid, run.pay_date, line.amount, line.description,
          line.employee_name, payrollCatId, 'Payroll',
          line.cost_center_id, line.cost_center_code,
          line.project_id, line.project_name,
          'SALARY-RUN-' + run.id, 'salary', hash, 'approved', performer
        );
        db.prepare('UPDATE salary_run_lines SET transaction_id = ? WHERE id = ?').run(r.lastInsertRowid, line.id);
      }
      db.prepare("UPDATE salary_runs SET status='posted', posted_by=?, posted_at=datetime('now') WHERE id=?").run(performer, run.id);
    });
    postTx();

    auditLog(cid, 'salary_run', run.id, 'post', { lines: lines.length, total: run.total_amount, pay_date: run.pay_date }, performer);
    res.redirect(base(cid) + '?tab=payroll');
  });

  // Delete a draft run (only draft)
  router.post('/companies/:cid/expenses/salary/runs/:rid/delete', (req, res) => {
    const cid = req.params.cid;
    const run = safeGet('SELECT * FROM salary_runs WHERE id = ? AND company_id = ? AND status = ?', [req.params.rid, cid, 'draft']);
    if (!run) return res.redirect(base(cid) + '?tab=payroll');
    try {
      db.prepare('DELETE FROM salary_run_lines WHERE run_id = ?').run(run.id);
      db.prepare('DELETE FROM salary_runs WHERE id = ?').run(run.id);
      auditLog(cid, 'salary_run', run.id, 'delete', { period: run.period_start + ' to ' + run.period_end }, who(req));
    } catch(e) {}
    res.redirect(base(cid) + '?tab=payroll');
  });

  // ================================================================
  //  CSV EXPORT — only expense_finance / expense_admin
  // ================================================================
  router.get('/companies/:cid/expenses/export', (req, res) => {
    const cid = req.params.cid;
    if (!canExpense(req.session.user, 'export')) {
      return res.status(403).send('Access denied — export requires expense_finance or expense_admin role');
    }

    // Re-use the same filter builder so export matches what is on screen
    const f = {
      dateFrom: req.query.from || '', dateTo: req.query.to || '',
      category: req.query.category || '', costCenter: req.query.cc || '',
      project: req.query.project || '', vendor: req.query.vendor || '',
      status: req.query.status || '', source: req.query.source || ''
    };
    const tw = buildTxWhere(parseInt(cid), f);

    const rows = safeAll(
      'SELECT t.* FROM expense_transactions t WHERE ' + tw.clause + ' ORDER BY t.date DESC',
      tw.params
    );
    const headers = ['date','amount','description','vendor_name','category_name','cost_center_code','project_name','reference','invoice_number','status','source','approved_by','created_by','notes'];
    const escape = (v) => { const s = String(v==null?'':v); return s.includes(',')||s.includes('"')?'"'+s.replace(/"/g,'""')+'"':s; };
    const csv = [headers.join(','), ...rows.map(r => headers.map(h => escape(r[h])).join(','))].join('\n');

    auditLog(cid, 'export', null, 'csv_export', {
      rows: rows.length,
      filters: Object.fromEntries(Object.entries(f).filter(([,v]) => v))
    }, who(req));

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=expenses-' + cid + '-' + new Date().toISOString().split('T')[0] + '.csv');
    res.send(csv);
  });

  return router;
};
