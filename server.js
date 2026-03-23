require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const { initDB } = require('./db/schema');
const { sendMonitorAlert } = require('./lib/alerts');

const app = express();
const PORT = process.env.PORT || 3000;

const db = initDB();

// Run migrations (SQLite only — PostgreSQL uses postgres-schema.sql)
if (!db._type || db._type !== 'postgresql') {
  const { runMigrations } = require('./db/migrate');
  runMigrations(db);
}

// Load integration settings from DB into env (DB overrides .env if set)
try {
  const dbSettings = db.prepare('SELECT key, value FROM settings').all();
  const envMap = { gmail_user: 'GMAIL_USER', gmail_app_password: 'GMAIL_APP_PASSWORD', alert_emails: 'ALERT_EMAILS', twilio_sid: 'TWILIO_ACCOUNT_SID', twilio_token: 'TWILIO_AUTH_TOKEN', twilio_from: 'TWILIO_FROM_NUMBER', alert_phones: 'ALERT_PHONES' };
  dbSettings.forEach(r => { if (envMap[r.key] && r.value) process.env[envMap[r.key]] = r.value; });
} catch(e) {}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'itms-secret-2026-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Global template helpers — available in all EJS views
app.locals.fmt = {
  date: function(v) { if (!v) return '—'; var s = String(v); return s.includes('T') ? s.split('T')[0] : s.substring(0,10); },
  datetime: function(v) { if (!v) return '—'; var s = String(v); return s.includes('T') ? s.replace('T',' ').substring(0,16) : s.substring(0,16); },
  money: function(v) { return '$' + (Number(v) || 0).toFixed(2); },
  num: function(v) { return (Number(v) || 0).toLocaleString(); },
  pct: function(v, d) { return (Number(v) || 0).toFixed(d || 1) + '%'; }
};

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

// Public page
app.get('/public/services', (req, res) => {
  const services = db.prepare('SELECT * FROM services WHERE is_public = 1 AND is_active = 1 ORDER BY name').all();
  const settings = {};
  db.prepare('SELECT key, value FROM settings').all().forEach(r => { settings[r.key] = r.value; });
  res.render('public-services', { services, settings });
});

