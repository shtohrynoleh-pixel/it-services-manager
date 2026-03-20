const express = require('express');
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');
const router = express.Router();

module.exports = function(db) {

  router.get('/login', (req, res) => {
    if (req.session.user) {
      if (req.session.user.role === 'admin') return res.redirect('/admin');
      return res.redirect('/client');
    }
    const companies = db.prepare('SELECT id, name FROM companies WHERE status = ? ORDER BY name').all('active');
    res.render('login', { error: null, companies });
  });

  router.post('/login', (req, res) => {
    const { username, password, login_type, company_id } = req.body;
    const companies = db.prepare('SELECT id, name FROM companies WHERE status = ? ORDER BY name').all('active');

    if (login_type === 'admin') {
      const user = db.prepare('SELECT * FROM users WHERE username = ? AND role = ?').get(username, 'admin');
      if (!user || !bcrypt.compareSync(password, user.password)) {
        return res.render('login', { error: 'Invalid admin credentials', companies });
      }
      // Check if 2FA is enabled
      if (user.totp_enabled && user.totp_secret) {
        // Store pending user in session, redirect to 2FA page
        req.session.pending2fa = { id: user.id, username: user.username, role: 'admin', full_name: user.full_name, company_id: null };
        return res.redirect('/2fa');
      }
      req.session.user = { id: user.id, username: user.username, role: 'admin', full_name: user.full_name, company_id: null };
      return res.redirect('/admin');
    }

    // Client login
    if (!company_id) return res.render('login', { error: 'Please select a company', companies });
    const user = db.prepare('SELECT * FROM users WHERE company_id = ? AND username = ? AND role = ? AND is_active = 1').get(parseInt(company_id), username, 'client');
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.render('login', { error: 'Invalid client credentials', companies });
    }
    // Check if 2FA is enabled for client
    if (user.totp_enabled && user.totp_secret) {
      req.session.pending2fa = { id: user.id, username: user.username, role: 'client', full_name: user.full_name, company_id: user.company_id };
      return res.redirect('/2fa');
    }
    req.session.user = { id: user.id, username: user.username, role: 'client', full_name: user.full_name, company_id: user.company_id };
    return res.redirect('/client');
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
      window: 1 // Allow 1 step tolerance (30 seconds)
    });
    if (!verified) {
      return res.render('2fa-verify', { error: 'Invalid code. Try again.', username: pending.username });
    }
    // 2FA passed — create session
    req.session.user = { id: pending.id, username: pending.username, role: pending.role, full_name: pending.full_name, company_id: pending.company_id };
    delete req.session.pending2fa;
    if (pending.role === 'admin') return res.redirect('/admin');
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
