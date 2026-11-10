const db = require('../config/database');
const { v4: uuidv4 } = require('uuid');

async function logAudit({ propertyId = 'prop-default', userId = null, action, entityType, entityId = null, details = null, req = null }) {
  try {
    const ip = req ? (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1') : '127.0.0.1';
    const detailStr = typeof details === 'object' ? JSON.stringify(details) : details;
    
    await db.run(
      `INSERT INTO audit_logs (id, property_id, user_id, action, entity_type, entity_id, details, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), propertyId, userId, action, entityType, entityId, detailStr, ip]
    );
  } catch (err) {
    console.error('Audit logging error:', err.message);
  }
}

module.exports = {
  logAudit
};