// === WEBHOOK ENDPOINTS ===
// Global webhook (backward compatible)
app.post('/api/webhook/alert', (req, res) => {
  try {
    const { title, description, severity, source } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    db.prepare('INSERT INTO alerts (title, description, severity, source, status) VALUES (?,?,?,?,?)').run(
      title, description || '', severity || 'warning', source || 'webhook', 'open'
    );
    console.log('  🔔 Webhook alert received:', title);
    res.json({ ok: true, message: 'Alert created' });
  } catch(e) {
    console.error('Webhook error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Per-company webhook: /api/webhook/company/:key
app.post('/api/webhook/company/:key', (req, res) => {
  try {
    // Find company by webhook key
    const setting = db.prepare('SELECT * FROM settings WHERE key = ?').get('webhook_keys');
    let keyMap = {};
    try { keyMap = JSON.parse((setting || {}).value || '{}'); } catch(e) {}
    const companyId = keyMap[req.params.key];
    if (!companyId) return res.status(401).json({ error: 'Invalid webhook key' });

    const company = db.prepare('SELECT id, name FROM companies WHERE id = ?').get(companyId);
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const { title, description, severity, source } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    // Find a monitor for this company to link the alert (optional)
    const monitor = db.prepare('SELECT id FROM equipment_monitors WHERE company_id = ? LIMIT 1').get(companyId);

    db.prepare('INSERT INTO alerts (monitor_id, title, description, severity, source, status) VALUES (?,?,?,?,?,?)').run(
      monitor ? monitor.id : null,
      '[' + company.name + '] ' + title,
      description || '', severity || 'warning', source || 'webhook-' + company.name, 'open'
    );
    console.log('  🔔 Company webhook (' + company.name + '):', title);
    res.json({ ok: true, company: company.name, message: 'Alert created' });
  } catch(e) {
    console.error('Company webhook error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Public invoice print view (no login required — shared via link)
app.get('/invoice/:invNum/print', (req, res) => {
  try {
    const invoice = db.prepare('SELECT i.*, c.name as company_name, c.address, c.city, c.state, c.zip, c.logo FROM invoices i LEFT JOIN companies c ON i.company_id = c.id WHERE i.invoice_number = ?').get(req.params.invNum);
    if (!invoice) return res.status(404).send('Invoice not found');
    const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(invoice.id);
    const settings = {};
    db.prepare('SELECT key, value FROM settings').all().forEach(r => { settings[r.key] = r.value; });
    res.render('invoice-print', { invoice, items, settings });
  } catch(e) { res.status(500).send('Error loading invoice'); }
});

// Self-signup
app.post('/signup', (req, res) => {
  const { company_name, full_name, email, phone, password } = req.body;
  if (!company_name || !full_name || !email || !password || password.length < 4) {
    return res.redirect('/#signup');
  }
  try {
    const bcrypt = require('bcryptjs');
    const companyResult = db.prepare('INSERT INTO companies (name, status) VALUES (?, ?)').run(company_name.trim(), 'active');
    const companyId = companyResult.lastInsertRowid;
    try { db.prepare('INSERT INTO company_modules (company_id) VALUES (?)').run(companyId); } catch(e) {}
    const hash = bcrypt.hashSync(password, 10);
    const username = email.split('@')[0].toLowerCase().replace(/[^a-z0-9.]/g, '');
    db.prepare('INSERT INTO users (username, password, role, company_id, full_name, email, phone, is_active) VALUES (?,?,?,?,?,?,?,1)').run(username, hash, 'client', companyId, full_name.trim(), email.trim(), phone||null);
    try { db.prepare('INSERT INTO company_users (company_id, name, email, phone, is_active) VALUES (?,?,?,?,1)').run(companyId, full_name.trim(), email.trim(), phone||null); } catch(e) {}
    try { db.prepare("INSERT INTO tasks (title, description, priority, status, assigned_to, created_by) VALUES (?,?,?,?,?,?)").run('🆕 New Signup: ' + company_name, 'Company: ' + company_name + '\nContact: ' + full_name + '\nEmail: ' + email + '\nUsername: ' + username, 'high', 'todo', 'admin', 'website'); } catch(e) {}
    const services = db.prepare('SELECT * FROM services WHERE show_on_landing = 1 AND is_active = 1 ORDER BY base_price DESC').all();
    const settings = {};
    try { db.prepare('SELECT key, value FROM settings').all().forEach(r => { settings[r.key] = r.value; }); } catch(e) {}
    res.render('landing', { services, settings, user: null, signedUp: true, newUsername: username });
  } catch(e) {
    console.error('Signup error:', e.message);
    res.redirect('/#signup');
  }
});

// Contact form → creates a task
app.post('/contact', (req, res) => {
  try {
    const { name, company, email, phone, message } = req.body;
    const title = '📬 Website Inquiry from ' + (name || 'Unknown');
    const desc = [
      'Name: ' + (name || '—'),
      'Company: ' + (company || '—'),
      'Email: ' + (email || '—'),
      'Phone: ' + (phone || '—'),
      '',
      'Message:',
      message || '—'
    ].join('\n');
    db.prepare("INSERT INTO tasks (title, description, priority, status, assigned_to, created_by) VALUES (?,?,?,?,?,?)").run(
      title, desc, 'medium', 'todo', 'admin', 'website'
    );
  } catch(e) { console.error('Contact form error:', e.message); }
  // Re-render landing with success
  const services = db.prepare('SELECT * FROM services WHERE show_on_landing = 1 AND is_active = 1 ORDER BY base_price DESC').all();
  const settings = {};
  try { db.prepare('SELECT key, value FROM settings').all().forEach(r => { settings[r.key] = r.value; }); } catch(e) {}
  res.render('landing', { services, settings, user: null, submitted: true });
});

// Motive webhook endpoint (validates api_key query param against stored integrations)
app.post('/webhooks/motive', (req, res) => {
  try {
    const payload = req.body;
    const apiKey = req.query.key || req.headers['x-webhook-key'] || '';
    // Validate webhook key exists in fuel_integrations
    let companyId = null;
    if (apiKey) {
      try {
        const intg = db.prepare("SELECT company_id FROM fuel_integrations WHERE provider = 'motive' AND is_active = 1").get();
        if (intg) companyId = intg.company_id;
      } catch(e) {}
    }
    console.log('  📥 Motive webhook:', payload.event_type || 'unknown', companyId ? '(company:' + companyId + ')' : '(unmatched)');
    // Store raw payload for audit
    try {
      db.prepare('INSERT INTO fuel_audit_log (company_id, action, details, created_by) VALUES (?,?,?,?)').run(
        companyId, 'motive_webhook', JSON.stringify(payload).substring(0, 2000), 'webhook'
      );
    } catch(e2) {}
    res.json({ ok: true, received: true });
  } catch(e) {
    console.error('Motive webhook error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.use('/', require('./routes/auth')(db));
app.use('/admin', require('./routes/admin')(db));
app.use('/client', require('./routes/client')(db));
app.use('/chat', require('./routes/chat')(db));
app.use('/admin', require('./routes/fuel')(db));

app.get('/', (req, res) => {
  if (req.session.user) {
    if (req.session.user.role === 'admin') return res.redirect('/admin');
    return res.redirect('/client');
  }
  const services = db.prepare('SELECT * FROM services WHERE show_on_landing = 1 AND is_active = 1 ORDER BY base_price DESC').all();
  const settings = {};
  try { db.prepare('SELECT key, value FROM settings').all().forEach(r => { settings[r.key] = r.value; }); } catch(e) {}
  res.render('landing', { services, settings, user: null });
});

app.use((req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.status(404).send('<h2>Page not found</h2><p><a href="/">Go home</a></p>');
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('  ❌ Unhandled error:', err.message, err.stack ? err.stack.split('\n').slice(0,3).join(' ') : '');
  res.status(500).send('<h2>Something went wrong</h2><p>The error has been logged. <a href="/">Go home</a></p>');
});

// ===== MONITORING CRON — auto-check on intervals =====
async function checkMonitor(mon) {
  let status = 'down', responseMs = 0, error = null;
  const start = Date.now();
  const target = (mon.target || '').trim();
  if (!target) return { status: 'down', responseMs: 0, error: 'No target' };

  try {
    if (mon.check_type === 'http' || mon.check_type === 'https' || target.startsWith('http')) {
      const url = target.startsWith('http') ? target : (mon.check_type === 'https' ? 'https://' : 'http://') + target;
      const mod = url.startsWith('https') ? https : http;
      await new Promise((resolve) => {
        const r = mod.get(url, { timeout: 8000, rejectUnauthorized: false }, (resp) => {
          responseMs = Date.now() - start;
          status = (resp.statusCode >= 200 && resp.statusCode < 500) ? 'up' : 'down';
          if (status === 'down') error = 'HTTP ' + resp.statusCode;
          resp.resume();
          resolve();
        });
        r.on('error', (e) => { responseMs = Date.now() - start; error = e.message; resolve(); });
        r.on('timeout', () => { r.destroy(); responseMs = Date.now() - start; error = 'Timeout'; resolve(); });
      });
    } else {
      const parts = target.split(':');
      const host = parts[0];
      const port = parseInt(parts[1]) || (mon.check_type === 'port' ? 22 : 80);
      await new Promise((resolve) => {
        const sock = new net.Socket();
        sock.setTimeout(5000);
        sock.on('connect', () => { responseMs = Date.now() - start; status = 'up'; sock.destroy(); resolve(); });
        sock.on('error', (e) => { responseMs = Date.now() - start; error = e.message; resolve(); });
        sock.on('timeout', () => { sock.destroy(); responseMs = Date.now() - start; error = 'Timeout'; resolve(); });
        sock.connect(port, host);
      });
    }
  } catch (e) { error = e.message; responseMs = Date.now() - start; }
  return { status, responseMs, error };
}

function saveResult(monId, result, mon) {
  try {
    db.prepare("UPDATE equipment_monitors SET last_check = datetime('now'), last_status = ?, last_response_ms = ? WHERE id = ?").run(result.status, result.responseMs, monId);
    db.prepare('INSERT INTO monitor_logs (monitor_id, status, response_ms, error) VALUES (?,?,?,?)').run(monId, result.status, result.responseMs, result.error);
    const total = db.prepare('SELECT COUNT(*) as c FROM monitor_logs WHERE monitor_id = ?').get(monId);
    const upCount = db.prepare("SELECT COUNT(*) as c FROM monitor_logs WHERE monitor_id = ? AND status = 'up'").get(monId);
    const uptimePct = total.c > 0 ? (upCount.c / total.c * 100) : 0;
    db.prepare('UPDATE equipment_monitors SET uptime_pct = ? WHERE id = ?').run(uptimePct, monId);
    // Create alert record when monitor goes DOWN
    if (result.status === 'down' && mon && mon.last_status !== 'down') {
      try {
        db.prepare('INSERT INTO alerts (monitor_id, source, severity, title, description, status) VALUES (?,?,?,?,?,?)').run(
          monId, 'monitor', 'critical',
          (mon.name || 'Monitor') + ' is DOWN',
          'Target: ' + (mon.target || '?') + '. Error: ' + (result.error || 'Unknown') + '. Response: ' + result.responseMs + 'ms',
          'open'
        );
      } catch(e2) {}
    }
    // Auto-resolve when monitor comes back UP
    if (result.status === 'up' && mon && mon.last_status === 'down') {
      try {
        db.prepare("UPDATE alerts SET resolved_at = datetime('now'), resolved_by = 'auto', resolution = 'Monitor recovered automatically', status = 'resolved' WHERE monitor_id = ? AND resolved_at IS NULL").run(monId);
      } catch(e2) {}
    }
  } catch(e) { console.error('  Save error:', e.message); }
}

async function runMonitoringCycle() {
  try {
    const monitors = db.prepare('SELECT * FROM equipment_monitors WHERE is_active = 1').all();
    if (monitors.length === 0) return;

    const now = new Date();
    let checked = 0;

    for (const mon of monitors) {
      // Check if enough time has passed since last check
      const interval = (mon.interval_min || 5) * 60 * 1000; // convert to ms
      const lastCheck = mon.last_check ? new Date(mon.last_check + 'Z').getTime() : 0;
      const elapsed = now.getTime() - lastCheck;

      if (elapsed >= interval) {
        const result = await checkMonitor(mon);
        saveResult(mon.id, result, mon);
        checked++;

        // Log status changes and send alerts
        if (mon.last_status !== result.status && mon.last_status !== 'unknown') {
          const arrow = result.status === 'up' ? '✅' : '🔴';
          console.log(`  ${arrow} ${mon.name} (${mon.target}): ${mon.last_status || 'unknown'} → ${result.status} [${result.responseMs}ms]`);
          // Send alert on DOWN or RECOVERY
          try { await sendMonitorAlert(mon, result); } catch(e) { console.error('  Alert error:', e.message); }
        }
      }
    }

    if (checked > 0) {
      console.log(`  📡 Checked ${checked} monitor(s) at ${now.toLocaleTimeString()}`);
    }
  } catch(e) {
    console.error('  Monitor cycle error:', e.message);
  }
}

// Start the server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🖥️  IT Services Manager running at http://localhost:${PORT}\n`);
  console.log(`  Admin login: admin / admin`);
  console.log(`  Public services: http://localhost:${PORT}/public/services`);
  console.log(`  📡 Monitoring cron: running every 60 seconds\n`);

  // Run first check 10 seconds after startup
  setTimeout(runMonitoringCycle, 10000);

  // Then run every 60 seconds — each monitor's individual interval is checked inside
  setInterval(runMonitoringCycle, 60 * 1000);
});
