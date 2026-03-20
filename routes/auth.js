const express = require('express');
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');
const router = express.Router();

module.exports = function(db) {

  const getSettings = () => {
    const s = {};
    try { db.prepare('SELECT key, value FROM settings').all().forEach(r => { s[r.key] = r.value; }); } catch(e) {}
    return s;
  };

  router.get('/login', (req, res) => {
    if (req.session.user) {
      if (req.session.user.role === 'admin' || req.session.user.role === 'company_admin') return res.redirect('/admin');
      return res.redirect('/client');
    }
    res.render('login', { error: null, settings: getSettings() });
  });

  router.post('/login', (req, res) => {
    const { username, password } = req.body;
    const settings = getSettings();

    if (!username || !password) {
      return res.render('login', { error: 'Please enter username and password', settings });
    }

    // Try admin/super-admin first
    const admin = db.prepare('SELECT * FROM users WHERE username = ? AND (role = ? OR role = ?)').get(username, 'admin', 'company_admin');
    if (admin && bcrypt.compareSync(password, admin.password)) {
      // Check 2FA
      if (admin.totp_enabled && admin.totp_secret) {
        req.session.pending2fa = { id: admin.id, username: admin.username, role: admin.role, full_name: admin.full_name, company_id: null, is_super: admin.is_super };
        return res.redirect('/2fa');
      }
      // Get assigned companies for company_admin
      let assignedCompanies = null;
      if (!admin.is_super && admin.role === 'company_admin') {
        assignedCompanies = db.prepare('SELECT company_id FROM admin_companies WHERE user_id = ?').all(admin.id).map(r => r.company_id);
      }
      req.session.user = { id: admin.id, username: admin.username, role: 'admin', full_name: admin.full_name, company_id: null, is_super: admin.is_super || 0, assignedCompanies };
      return res.redirect('/admin');
    }

    // Try client user (auto-detect company)
    const client = db.prepare('SELECT * FROM users WHERE username = ? AND role = ? AND is_active = 1').get(username, 'client');
    if (client && bcrypt.compareSync(password, client.password)) {
      if (!client.company_id) {
        return res.render('login', { error: 'Your account is not linked to a company. Contact your IT admin.', settings });
      }
      // Check 2FA
      if (client.totp_enabled && client.totp_secret) {
        req.session.pending2fa = { id: client.id, username: client.username, role: 'client', full_name: client.full_name, company_id: client.company_id };
        return res.redirect('/2fa');
      }
      req.session.user = { id: client.id, username: client.username, role: 'client', full_name: client.full_name, company_id: client.company_id };
      return res.redirect('/client');
    }

    return res.render('login', { error: 'Invalid username or password', settings });
  });

  // 2FA verification page
  router.get('/2fa', (req, res) => {
    if (!req.session.pending2fa) return res.redirect('/login');
    res.render('2fa-verify', { error: null, username: req.session.pending2fa.username });
  });

  router.post('/2fa', (req, res) => {
    if (!req.session.pending2fa) return res.redirect('/login');
    const { token } = req.body;
    const pending = req.session.pending2fa;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(pending.id);
    if (!user || !user.totp_secret) {
      delete req.session.pending2fa;
      return res.redirect('/login');
    }
    const verified = speakeasy.totp.verify({
      secret: user.totp_secret,
      encoding: 'base32',
      token: token,
      window: 1
    });
    if (!verified) {
      return res.render('2fa-verify', { error: 'Invalid code. Try again.', username: pending.username });
    }
    if (pending.role === 'admin' || pending.role === 'company_admin') {
      let assignedCompanies = null;
      if (!pending.is_super) {
        assignedCompanies = db.prepare('SELECT company_id FROM admin_companies WHERE user_id = ?').all(pending.id).map(r => r.company_id);
      }
      req.session.user = { id: pending.id, username: pending.username, role: 'admin', full_name: pending.full_name, company_id: null, is_super: pending.is_super || 0, assignedCompanies };
    } else {
      req.session.user = { id: pending.id, username: pending.username, role: pending.role, full_name: pending.full_name, company_id: pending.company_id };
    }
    delete req.session.pending2fa;
    if (pending.role === 'admin' || pending.role === 'company_admin') return res.redirect('/admin');
    return res.redirect('/client');
  });

  // === PASSWORD RESET (public pages) ===
  router.get('/reset-password', (req, res) => {
    const { token } = req.query;
    if (!token) return res.redirect('/login');
    const reset = db.prepare('SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0').get(token);
    if (!reset || new Date(reset.expires_at) < new Date()) {
      return res.render('reset-password', { error: 'This reset link has expired or is invalid.', token: null });
    }
    res.render('reset-password', { error: null, token });
  });

  router.post('/reset-password', (req, res) => {
    const { token, new_password } = req.body;
    if (!token || !new_password || new_password.length < 4) {
      return res.render('reset-password', { error: 'Password must be at least 4 characters.', token });
    }
    const reset = db.prepare('SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0').get(token);
    if (!reset || new Date(reset.expires_at) < new Date()) {
      return res.render('reset-password', { error: 'This reset link has expired or is invalid.', token: null });
    }
    try {
      const hash = bcrypt.hashSync(new_password, 10);
      db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, reset.user_id);
      db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(reset.id);
      return res.render('reset-password', { error: null, token: null, success: true });
    } catch(e) {
      return res.render('reset-password', { error: 'Error resetting password. Try again.', token });
    }
  });

  router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
  });

  return router;
};
