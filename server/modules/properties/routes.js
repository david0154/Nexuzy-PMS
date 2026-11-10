const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const { authenticateToken, requireRoles } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');

// GET /api/v1/properties/current
router.get('/current', authenticateToken, async (req, res) => {
  try {
    const property = await db.get(
      'SELECT * FROM properties WHERE id = ? OR code = ? LIMIT 1',
      [req.user.property_id || 'prop-nexuzy-01', 'NEX-01']
    );
    if (!property) {
      return res.status(404).json({ success: false, error: 'Property not found' });
    }
    res.json({ success: true, property });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/v1/properties/current
router.patch('/current', authenticateToken, requireRoles('admin', 'general_manager'), async (req, res) => {
  try {
    const { name, gstin, address, phone, email, checkin_time, checkout_time } = req.body;
    await db.run(
      `UPDATE properties 
       SET name = COALESCE(?, name),
           gstin = COALESCE(?, gstin),
           address = COALESCE(?, address),
           phone = COALESCE(?, phone),
           email = COALESCE(?, email),
           checkin_time = COALESCE(?, checkin_time),
           checkout_time = COALESCE(?, checkout_time)
       WHERE id = ?`,
      [name, gstin, address, phone, email, checkin_time, checkout_time, req.user.property_id]
    );

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'UPDATE_PROPERTY_SETTINGS',
      entityType: 'property',
      entityId: req.user.property_id,
      details: req.body,
      req
    });

    const updated = await db.get('SELECT * FROM properties WHERE id = ?', [req.user.property_id]);
    res.json({ success: true, property: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
