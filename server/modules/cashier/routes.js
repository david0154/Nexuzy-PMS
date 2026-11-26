const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const { authenticateToken } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');

// GET /api/v1/cashier/current-shift
router.get('/current-shift', authenticateToken, async (req, res) => {
  try {
    const shift = await db.get(
      `SELECT s.*, u.full_name as cashier_name
       FROM cashier_shifts s
       JOIN users u ON s.user_id = u.id
       WHERE s.user_id = ? AND s.status = 'open'
       ORDER BY s.opening_time DESC LIMIT 1`,
      [req.user.id]
    );

    res.json({ success: true, has_open_shift: !!shift, shift });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/cashier/open-shift
router.post('/open-shift', authenticateToken, async (req, res) => {
  try {
    const { opening_float = 0, notes } = req.body;

    const existing = await db.get(
      "SELECT id FROM cashier_shifts WHERE user_id = ? AND status = 'open'",
      [req.user.id]
    );
    if (existing) {
      return res.status(400).json({ success: false, error: 'You already have an active open cashier shift' });
    }

    const id = uuidv4();
    const openingTime = new Date().toISOString().replace('T', ' ').substring(0, 19);

    await db.run(
      `INSERT INTO cashier_shifts (id, property_id, user_id, opening_time, opening_float, total_cash, total_card, total_upi, total_room_postings, status, notes)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 'open', ?)`,
      [id, req.user.property_id, req.user.id, openingTime, Number(opening_float), notes || null]
    );

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'OPEN_CASHIER_SHIFT',
      entityType: 'cashier_shift',
      entityId: id,
      details: { opening_float },
      req
    });

    const shift = await db.get('SELECT * FROM cashier_shifts WHERE id = ?', [id]);
    res.json({ success: true, message: 'Shift opened successfully', shift });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/cashier/close-shift
router.post('/close-shift', authenticateToken, async (req, res) => {
  try {
    const { closing_cash, notes } = req.body;

    const shift = await db.get(
      "SELECT * FROM cashier_shifts WHERE user_id = ? AND status = 'open' ORDER BY opening_time DESC LIMIT 1",
      [req.user.id]
    );

    if (!shift) {
      return res.status(400).json({ success: false, error: 'No active open cashier shift found' });
    }

    const countedCash = Number(closing_cash);
    const expectedCash = shift.opening_float + shift.total_cash;
    const variance = countedCash - expectedCash;
    const closingTime = new Date().toISOString().replace('T', ' ').substring(0, 19);

    await db.run(
      `UPDATE cashier_shifts 
       SET closing_time = ?,
           closing_cash = ?,
           variance = ?,
           status = 'closed',
           notes = COALESCE(?, notes)
       WHERE id = ?`,
      [closingTime, countedCash, variance, notes, shift.id]
    );

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'CLOSE_CASHIER_SHIFT',
      entityType: 'cashier_shift',
      entityId: shift.id,
      details: { expectedCash, countedCash, variance },
      req
    });

    res.json({
      success: true,
      message: 'Cashier shift closed successfully',
      summary: {
        opening_float: shift.opening_float,
        cash_collections: shift.total_cash,
        card_collections: shift.total_card,
        upi_collections: shift.total_upi,
        room_postings: shift.total_room_postings,
        expected_cash: expectedCash,
        counted_cash: countedCash,
        variance
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/cashier/history
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const shifts = await db.all(
      `SELECT s.*, u.full_name as cashier_name
       FROM cashier_shifts s
       JOIN users u ON s.user_id = u.id
       ORDER BY s.opening_time DESC LIMIT 30`
    );
    res.json({ success: true, shifts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
