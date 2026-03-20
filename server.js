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

app.use('/', require('./routes/auth')(db));
app.use('/admin', require('./routes/admin')(db));
app.use('/client', require('./routes/client')(db));
app.use('/chat', require('./routes/chat')(db));

app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role === 'admin') return res.redirect('/admin');
  return res.redirect('/client');
});

app.use((req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.status(404).send('<h2>Page not found</h2><p><a href="/">Go home</a></p>');
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
