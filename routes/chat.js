const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requireLogin } = require('../middleware/auth');

const uploadDir = path.join(__dirname, '..', 'uploads', 'chat');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const chatUpload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });

module.exports = function(db) {
  router.use(requireLogin);

  const safeAll = (sql, params) => { try { return params ? db.prepare(sql).all(...(Array.isArray(params)?params:[params])) : db.prepare(sql).all(); } catch(e) { return []; } };
  const safeGet = (sql, params) => { try { return params ? db.prepare(sql).get(...(Array.isArray(params)?params:[params])) : db.prepare(sql).get(); } catch(e) { return null; } };

  // Helper: get current user info for chat
  function chatUser(req) {
    const u = req.session.user;
    return {
      type: u.role === 'admin' ? 'admin' : 'client',
      id: u.id,
      name: u.full_name || u.username,
      companyId: u.company_id || null,
      isAdmin: u.role === 'admin'
    };
  }

  // Helper: check if user can access channel
  function canAccess(cu, channel) {
    if (cu.isAdmin) return true; // admin sees everything
    if (!channel) return false;
    // client can only access channels in their company
    if (channel.company_id && channel.company_id === cu.companyId) return true;
    // or channels they're a member of
    const member = safeGet('SELECT id FROM chat_members WHERE channel_id = ? AND user_name = ?', [channel.id, cu.name]);
    return !!member;
  }

  // === LIST CHANNELS ===
  router.get('/channels', (req, res) => {
    const cu = chatUser(req);
    let channels;
    if (cu.isAdmin) {
      // Admin sees all channels
      channels = safeAll(`
        SELECT ch.*, c.name as company_name,
          (SELECT COUNT(*) FROM chat_messages WHERE channel_id = ch.id) as msg_count,
          (SELECT message FROM chat_messages WHERE channel_id = ch.id ORDER BY id DESC LIMIT 1) as last_message,
          (SELECT sender_name FROM chat_messages WHERE channel_id = ch.id ORDER BY id DESC LIMIT 1) as last_sender,
          (SELECT created_at FROM chat_messages WHERE channel_id = ch.id ORDER BY id DESC LIMIT 1) as last_msg_time
        FROM chat_channels ch
        LEFT JOIN companies c ON ch.company_id = c.id
        ORDER BY last_msg_time DESC NULLS LAST, ch.created_at DESC
      `);
    } else {
      // Client sees channels in their company or where they are a member
      channels = safeAll(`
        SELECT ch.*, c.name as company_name,
          (SELECT COUNT(*) FROM chat_messages WHERE channel_id = ch.id) as msg_count,
          (SELECT message FROM chat_messages WHERE channel_id = ch.id ORDER BY id DESC LIMIT 1) as last_message,
          (SELECT sender_name FROM chat_messages WHERE channel_id = ch.id ORDER BY id DESC LIMIT 1) as last_sender,
          (SELECT created_at FROM chat_messages WHERE channel_id = ch.id ORDER BY id DESC LIMIT 1) as last_msg_time
        FROM chat_channels ch
        LEFT JOIN companies c ON ch.company_id = c.id
        WHERE ch.company_id = ?
        ORDER BY last_msg_time DESC NULLS LAST, ch.created_at DESC
      `, [cu.companyId]);
    }

    // Add unread counts
    channels.forEach(ch => {
      const mem = safeGet('SELECT last_read_at FROM chat_members WHERE channel_id = ? AND user_name = ?', [ch.id, cu.name]);
      if (mem && mem.last_read_at) {
        const unread = safeGet('SELECT COUNT(*) as c FROM chat_messages WHERE channel_id = ? AND created_at > ? AND sender_name != ?', [ch.id, mem.last_read_at, cu.name]);
        ch.unread = unread ? unread.c : 0;
      } else {
        ch.unread = ch.msg_count || 0;
      }
    });

    res.json(channels);
  });

  // === GET MESSAGES FOR CHANNEL ===
  router.get('/channels/:id/messages', (req, res) => {
    const cu = chatUser(req);
    const channel = safeGet('SELECT * FROM chat_channels WHERE id = ?', [req.params.id]);
    if (!canAccess(cu, channel)) return res.status(403).json({ error: 'Access denied' });

    const after = req.query.after || '2000-01-01';
    const messages = safeAll(
      'SELECT * FROM chat_messages WHERE channel_id = ? AND created_at > ? ORDER BY created_at ASC',
      [req.params.id, after]
    );

    // Mark as read
    const existing = safeGet('SELECT id FROM chat_members WHERE channel_id = ? AND user_name = ?', [req.params.id, cu.name]);
    if (existing) {
      try { db.prepare("UPDATE chat_members SET last_read_at = datetime('now') WHERE id = ?").run(existing.id); } catch(e) {}
    }

    // Get members and channel info
    const members = safeAll('SELECT * FROM chat_members WHERE channel_id = ?', [req.params.id]);
    res.json({ channel, messages, members });
  });

  // === CREATE CHANNEL ===
  router.post('/channels', (req, res) => {
    const cu = chatUser(req);
    const { name, type, company_id, member_names } = req.body;
    if (!name) return res.status(400).json({ error: 'Channel name required' });

    // Determine company_id
    const cid = cu.isAdmin ? (company_id || null) : cu.companyId;

    try {
      const r = db.prepare('INSERT INTO chat_channels (name, type, company_id, created_by) VALUES (?,?,?,?)').run(
        name, type || 'group', cid, cu.name
      );
      const channelId = r.lastInsertRowid;

      // Add creator as member
      db.prepare("INSERT INTO chat_members (channel_id, user_type, user_id, user_name, last_read_at) VALUES (?,?,?,?,datetime('now'))").run(
        channelId, cu.type, cu.id, cu.name
      );

      // Add admin automatically to company channels
      if (!cu.isAdmin && cid) {
        db.prepare("INSERT INTO chat_members (channel_id, user_type, user_id, user_name, last_read_at) VALUES (?,?,?,?,datetime('now'))").run(
          channelId, 'admin', 0, 'Administrator'
        );
      }

      // Add other members
      if (member_names) {
        const names = Array.isArray(member_names) ? member_names : member_names.split(',').map(n => n.trim()).filter(Boolean);
        names.forEach(n => {
          if (n === cu.name) return; // skip creator, already added
          const userInfo = safeGet('SELECT id FROM company_users WHERE name = ? AND company_id = ?', [n, cid]);
          try {
            db.prepare("INSERT INTO chat_members (channel_id, user_type, user_id, user_name, last_read_at) VALUES (?,?,?,?,datetime('now'))").run(
              channelId, 'company_user', userInfo ? userInfo.id : null, n
            );
          } catch(e) {}
        });
      }

      // System message
      db.prepare('INSERT INTO chat_messages (channel_id, sender_type, sender_name, message) VALUES (?,?,?,?)').run(
        channelId, 'system', 'System', cu.name + ' created channel "' + name + '"'
      );

      res.json({ ok: true, channelId });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // === SEND MESSAGE ===
  router.post('/channels/:id/messages', (req, res) => {
    const cu = chatUser(req);
    const channel = safeGet('SELECT * FROM chat_channels WHERE id = ?', [req.params.id]);
    if (!canAccess(cu, channel)) return res.status(403).json({ error: 'Access denied' });

    const { message, attachment, attachment_name, attachment_type } = req.body;
    if ((!message || !message.trim()) && !attachment) return res.status(400).json({ error: 'Message required' });

    try {
      const r = db.prepare('INSERT INTO chat_messages (channel_id, sender_type, sender_id, sender_name, message, attachment, attachment_name, attachment_type) VALUES (?,?,?,?,?,?,?,?)').run(
        req.params.id, cu.type, cu.id, cu.name, (message || '').trim() || (attachment_name || 'file'), attachment || null, attachment_name || null, attachment_type || null
      );

      // Ensure sender is a member
      const isMember = safeGet('SELECT id FROM chat_members WHERE channel_id = ? AND user_name = ?', [req.params.id, cu.name]);
      if (!isMember) {
        db.prepare("INSERT INTO chat_members (channel_id, user_type, user_id, user_name, last_read_at) VALUES (?,?,?,?,datetime('now'))").run(
          req.params.id, cu.type, cu.id, cu.name
        );
      } else {
        db.prepare("UPDATE chat_members SET last_read_at = datetime('now') WHERE id = ?").run(isMember.id);
      }

      res.json({ ok: true, messageId: r.lastInsertRowid });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // === ADD MEMBER ===
  router.post('/channels/:id/members', (req, res) => {
    const cu = chatUser(req);
    const channel = safeGet('SELECT * FROM chat_channels WHERE id = ?', [req.params.id]);
    if (!canAccess(cu, channel)) return res.status(403).json({ error: 'Access denied' });

    const { user_name } = req.body;
    if (!user_name) return res.status(400).json({ error: 'User name required' });

    const exists = safeGet('SELECT id FROM chat_members WHERE channel_id = ? AND user_name = ?', [req.params.id, user_name]);
    if (exists) return res.json({ ok: true, message: 'Already a member' });

    try {
      db.prepare("INSERT INTO chat_members (channel_id, user_type, user_name, last_read_at) VALUES (?,?,?,datetime('now'))").run(
        req.params.id, 'company_user', user_name
      );
      db.prepare('INSERT INTO chat_messages (channel_id, sender_type, sender_name, message) VALUES (?,?,?,?)').run(
        req.params.id, 'system', 'System', cu.name + ' added ' + user_name + ' to the channel'
      );
      res.json({ ok: true });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // === REMOVE MEMBER ===
  router.post('/channels/:id/members/remove', (req, res) => {
    const cu = chatUser(req);
    const channel = safeGet('SELECT * FROM chat_channels WHERE id = ?', [req.params.id]);
    if (!canAccess(cu, channel)) return res.status(403).json({ error: 'Access denied' });

    const { user_name } = req.body;
    try {
      db.prepare('DELETE FROM chat_members WHERE channel_id = ? AND user_name = ?').run(req.params.id, user_name);
      db.prepare('INSERT INTO chat_messages (channel_id, sender_type, sender_name, message) VALUES (?,?,?,?)').run(
        req.params.id, 'system', 'System', user_name + ' was removed from the channel'
      );
      res.json({ ok: true });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // === DELETE CHANNEL (admin only) ===
  router.post('/channels/:id/delete', (req, res) => {
    const cu = chatUser(req);
    if (!cu.isAdmin) return res.status(403).json({ error: 'Admin only' });
    try {
      db.prepare('DELETE FROM chat_messages WHERE channel_id = ?').run(req.params.id);
      db.prepare('DELETE FROM chat_members WHERE channel_id = ?').run(req.params.id);
      db.prepare('DELETE FROM chat_channels WHERE id = ?').run(req.params.id);
      res.json({ ok: true });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // === UNREAD COUNT (for badges) ===
  router.get('/unread', (req, res) => {
    const cu = chatUser(req);
    let total = 0;
    let channels;
    if (cu.isAdmin) {
      channels = safeAll('SELECT id FROM chat_channels');
    } else {
      channels = safeAll('SELECT id FROM chat_channels WHERE company_id = ?', [cu.companyId]);
    }
    channels.forEach(ch => {
      const mem = safeGet('SELECT last_read_at FROM chat_members WHERE channel_id = ? AND user_name = ?', [ch.id, cu.name]);
      if (mem && mem.last_read_at) {
        const u = safeGet('SELECT COUNT(*) as c FROM chat_messages WHERE channel_id = ? AND created_at > ? AND sender_name != ?', [ch.id, mem.last_read_at, cu.name]);
        total += u ? u.c : 0;
      } else {
        const u = safeGet('SELECT COUNT(*) as c FROM chat_messages WHERE channel_id = ? AND sender_name != ?', [ch.id, cu.name]);
        total += u ? u.c : 0;
      }
    });
    res.json({ unread: total });
  });

  // === UPLOAD FILE IN CHAT ===
  router.post('/channels/:id/upload', chatUpload.single('file'), (req, res) => {
    const cu = chatUser(req);
    const channel = safeGet('SELECT * FROM chat_channels WHERE id = ?', [req.params.id]);
    if (!canAccess(cu, channel)) return res.status(403).json({ error: 'Access denied' });
    if (!req.file) return res.status(400).json({ error: 'No file' });

    const fileUrl = '/chat/files/' + req.file.filename;
    const isImage = (req.file.mimetype || '').startsWith('image/');

    try {
      const r = db.prepare('INSERT INTO chat_messages (channel_id, sender_type, sender_id, sender_name, message, attachment, attachment_name, attachment_type) VALUES (?,?,?,?,?,?,?,?)').run(
        req.params.id, cu.type, cu.id, cu.name,
        isImage ? '📷 ' + req.file.originalname : '📎 ' + req.file.originalname,
        fileUrl, req.file.originalname, req.file.mimetype
      );

      const isMember = safeGet('SELECT id FROM chat_members WHERE channel_id = ? AND user_name = ?', [req.params.id, cu.name]);
      if (isMember) {
        db.prepare("UPDATE chat_members SET last_read_at = datetime('now') WHERE id = ?").run(isMember.id);
      }

      res.json({ ok: true, messageId: r.lastInsertRowid, fileUrl, fileName: req.file.originalname, isImage });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Serve chat files
  router.get('/files/:filename', (req, res) => {
    const filePath = path.join(uploadDir, req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
    res.sendFile(filePath);
  });

  // === COMPANY USERS (for member picker) ===
  router.get('/users', (req, res) => {
    const cu = chatUser(req);
    let users;
    if (cu.isAdmin) {
      users = safeAll('SELECT cu.id, cu.name, cu.department, cu.role, cu.company_id, c.name as company_name FROM company_users cu LEFT JOIN companies c ON cu.company_id = c.id WHERE cu.is_active = 1 ORDER BY c.name, cu.name');
    } else {
      users = safeAll('SELECT id, name, department, role, company_id FROM company_users WHERE company_id = ? AND is_active = 1 ORDER BY name', [cu.companyId]);
    }
    // Add admin to the list for client users
    if (!cu.isAdmin) {
      users.unshift({ id: 0, name: 'Administrator', department: 'IT', role: 'Admin', company_id: null });
    }
    res.json(users);
  });

  // === COMPANIES LIST (for channel creation) ===
  router.get('/companies', (req, res) => {
    const cu = chatUser(req);
    if (cu.isAdmin) {
      const companies = safeAll('SELECT id, name FROM companies ORDER BY name');
      res.json(companies);
    } else {
      res.json([]);
    }
  });

  return router;
};
