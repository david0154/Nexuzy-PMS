const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const { authenticateToken, requireRoles, JWT_SECRET } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');

const STAFF_ROLES = [
  'admin', 'general_manager', 'front_desk', 'cashier', 'captain',
  'waiter', 'kitchen', 'housekeeping', 'maintenance', 'inventory'
];

// POST /api/v1/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }

    const user = await db.get(
      'SELECT id, property_id, username, password_hash, full_name, email, role, is_active FROM users WHERE username = ?',
      [username]
    );

    if (!user || !user.is_active) {
      return res.status(401).json({ success: false, error: 'Invalid credentials or inactive account' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const sid = uuidv4();
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || 'Unknown device';
    await db.run(
      `INSERT INTO lan_sessions
       (id, property_id, user_id, username, device_label, ip_address, user_agent, last_seen_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 1)`,
      [sid, user.property_id, user.id, user.username, userAgent.slice(0, 120), ip, userAgent]
    );

    const payload = {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      property_id: user.property_id,
      sid
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });

    await logAudit({
      propertyId: user.property_id,
      userId: user.id,
      action: 'LOGIN',
      entityType: 'user',
      entityId: user.id,
      details: { username: user.username, role: user.role },
      req
    });

    res.json({
      success: true,
      token,
      sessionId: sid,
      user: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        role: user.role,
        property_id: user.property_id,
        email: user.email
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/auth/logout
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    if (req.sessionId) {
      await db.run(
        'UPDATE lan_sessions SET is_active = 0, revoked_at = CURRENT_TIMESTAMP, revoked_by = ? WHERE id = ?',
        [req.user.id, req.sessionId]
      );
    }
    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'LOGOUT',
      entityType: 'user',
      entityId: req.user.id,
      req
    });
    res.json({ success: true, message: 'Signed out' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/auth/sessions
router.get('/sessions', authenticateToken, async (req, res) => {
  try {
    const isAdmin = ['admin', 'general_manager'].includes(req.user.role);
    const sessions = await db.all(
      `SELECT s.id, s.username, s.device_label, s.ip_address, s.created_at, s.last_seen_at,
              s.is_active, s.revoked_at, u.full_name
       FROM lan_sessions s
       LEFT JOIN users u ON s.user_id = u.id
       WHERE (? = 1 OR s.user_id = ?)
       ORDER BY s.is_active DESC, s.last_seen_at DESC
       LIMIT 100`,
      [isAdmin ? 1 : 0, req.user.id]
    );
    res.json({ success: true, sessions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/auth/sessions/:id/revoke
router.post('/sessions/:id/revoke', authenticateToken, async (req, res) => {
  try {
    const session = await db.get('SELECT * FROM lan_sessions WHERE id = ?', [req.params.id]);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    const isAdmin = ['admin', 'general_manager'].includes(req.user.role);
    if (!isAdmin && session.user_id !== req.user.id) {
      return res.status(403).json({ success: false, error: 'You can only revoke your own sessions' });
    }
    await db.run(
      'UPDATE lan_sessions SET is_active = 0, revoked_at = CURRENT_TIMESTAMP, revoked_by = ? WHERE id = ?',
      [req.user.id, session.id]
    );
    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'REVOKE_SESSION',
      entityType: 'lan_session',
      entityId: session.id,
      details: { username: session.username, ip_address: session.ip_address },
      req
    });
    res.json({ success: true, message: 'Session revoked' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/auth/me
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await db.get(
      'SELECT id, property_id, username, full_name, email, phone, role FROM users WHERE id = ?',
      [req.user.id]
    );
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/auth/users
router.get('/users', authenticateToken, requireRoles('admin', 'general_manager'), async (req, res) => {
  try {
    const users = await db.all(
      'SELECT id, username, full_name, email, phone, role, is_active, created_at FROM users WHERE property_id = ? ORDER BY created_at ASC',
      [req.user.property_id]
    );
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/v1/auth/users/:id — access, role and deactivation changes
router.patch('/users/:id', authenticateToken, requireRoles('admin'), async (req, res) => {
  try {
    const target = await db.get('SELECT * FROM users WHERE id = ? AND property_id = ?', [req.params.id, req.user.property_id]);
    if (!target) return res.status(404).json({ success: false, error: 'User not found' });

    const nextRole = req.body.role || target.role;
    if (!STAFF_ROLES.includes(nextRole)) {
      return res.status(400).json({ success: false, error: 'Invalid staff role' });
    }
    const nextActive = req.body.is_active !== undefined ? Boolean(req.body.is_active) : Boolean(target.is_active);
    const removesAdmin = target.role === 'admin' && target.is_active && (nextRole !== 'admin' || !nextActive);
    if (removesAdmin) {
      const admins = await db.get("SELECT COUNT(*) AS count FROM users WHERE property_id = ? AND role = 'admin' AND is_active = 1", [req.user.property_id]);
      if (Number(admins.count) <= 1) {
        return res.status(400).json({ success: false, error: 'Cannot remove or deactivate the last active administrator' });
      }
    }

    await db.run(
      `UPDATE users SET full_name = COALESCE(?, full_name), email = COALESCE(?, email),
         phone = COALESCE(?, phone), role = ?, is_active = ? WHERE id = ?`,
      [req.body.full_name, req.body.email, req.body.phone, nextRole, nextActive ? 1 : 0, target.id]
    );

    if (!nextActive) {
      await db.run(
        'UPDATE lan_sessions SET is_active = 0, revoked_at = CURRENT_TIMESTAMP, revoked_by = ? WHERE user_id = ? AND is_active = 1',
        [req.user.id, target.id]
      );
    }

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'UPDATE_USER_ACCESS',
      entityType: 'user',
      entityId: target.id,
      beforeValue: { role: target.role, is_active: target.is_active },
      afterValue: { role: nextRole, is_active: nextActive ? 1 : 0 },
      details: { username: target.username },
      req
    });

    res.json({ success: true, message: 'User access updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/auth/users/:id/reset-password
router.post('/users/:id/reset-password', authenticateToken, requireRoles('admin'), async (req, res) => {
  try {
    if (!req.body.password || String(req.body.password).length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }
    const target = await db.get('SELECT id, username FROM users WHERE id = ? AND property_id = ?', [req.params.id, req.user.property_id]);
    if (!target) return res.status(404).json({ success: false, error: 'User not found' });
    const passwordHash = await bcrypt.hash(req.body.password, 10);
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, target.id]);
    await db.run(
      'UPDATE lan_sessions SET is_active = 0, revoked_at = CURRENT_TIMESTAMP, revoked_by = ? WHERE user_id = ? AND is_active = 1',
      [req.user.id, target.id]
    );
    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'RESET_USER_PASSWORD',
      entityType: 'user',
      entityId: target.id,
      details: { username: target.username },
      req
    });
    res.json({ success: true, message: 'Password reset and active sessions revoked' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/auth/users
router.post('/users', authenticateToken, requireRoles('admin'), async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const fullName = String(req.body.full_name || '').trim();
    const { email, phone, role } = req.body;
    if (!username || !password || !fullName || !role) {
      return res.status(400).json({ success: false, error: 'Username, full name, password and role are required' });
    }
    if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) {
      return res.status(400).json({ success: false, error: 'Username must be 3-40 characters using letters, numbers, dot, dash or underscore' });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }
    if (!STAFF_ROLES.includes(role)) {
      return res.status(400).json({ success: false, error: 'Invalid staff role' });
    }

    const existing = await db.get('SELECT id FROM users WHERE username = ? COLLATE NOCASE', [username]);
    if (existing) {
      return res.status(409).json({ success: false, error: 'Username already taken' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const userId = uuidv4();

    await db.run(
      `INSERT INTO users (id, property_id, username, password_hash, full_name, email, phone, role, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [userId, req.user.property_id, username, passwordHash, fullName, email || null, phone || null, role]
    );

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'CREATE_USER',
      entityType: 'user',
      entityId: userId,
      details: { username, role, full_name: fullName },
      req
    });

    res.status(201).json({ success: true, message: 'User created successfully', userId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
