const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const { authenticateToken, requireRoles, JWT_SECRET } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');

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

    const payload = {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      property_id: user.property_id
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
      'SELECT id, username, full_name, email, phone, role, is_active, created_at FROM users ORDER BY created_at ASC'
    );
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/auth/users
router.post('/users', authenticateToken, requireRoles('admin'), async (req, res) => {
  try {
    const { username, password, full_name, email, phone, role } = req.body;
    if (!username || !password || !full_name || !role) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const existing = await db.get('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) {
      return res.status(400).json({ success: false, error: 'Username already taken' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const userId = uuidv4();

    await db.run(
      `INSERT INTO users (id, property_id, username, password_hash, full_name, email, phone, role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, req.user.property_id, username, passwordHash, full_name, email || null, phone || null, role]
    );

    res.json({ success: true, message: 'User created successfully', userId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
