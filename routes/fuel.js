const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');

module.exports = function(db) {
  router.use(requireAdmin);

  // Company scope check for all fuel routes
  router.use('/companies/:cid/fuel*', (req, res, next) => {
    const u = req.session.user;
    if (u.is_super) return next();
    if (u.assignedCompanies && !u.assignedCompanies.includes(parseInt(req.params.cid))) {
      return res.status(403).send('Access denied');
    }
    next();
  });

  const safeAll = (sql, params) => { try { return params ? db.prepare(sql).all(...(Array.isArray(params)?params:[params])) : db.prepare(sql).all(); } catch(e) { return []; } };
  const safeGet = (sql, params) => { try { return params ? db.prepare(sql).get(...(Array.isArray(params)?params:[params])) : db.prepare(sql).get(); } catch(e) { return null; } };
  const getSettings = () => { const s = {}; try { db.prepare('SELECT key, value FROM settings').all().forEach(r => { s[r.key] = r.value; }); } catch(e) {} return s; };

  // Audit helper
  function auditLog(companyId, action, details, req, extra) {
    try {
      db.prepare('INSERT INTO fuel_audit_log (company_id, driver_id, vehicle_id, action, details, created_by) VALUES (?,?,?,?,?,?)').run(
        companyId, (extra && extra.driver_id) || null, (extra && extra.vehicle_id) || null,
        action, details, req.session.user.full_name || req.session.user.username
      );
    } catch(e) {}
  }

  // === FUEL DASHBOARD ===
  router.get('/companies/:cid/fuel', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.cid);
    if (!company) return res.redirect('/admin/companies');
    const config = safeGet('SELECT * FROM fuel_config WHERE company_id = ?', [company.id]) || {};
    const groups = safeAll('SELECT * FROM fuel_groups WHERE company_id = ? ORDER BY name', [company.id]);
    // Enrich groups with truck/driver counts
    groups.forEach(g => {
      g.trucks = safeAll('SELECT m.*, v.unit_number, v.make, v.model, v.year, v.vin FROM fuel_truck_group_map m JOIN fleet_vehicles v ON m.vehicle_id = v.id WHERE m.group_id = ? AND m.company_id = ?', [g.id, company.id]);
      g.drivers = safeAll('SELECT m.*, d.name, d.role FROM fuel_driver_group_map m JOIN company_users d ON m.driver_id = d.id WHERE m.group_id = ? AND m.company_id = ?', [g.id, company.id]);
    });
    const baselines = safeAll('SELECT b.*, d.name as driver_name, g.name as group_name FROM fuel_driver_baselines b LEFT JOIN company_users d ON b.driver_id = d.id LEFT JOIN fuel_groups g ON b.group_id = g.id WHERE b.company_id = ? ORDER BY d.name', [company.id]);
    const auditEntries = safeAll('SELECT a.*, d.name as driver_name, v.unit_number as vehicle_unit FROM fuel_audit_log a LEFT JOIN company_users d ON a.driver_id = d.id LEFT JOIN fleet_vehicles v ON a.vehicle_id = v.id WHERE a.company_id = ? ORDER BY a.created_at DESC LIMIT 50', [company.id]);
    const drivers = safeAll("SELECT id, name, department, role FROM company_users WHERE company_id = ? AND is_active = 1 ORDER BY name", [company.id]);
    const vehicles = safeAll("SELECT id, unit_number, make, model, year, vin FROM fleet_vehicles WHERE company_id = ? ORDER BY unit_number", [company.id]);
    const tab = req.query.tab || 'dashboard';
    res.render('admin/fuel', { user: req.session.user, company, config, groups, baselines, auditLog: auditEntries, drivers, vehicles, tab, settings: getSettings(), page: 'companies' });
  });

  // === CONFIG ===
  router.post('/companies/:cid/fuel/config', (req, res) => {
    const b = req.body;
    const existing = safeGet('SELECT id FROM fuel_config WHERE company_id = ?', [req.params.cid]);
    const vals = [b.enabled?1:0, b.billing_mode||'per-truck', parseFloat(b.split_driver_pct)||50, parseFloat(b.split_company_pct)||50, parseInt(b.baseline_window_days)||90, parseFloat(b.baseline_mpg)||0, b.fuel_price_source||'manual', parseFloat(b.fuel_price_manual)||0, parseInt(b.min_miles_qualify)||500, parseFloat(b.ceiling_bonus_per_gallon)||0.50, parseFloat(b.floor_penalty_per_gallon)||0, b.pay_frequency||'monthly', b.notes||null];
    if (existing) {
      db.prepare("UPDATE fuel_config SET enabled=?, billing_mode=?, split_driver_pct=?, split_company_pct=?, baseline_window_days=?, baseline_mpg=?, fuel_price_source=?, fuel_price_manual=?, min_miles_qualify=?, ceiling_bonus_per_gallon=?, floor_penalty_per_gallon=?, pay_frequency=?, notes=?, updated_at=datetime('now') WHERE company_id=?").run(...vals, req.params.cid);
    } else {
      db.prepare('INSERT INTO fuel_config (enabled, billing_mode, split_driver_pct, split_company_pct, baseline_window_days, baseline_mpg, fuel_price_source, fuel_price_manual, min_miles_qualify, ceiling_bonus_per_gallon, floor_penalty_per_gallon, pay_frequency, notes, company_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...vals, req.params.cid);
    }
    auditLog(req.params.cid, 'config_updated', 'Fuel incentive config saved', req);
    res.redirect('/admin/companies/' + req.params.cid + '/fuel?tab=config');
  });

  // === GROUPS CRUD ===
  router.post('/companies/:cid/fuel/groups', (req, res) => {
    const { name, description, baseline_mpg } = req.body;
    if (!name) return res.redirect('/admin/companies/' + req.params.cid + '/fuel?tab=groups');
    try {
      db.prepare('INSERT INTO fuel_groups (company_id, name, description, baseline_mpg) VALUES (?,?,?,?)').run(req.params.cid, name.trim(), description||null, parseFloat(baseline_mpg)||0);
      auditLog(req.params.cid, 'group_created', 'Group: ' + name, req);
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/fuel?tab=groups');
  });

  router.post('/companies/:cid/fuel/groups/:gid/edit', (req, res) => {
    const { name, description, baseline_mpg, is_active } = req.body;
    try {
      db.prepare('UPDATE fuel_groups SET name=?, description=?, baseline_mpg=?, is_active=? WHERE id=? AND company_id=?').run(name, description||null, parseFloat(baseline_mpg)||0, is_active?1:0, req.params.gid, req.params.cid);
      auditLog(req.params.cid, 'group_updated', 'Group: ' + name, req);
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/fuel?tab=groups');
  });

  router.post('/companies/:cid/fuel/groups/:gid/delete', (req, res) => {
    const g = safeGet('SELECT name FROM fuel_groups WHERE id = ?', [req.params.gid]);
    try {
      db.prepare('DELETE FROM fuel_truck_group_map WHERE group_id = ? AND company_id = ?').run(req.params.gid, req.params.cid);
      db.prepare('DELETE FROM fuel_driver_group_map WHERE group_id = ? AND company_id = ?').run(req.params.gid, req.params.cid);
      db.prepare('DELETE FROM fuel_groups WHERE id = ? AND company_id = ?').run(req.params.gid, req.params.cid);
      auditLog(req.params.cid, 'group_deleted', 'Group: ' + (g ? g.name : req.params.gid), req);
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/fuel?tab=groups');
  });

  // === ASSIGN TRUCKS TO GROUPS ===
  router.post('/companies/:cid/fuel/groups/:gid/assign-truck', (req, res) => {
    const { vehicle_id } = req.body;
    if (!vehicle_id) return res.redirect('/admin/companies/' + req.params.cid + '/fuel?tab=groups');
    try {
      // Remove from old group if any
      db.prepare('DELETE FROM fuel_truck_group_map WHERE vehicle_id = ? AND company_id = ?').run(vehicle_id, req.params.cid);
      db.prepare('INSERT INTO fuel_truck_group_map (company_id, vehicle_id, group_id, assigned_by) VALUES (?,?,?,?)').run(req.params.cid, vehicle_id, req.params.gid, req.session.user.full_name || req.session.user.username);
      const v = safeGet('SELECT unit_number FROM fleet_vehicles WHERE id = ?', [vehicle_id]);
      const g = safeGet('SELECT name FROM fuel_groups WHERE id = ?', [req.params.gid]);
      auditLog(req.params.cid, 'truck_assigned', 'Truck #' + (v?v.unit_number:'?') + ' → ' + (g?g.name:'?'), req, { vehicle_id: parseInt(vehicle_id) });
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/fuel?tab=groups');
  });

  router.post('/companies/:cid/fuel/groups/:gid/remove-truck/:vid', (req, res) => {
    try {
      db.prepare('DELETE FROM fuel_truck_group_map WHERE vehicle_id = ? AND group_id = ? AND company_id = ?').run(req.params.vid, req.params.gid, req.params.cid);
      auditLog(req.params.cid, 'truck_unassigned', 'Truck removed from group', req, { vehicle_id: parseInt(req.params.vid) });
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/fuel?tab=groups');
  });

  // === ASSIGN DRIVERS TO GROUPS ===
  router.post('/companies/:cid/fuel/groups/:gid/assign-driver', (req, res) => {
    const { driver_id } = req.body;
    if (!driver_id) return res.redirect('/admin/companies/' + req.params.cid + '/fuel?tab=groups');
    try {
      db.prepare('DELETE FROM fuel_driver_group_map WHERE driver_id = ? AND company_id = ?').run(driver_id, req.params.cid);
      db.prepare('INSERT INTO fuel_driver_group_map (company_id, driver_id, group_id, assigned_by) VALUES (?,?,?,?)').run(req.params.cid, driver_id, req.params.gid, req.session.user.full_name || req.session.user.username);
      const d = safeGet('SELECT name FROM company_users WHERE id = ?', [driver_id]);
      const g = safeGet('SELECT name FROM fuel_groups WHERE id = ?', [req.params.gid]);
      auditLog(req.params.cid, 'driver_assigned', (d?d.name:'?') + ' → ' + (g?g.name:'?'), req, { driver_id: parseInt(driver_id) });
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/fuel?tab=groups');
  });

  router.post('/companies/:cid/fuel/groups/:gid/remove-driver/:did', (req, res) => {
    try {
      db.prepare('DELETE FROM fuel_driver_group_map WHERE driver_id = ? AND group_id = ? AND company_id = ?').run(req.params.did, req.params.gid, req.params.cid);
      auditLog(req.params.cid, 'driver_unassigned', 'Driver removed from group', req, { driver_id: parseInt(req.params.did) });
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/fuel?tab=groups');
  });

  // === DRIVER BASELINES ===
  router.post('/companies/:cid/fuel/baselines', (req, res) => {
    const { driver_id, group_id, baseline_mpg, effective_date, notes } = req.body;
    try {
      // Upsert — update if exists for this driver
      const existing = safeGet('SELECT id FROM fuel_driver_baselines WHERE company_id = ? AND driver_id = ?', [req.params.cid, driver_id]);
      if (existing) {
        db.prepare('UPDATE fuel_driver_baselines SET group_id=?, baseline_mpg=?, effective_date=?, notes=? WHERE id=?').run(group_id||null, parseFloat(baseline_mpg)||0, effective_date||null, notes||null, existing.id);
      } else {
        db.prepare('INSERT INTO fuel_driver_baselines (company_id, driver_id, group_id, baseline_mpg, effective_date, notes) VALUES (?,?,?,?,?,?)').run(req.params.cid, driver_id, group_id||null, parseFloat(baseline_mpg)||0, effective_date||null, notes||null);
      }
      const d = safeGet('SELECT name FROM company_users WHERE id = ?', [driver_id]);
      auditLog(req.params.cid, 'baseline_set', (d?d.name:'?') + ' baseline: ' + baseline_mpg + ' MPG', req, { driver_id: parseInt(driver_id) });
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/fuel?tab=baselines');
  });

  // === VIN DECODE ===
  router.post('/companies/:cid/fuel/vin/decode', async (req, res) => {
    const { truck_id, vin: rawVin } = req.body;
    let vin = rawVin;

    // If truck_id provided, get VIN from truck
    if (truck_id && !vin) {
      const truck = safeGet('SELECT vin FROM fleet_vehicles WHERE id = ? AND company_id = ?', [truck_id, req.params.cid]);
      if (truck) vin = truck.vin;
    }

    if (!vin) {
      return res.json({ ok: false, error: 'No VIN provided' });
    }

    const { decodeVIN } = require('../lib/vin-decode');
    const result = await decodeVIN(db, vin);

    // If success and truck_id provided, update the truck record
    if (result.ok && truck_id) {
      const d = result.data;
      try {
        db.prepare('UPDATE fleet_vehicles SET make=COALESCE(?,make), model=COALESCE(?,model), year=COALESCE(?,year) WHERE id=? AND company_id=?').run(
          d.make, d.model, d.year, truck_id, req.params.cid
        );
        auditLog(req.params.cid, 'vin_decoded', 'VIN ' + vin + ' → ' + [d.year, d.make, d.model].filter(Boolean).join(' '), req, { vehicle_id: parseInt(truck_id) });
      } catch(e) {}
    }

    // If AJAX request, return JSON
    if (req.xhr || req.headers.accept === 'application/json' || req.query.json) {
      return res.json(result);
    }
    // Otherwise redirect back
    res.redirect('/admin/companies/' + req.params.cid + '/fuel?tab=groups');
  });

  // === PERIODS + LEDGER ===
  router.get('/companies/:cid/fuel/periods', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.cid);
    if (!company) return res.redirect('/admin/companies');
    const periods = safeAll('SELECT * FROM fuel_payout_periods WHERE company_id = ? ORDER BY period_start DESC', [company.id]);
    res.render('admin/fuel-periods', { user: req.session.user, company, periods, settings: getSettings(), page: 'companies' });
  });

  router.post('/companies/:cid/fuel/periods', (req, res) => {
    const { period_start, period_end } = req.body;
    try { db.prepare('INSERT INTO fuel_payout_periods (company_id, period_start, period_end) VALUES (?,?,?)').run(req.params.cid, period_start, period_end); } catch(e) {}
    auditLog(req.params.cid, 'period_created', period_start + ' to ' + period_end, req);
    res.redirect('/admin/companies/' + req.params.cid + '/fuel/periods');
  });

  router.post('/companies/:cid/fuel/periods/:pid/calculate', (req, res) => {
    try {
      const { calculatePeriod } = require('../lib/fuel-calc');
      const result = calculatePeriod(db, parseInt(req.params.cid), parseInt(req.params.pid));
      auditLog(req.params.cid, 'period_calculated', result.totals.eligible + ' eligible, $' + result.totals.driverPayout.toFixed(2) + ' total payout', req);
      // Check ceiling switch
      try {
        const { checkCeilingSwitch } = require('../lib/fuel-ceiling');
        checkCeilingSwitch(db, parseInt(req.params.cid), parseInt(req.params.pid));
      } catch(ce) { console.error('Ceiling check:', ce.message); }
    } catch(e) {
      console.error('Calc error:', e.message);
      auditLog(req.params.cid, 'period_calc_error', e.message, req);
    }
    res.redirect('/admin/companies/' + req.params.cid + '/fuel/ledger?period=' + req.params.pid);
  });

  router.post('/companies/:cid/fuel/periods/:pid/approve', (req, res) => {
    try {
      db.prepare("UPDATE fuel_payout_periods SET status = 'approved', approved_at = datetime('now'), approved_by = ? WHERE id = ? AND company_id = ? AND status = 'calculated'").run(
        req.session.user.full_name || req.session.user.username, req.params.pid, req.params.cid
      );
      auditLog(req.params.cid, 'period_approved', 'Period #' + req.params.pid, req);
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/fuel/periods');
  });

  router.post('/companies/:cid/fuel/periods/:pid/close', (req, res) => {
    try {
      db.prepare("UPDATE fuel_payout_periods SET status = 'closed', closed_at = datetime('now'), closed_by = ? WHERE id = ? AND company_id = ? AND status = 'approved'").run(
        req.session.user.full_name || req.session.user.username, req.params.pid, req.params.cid
      );
      auditLog(req.params.cid, 'period_closed', 'Period #' + req.params.pid, req);
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/fuel/periods');
  });

  // Ledger view
  router.get('/companies/:cid/fuel/ledger', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.cid);
    if (!company) return res.redirect('/admin/companies');
    const periodId = req.query.period;
    const periods = safeAll('SELECT * FROM fuel_payout_periods WHERE company_id = ? ORDER BY period_start DESC', [company.id]);
    const period = periodId ? safeGet('SELECT * FROM fuel_payout_periods WHERE id = ? AND company_id = ?', [periodId, company.id]) : (periods[0] || null);
    const ledgers = period ? safeAll('SELECT * FROM fuel_payout_ledgers WHERE period_id = ? AND company_id = ? ORDER BY driver_payout DESC', [period.id, company.id]) : [];
    res.render('admin/fuel-ledger', { user: req.session.user, company, periods, period, ledgers, settings: getSettings(), page: 'companies' });
  });

  // CSV export
  router.get('/companies/:cid/fuel/ledger/export', (req, res) => {
    const periodId = req.query.period;
    if (!periodId) return res.status(400).send('Period required');
    const period = safeGet('SELECT * FROM fuel_payout_periods WHERE id = ? AND company_id = ?', [periodId, req.params.cid]);
    if (!period) return res.status(404).send('Period not found');
    const ledgers = safeAll('SELECT * FROM fuel_payout_ledgers WHERE period_id = ? AND company_id = ?', [periodId, req.params.cid]);

    const headers = ['driver_name','status','total_miles','total_gallons','actual_mpg','baseline_mpg','target_mpg','savings_gallons','savings_usd','driver_share_usd','kpi_bonus_usd','driver_payout','group_name','target_source','mpg_method'];
    const escape = (v) => { const s = String(v==null?'':v); return s.includes(',')||s.includes('"')?'"'+s.replace(/"/g,'""')+'"':s; };
    const csv = [headers.join(','), ...ledgers.map(r => headers.map(h => escape(r[h])).join(','))].join('\n');

    // Verify totals
    const csvTotal = ledgers.reduce((s, l) => s + (l.driver_payout || 0), 0);
    const periodTotal = period.total_driver_payout || 0;

    auditLog(req.params.cid, 'ledger_exported', 'Period ' + period.period_start + '-' + period.period_end + ', ' + ledgers.length + ' rows, $' + csvTotal.toFixed(2) + ' total (period total: $' + periodTotal.toFixed(2) + ')', req);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=fuel-ledger-' + period.period_start + '-' + period.period_end + '.csv');
    res.send(csv);
  });

  // === REPORTS ===
  router.get('/companies/:cid/fuel/reports', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.cid);
    if (!company) return res.redirect('/admin/companies');
    const tab = req.query.tab || 'fleet';

    // Fleet MPG trend by month
    const fleetTrend = safeAll("SELECT strftime('%Y-%m', date) as month, SUM(miles) as miles, SUM(gallons) as gallons, CASE WHEN SUM(gallons) > 0 THEN ROUND(SUM(miles)/SUM(gallons), 2) ELSE 0 END as mpg, COUNT(DISTINCT vehicle_id) as trucks FROM fuel_measurements_daily WHERE company_id = ? AND miles > 0 GROUP BY month ORDER BY month DESC LIMIT 12", [company.id]).reverse();

    // Group trend
    const groups = safeAll('SELECT * FROM fuel_groups WHERE company_id = ? AND is_active = 1 ORDER BY name', [company.id]);
    const groupTrends = {};
    groups.forEach(g => {
      const vids = safeAll('SELECT vehicle_id FROM fuel_truck_group_map WHERE group_id = ? AND company_id = ?', [g.id, company.id]).map(r => r.vehicle_id);
      if (vids.length === 0) return;
      var vidPh = vids.map(() => '?').join(',');
      groupTrends[g.name] = safeAll("SELECT strftime('%Y-%m', date) as month, ROUND(SUM(miles)/NULLIF(SUM(gallons),0), 2) as mpg, SUM(miles) as miles FROM fuel_measurements_daily WHERE company_id = ? AND vehicle_id IN (" + vidPh + ") AND miles > 0 GROUP BY month ORDER BY month DESC LIMIT 12", [company.id, ...vids]).reverse();
    });

    // Driver ranking within groups
    const driverRankings = {};
    groups.forEach(g => {
      const dids = safeAll('SELECT driver_id FROM fuel_driver_group_map WHERE group_id = ? AND company_id = ?', [g.id, company.id]).map(r => r.driver_id);
      if (dids.length === 0) return;
      var didPh = dids.map(() => '?').join(',');
      driverRankings[g.name] = safeAll("SELECT d.name, SUM(m.miles) as miles, SUM(m.gallons) as gallons, CASE WHEN SUM(m.gallons) > 0 THEN ROUND(SUM(m.miles)/SUM(m.gallons), 2) ELSE 0 END as mpg FROM fuel_measurements_daily m JOIN company_users d ON m.driver_id = d.id WHERE m.company_id = ? AND m.driver_id IN (" + didPh + ") AND m.miles > 0 AND m.date >= date('now', '-30 days') GROUP BY m.driver_id ORDER BY mpg DESC", [company.id, ...dids]);
    });

    // Data freshness
    const integrations = safeAll('SELECT id, provider, label, last_sync_at, last_error, status FROM fuel_integrations WHERE company_id = ?', [company.id]);
    const staleDrivers = safeAll("SELECT d.name, MAX(m.date) as last_date, CAST(julianday('now') - julianday(MAX(m.date)) AS INTEGER) as days_stale FROM company_users d LEFT JOIN fuel_measurements_daily m ON m.driver_id = d.id AND m.company_id = d.company_id WHERE d.company_id = ? AND d.is_active = 1 AND d.id IN (SELECT driver_id FROM fuel_driver_group_map WHERE company_id = ?) GROUP BY d.id HAVING days_stale > 3 OR last_date IS NULL ORDER BY days_stale DESC", [company.id, company.id]);

    // Ceiling log
    const ceilingLog = safeAll('SELECT cl.*, g.name as group_name FROM fuel_ceiling_log cl LEFT JOIN fuel_groups g ON cl.group_id = g.id WHERE cl.company_id = ? ORDER BY cl.triggered_at DESC LIMIT 10', [company.id]);

    res.render('admin/fuel-reports', { user: req.session.user, company, tab, fleetTrend, groupTrends, driverRankings, groups, integrations, staleDrivers, ceilingLog, settings: getSettings(), page: 'companies' });
  });

  // === BASELINES ===
  router.get('/companies/:cid/fuel/baselines-view', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.cid);
    if (!company) return res.redirect('/admin/companies');
    const config = safeGet('SELECT * FROM fuel_config WHERE company_id = ?', [company.id]) || {};
    const groups = safeAll('SELECT * FROM fuel_groups WHERE company_id = ? AND is_active = 1 ORDER BY name', [company.id]);
    const snapshots = safeAll('SELECT s.*, g.name as group_name FROM fuel_baseline_snapshots s LEFT JOIN fuel_groups g ON s.group_id = g.id WHERE s.company_id = ? AND s.is_current = 1 ORDER BY g.name', [company.id]);
    const allSnapshots = safeAll('SELECT s.*, g.name as group_name FROM fuel_baseline_snapshots s LEFT JOIN fuel_groups g ON s.group_id = g.id WHERE s.company_id = ? ORDER BY s.computed_at DESC LIMIT 50', [company.id]);
    res.render('admin/fuel-baselines', { user: req.session.user, company, config, groups, snapshots, allSnapshots, settings: getSettings(), page: 'companies' });
  });

  router.post('/companies/:cid/fuel/baselines/compute', (req, res) => {
    const { group_id } = req.body;
    const config = safeGet('SELECT * FROM fuel_config WHERE company_id = ?', [req.params.cid]) || {};
    const windowDays = config.baseline_window_days || 90;
    const { computeGroupBaseline, computeAllBaselines } = require('../lib/fuel-baseline');
    const who = req.session.user.full_name || req.session.user.username;

    if (group_id && group_id !== 'all') {
      const result = computeGroupBaseline(db, parseInt(req.params.cid), parseInt(group_id), windowDays, who);
      auditLog(req.params.cid, 'baseline_computed', 'Group #' + group_id + ': ' + (result.ok ? result.baseline_mpg + ' MPG (' + result.method + ')' : result.error), req);
    } else {
      const results = computeAllBaselines(db, parseInt(req.params.cid), windowDays, who);
      const summary = results.map(r => r.group + ': ' + (r.ok ? r.baseline_mpg + ' MPG' : r.error)).join('; ');
      auditLog(req.params.cid, 'baselines_computed_all', summary, req);
    }
    res.redirect('/admin/companies/' + req.params.cid + '/fuel/baselines-view');
  });

  // === TARGETS ===
  router.get('/companies/:cid/fuel/targets', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.cid);
    if (!company) return res.redirect('/admin/companies');
    const groups = safeAll('SELECT * FROM fuel_groups WHERE company_id = ? AND is_active = 1 ORDER BY name', [company.id]);
    const policies = safeAll('SELECT p.*, g.name as group_name FROM fuel_target_policies p LEFT JOIN fuel_groups g ON p.group_id = g.id WHERE p.company_id = ? ORDER BY p.is_active DESC, g.name, p.effective_from DESC', [company.id]);
    const overrides = safeAll('SELECT o.*, d.name as driver_name FROM fuel_target_overrides o LEFT JOIN company_users d ON o.driver_id = d.id WHERE o.company_id = ? ORDER BY o.is_active DESC, d.name, o.effective_from DESC', [company.id]);
    const drivers = safeAll("SELECT id, name FROM company_users WHERE company_id = ? AND is_active = 1 ORDER BY name", [company.id]);
    res.render('admin/fuel-targets', { user: req.session.user, company, groups, policies, overrides, drivers, settings: getSettings(), page: 'companies' });
  });

  router.post('/companies/:cid/fuel/targets/policy', (req, res) => {
    const b = req.body;
    try {
      db.prepare('INSERT INTO fuel_target_policies (company_id, group_id, target_mpg, kpi_bonus_usd, penalty_usd, effective_from, effective_to, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?)').run(
        req.params.cid, b.group_id, parseFloat(b.target_mpg), parseFloat(b.kpi_bonus_usd)||0, parseFloat(b.penalty_usd)||0, b.effective_from, b.effective_to||null, b.notes||null, req.session.user.full_name||'admin'
      );
      const g = safeGet('SELECT name FROM fuel_groups WHERE id = ?', [b.group_id]);
      auditLog(req.params.cid, 'target_policy_created', (g?g.name:'?') + ': ' + b.target_mpg + ' MPG, bonus $' + (b.kpi_bonus_usd||0), req);
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/fuel/targets');
  });

  router.post('/companies/:cid/fuel/targets/policy/:pid/deactivate', (req, res) => {
    try { db.prepare('UPDATE fuel_target_policies SET is_active = 0 WHERE id = ? AND company_id = ?').run(req.params.pid, req.params.cid); } catch(e) {}
    auditLog(req.params.cid, 'target_policy_deactivated', 'Policy #' + req.params.pid, req);
    res.redirect('/admin/companies/' + req.params.cid + '/fuel/targets');
  });

  router.post('/companies/:cid/fuel/targets/override', (req, res) => {
    const b = req.body;
    try {
      db.prepare('INSERT INTO fuel_target_overrides (company_id, driver_id, target_mpg, kpi_bonus_usd, penalty_usd, effective_from, effective_to, reason, created_by) VALUES (?,?,?,?,?,?,?,?,?)').run(
        req.params.cid, b.driver_id, parseFloat(b.target_mpg), parseFloat(b.kpi_bonus_usd)||0, parseFloat(b.penalty_usd)||0, b.effective_from, b.effective_to||null, b.reason||null, req.session.user.full_name||'admin'
      );
      const d = safeGet('SELECT name FROM company_users WHERE id = ?', [b.driver_id]);
      auditLog(req.params.cid, 'target_override_created', (d?d.name:'?') + ': ' + b.target_mpg + ' MPG', req);
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/fuel/targets');
  });

  router.post('/companies/:cid/fuel/targets/override/:oid/deactivate', (req, res) => {
    try { db.prepare('UPDATE fuel_target_overrides SET is_active = 0 WHERE id = ? AND company_id = ?').run(req.params.oid, req.params.cid); } catch(e) {}
    auditLog(req.params.cid, 'target_override_deactivated', 'Override #' + req.params.oid, req);
    res.redirect('/admin/companies/' + req.params.cid + '/fuel/targets');
  });

  // === INTEGRATIONS ===
  router.get('/companies/:cid/fuel/integrations', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.cid);
    if (!company) return res.redirect('/admin/companies');
    const integrations = safeAll('SELECT * FROM fuel_integrations WHERE company_id = ? ORDER BY created_at DESC', [company.id]);
    // Get asset counts per integration
    integrations.forEach(intg => {
      intg.assetCount = (safeGet('SELECT COUNT(*) as c FROM fuel_provider_asset_map WHERE integration_id = ?', [intg.id]) || {}).c || 0;
      intg.mappedCount = (safeGet('SELECT COUNT(*) as c FROM fuel_provider_asset_map WHERE integration_id = ? AND internal_vehicle_id IS NOT NULL', [intg.id]) || {}).c || 0;
      intg.measurementCount = (safeGet('SELECT COUNT(*) as c FROM fuel_measurements_daily WHERE integration_id = ?', [intg.id]) || {}).c || 0;
    });
    const unmapped = safeAll('SELECT m.*, fi.provider FROM fuel_provider_asset_map m JOIN fuel_integrations fi ON m.integration_id = fi.id WHERE m.company_id = ? AND m.internal_vehicle_id IS NULL', [company.id]);
    const vehicles = safeAll("SELECT id, unit_number, vin FROM fleet_vehicles WHERE company_id = ? ORDER BY unit_number", [company.id]);
    res.render('admin/fuel-integrations', { user: req.session.user, company, integrations, unmapped, vehicles, settings: getSettings(), page: 'companies' });
  });

  // Add integration
  router.post('/companies/:cid/fuel/integrations', (req, res) => {
    const { provider, label, api_key, base_url } = req.body;
    if (!api_key) return res.redirect('/admin/companies/' + req.params.cid + '/fuel/integrations');
    const { encrypt } = require('../lib/crypto');
    const encrypted = encrypt(JSON.stringify({ token: api_key }));
    try {
      db.prepare('INSERT INTO fuel_integrations (company_id, provider, label, encrypted_secrets, base_url, status) VALUES (?,?,?,?,?,?)').run(
        req.params.cid, provider || 'samsara', label || null, encrypted, base_url || null, 'pending'
      );
      auditLog(req.params.cid, 'integration_added', provider + ' integration added', req);
    } catch(e) { console.error('Fuel integration add:', e.message); }
    res.redirect('/admin/companies/' + req.params.cid + '/fuel/integrations');
  });

  // Test connection
  router.post('/companies/:cid/fuel/integrations/:iid/test', async (req, res) => {
    const intg = safeGet('SELECT * FROM fuel_integrations WHERE id = ? AND company_id = ?', [req.params.iid, req.params.cid]);
    if (!intg) return res.redirect('/admin/companies/' + req.params.cid + '/fuel/integrations');
    try {
      const { getProvider } = require('../lib/fuel-providers');
      const provider = getProvider(db, intg);
      const result = await provider.testConnection();
      if (result.ok) {
        db.prepare("UPDATE fuel_integrations SET status = 'connected', last_error = NULL WHERE id = ?").run(intg.id);
        auditLog(req.params.cid, 'connection_test', 'Success: ' + result.message + (result.vehicleCount ? ' (' + result.vehicleCount + ' vehicles)' : ''), req);
      } else {
        db.prepare("UPDATE fuel_integrations SET status = 'error', last_error = ? WHERE id = ?").run(result.message, intg.id);
        auditLog(req.params.cid, 'connection_test', 'Failed: ' + result.message, req);
      }
    } catch(e) {
      db.prepare("UPDATE fuel_integrations SET status = 'error', last_error = ? WHERE id = ?").run(e.message, intg.id);
    }
    res.redirect('/admin/companies/' + req.params.cid + '/fuel/integrations');
  });

  // Sync assets
  router.post('/companies/:cid/fuel/integrations/:iid/sync-assets', async (req, res) => {
    const intg = safeGet('SELECT * FROM fuel_integrations WHERE id = ? AND company_id = ?', [req.params.iid, req.params.cid]);
    if (!intg) return res.redirect('/admin/companies/' + req.params.cid + '/fuel/integrations');
    try {
      const { getProvider } = require('../lib/fuel-providers');
      const provider = getProvider(db, intg);
      const result = await provider.syncAssets();
      auditLog(req.params.cid, 'assets_synced', 'Synced: ' + (result.synced||0) + ', Mapped: ' + (result.mapped||0), req);
    } catch(e) { console.error('Asset sync error:', e.message); }
    res.redirect('/admin/companies/' + req.params.cid + '/fuel/integrations');
  });

  // Backfill metrics
  router.post('/companies/:cid/fuel/integrations/:iid/backfill', async (req, res) => {
    const intg = safeGet('SELECT * FROM fuel_integrations WHERE id = ? AND company_id = ?', [req.params.iid, req.params.cid]);
    if (!intg) return res.redirect('/admin/companies/' + req.params.cid + '/fuel/integrations');
    const days = parseInt(req.body.days) || 60;
    const dateTo = new Date().toISOString().slice(0,10);
    const dateFrom = new Date(Date.now() - days * 86400000).toISOString().slice(0,10);
    let attempts = 0, lastError = null, totalRecords = 0;
    const maxRetries = 3;
    while (attempts < maxRetries) {
      try {
        const { getProvider } = require('../lib/fuel-providers');
        const provider = getProvider(db, intg);
        const result = await provider.fetchDailyMetrics(dateFrom, dateTo);
        if (result.ok) {
          totalRecords = result.records || 0;
          lastError = null;
          break;
        } else {
          lastError = result.error;
          attempts++;
          if (attempts < maxRetries) await new Promise(r => setTimeout(r, 2000 * attempts));
        }
      } catch(e) {
        lastError = e.message;
        attempts++;
        if (attempts < maxRetries) await new Promise(r => setTimeout(r, 2000 * attempts));
      }
    }
    auditLog(req.params.cid, 'metrics_backfill', days + ' days: ' + totalRecords + ' records' + (lastError ? ' (error after ' + attempts + ' attempts: ' + lastError + ')' : '') + (attempts > 1 ? ' [' + attempts + ' attempts]' : ''), req);
    if (lastError) {
      try { db.prepare("UPDATE fuel_integrations SET last_error = ? WHERE id = ?").run('Backfill failed after ' + attempts + ' attempts: ' + lastError, intg.id); } catch(e2) {}
    }
    res.redirect('/admin/companies/' + req.params.cid + '/fuel/integrations');
  });

  // Manual asset mapping
  router.post('/companies/:cid/fuel/integrations/map-asset', (req, res) => {
    const { map_id, internal_vehicle_id } = req.body;
    try {
      db.prepare('UPDATE fuel_provider_asset_map SET internal_vehicle_id = ?, mapped_by = ? WHERE id = ? AND company_id = ?').run(
        internal_vehicle_id || null, 'manual', map_id, req.params.cid
      );
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/fuel/integrations');
  });

  // Delete integration
  router.post('/companies/:cid/fuel/integrations/:iid/delete', (req, res) => {
    try {
      db.prepare('DELETE FROM fuel_measurements_daily WHERE integration_id = ? AND company_id = ?').run(req.params.iid, req.params.cid);
      db.prepare('DELETE FROM fuel_provider_asset_map WHERE integration_id = ? AND company_id = ?').run(req.params.iid, req.params.cid);
      db.prepare('DELETE FROM fuel_integrations WHERE id = ? AND company_id = ?').run(req.params.iid, req.params.cid);
      auditLog(req.params.cid, 'integration_deleted', 'Integration removed', req);
    } catch(e) {}
    res.redirect('/admin/companies/' + req.params.cid + '/fuel/integrations');
  });

  // VIN decode page (for individual lookups)
  router.get('/companies/:cid/fuel/vin', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.cid);
    if (!company) return res.redirect('/admin/companies');
    const vehicles = safeAll("SELECT id, unit_number, make, model, year, vin FROM fleet_vehicles WHERE company_id = ? ORDER BY unit_number", [company.id]);
    const recentDecodes = safeAll('SELECT * FROM fuel_vin_cache ORDER BY decoded_at DESC LIMIT 20');
    res.render('admin/fuel-vin', { user: req.session.user, company, vehicles, recentDecodes, settings: getSettings(), page: 'companies' });
  });

  return router;
};
