const jwt = require('jsonwebtoken');
const db = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET || 'nexuzy-pms-secret-key-2026';

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  if (!token) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  jwt.verify(token, JWT_SECRET, async (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, error: 'Invalid or expired token' });
    }

    // Per-device sessions can be revoked by an administrator. A revoked token
    // stops working immediately instead of lasting until JWT expiry.
    if (user.sid) {
      try {
        const session = await db.get('SELECT * FROM lan_sessions WHERE id = ?', [user.sid]);
        if (!session || !session.is_active || session.revoked_at) {
          return res.status(401).json({ success: false, error: 'Session revoked. Please sign in again.' });
        }
        req.sessionId = user.sid;
        db.run(
          `UPDATE lan_sessions SET last_seen_at = CURRENT_TIMESTAMP
           WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-1 minute'))`,
          [user.sid]
        ).catch(() => {});
      } catch (sessionError) {
        return res.status(503).json({ success: false, error: 'Session store unavailable' });
      }
    }

    req.user = user;
    next();
  });
}

// Role-based permission guard
function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    if (req.user.role === 'admin') {
      return next(); // Admin always has full access
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: `Access denied. Requires one of roles: ${roles.join(', ')}`
      });
    }

    next();
  };
}

module.exports = {
  authenticateToken,
  requireRoles,
  JWT_SECRET
};
