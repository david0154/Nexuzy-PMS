const db = require('../config/database');
const { v4: uuidv4 } = require('uuid');

async function logAudit({
  propertyId = 'prop-default',
  userId = null,
  action,
  entityType,
  entityId = null,
  details = null,
  beforeValue = null,
  afterValue = null,
  req = null
}) {
  try {
    const ip = req ? (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1') : '127.0.0.1';
    const device = req ? (req.headers['user-agent'] || null) : null;
    const detailStr = details == null ? null : (typeof details === 'object' ? JSON.stringify(details) : details);
    const beforeStr = beforeValue == null ? null : (typeof beforeValue === 'object' ? JSON.stringify(beforeValue) : beforeValue);
    const afterStr = afterValue == null ? null : (typeof afterValue === 'object' ? JSON.stringify(afterValue) : afterValue);

    await db.run(
      `INSERT INTO audit_logs (id, property_id, user_id, action, entity_type, entity_id, details, before_value, after_value, device, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), propertyId, userId, action, entityType, entityId, detailStr, beforeStr, afterStr, device, ip]
    );
  } catch (err) {
    console.error('Audit logging error:', err.message);
  }
}

module.exports = {
  logAudit
};
