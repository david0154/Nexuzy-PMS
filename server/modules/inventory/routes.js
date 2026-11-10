const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const { authenticateToken } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');

// GET /api/v1/inventory/items
router.get('/items', authenticateToken, async (req, res) => {
  try {
    const items = await db.all(
      `SELECT *,
              CASE WHEN current_stock <= min_stock THEN 1 ELSE 0 END as is_low_stock
       FROM stock_items 
       ORDER BY category ASC, name ASC`
    );
    res.json({ success: true, items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/inventory/items
router.post('/items', authenticateToken, async (req, res) => {
  try {
    const { name, category, unit, current_stock = 0, min_stock = 10, cost_price = 0 } = req.body;
    if (!name || !category || !unit) {
      return res.status(400).json({ success: false, error: 'Name, category and unit are required' });
    }

    const id = uuidv4();
    await db.run(
      `INSERT INTO stock_items (id, property_id, name, category, unit, current_stock, min_stock, cost_price, reorder_level)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.user.property_id, name, category, unit, Number(current_stock), Number(min_stock), Number(cost_price), Number(min_stock) * 1.5]
    );

    res.json({ success: true, message: 'Stock item added', id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/inventory/movements (Record stock receipt, issue, wastage, adjustment)
router.post('/movements', authenticateToken, async (req, res) => {
  try {
    const { stock_item_id, movement_type, quantity, reference, reason } = req.body;

    const qty = Number(quantity);
    if (!stock_item_id || !movement_type || !qty || qty <= 0) {
      return res.status(400).json({ success: false, error: 'Valid item, movement type, and quantity required' });
    }

    const item = await db.get('SELECT * FROM stock_items WHERE id = ?', [stock_item_id]);
    if (!item) return res.status(404).json({ success: false, error: 'Stock item not found' });

    let stockDelta = qty;
    if (movement_type === 'issue' || movement_type === 'wastage') {
      stockDelta = -qty;
      if (item.current_stock < qty) {
        return res.status(400).json({ success: false, error: `Insufficient stock. Current: ${item.current_stock} ${item.unit}` });
      }
    }

    const movId = uuidv4();

    await db.transaction(async () => {
      await db.run(
        `INSERT INTO stock_movements (id, stock_item_id, movement_type, quantity, reference, reason, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [movId, stock_item_id, movement_type, qty, reference || null, reason || null, req.user.id]
      );

      await db.run(
        `UPDATE stock_items SET current_stock = current_stock + ? WHERE id = ?`,
        [stockDelta, stock_item_id]
      );
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'STOCK_MOVEMENT',
      entityType: 'stock_item',
      entityId: stock_item_id,
      details: { movement_type, quantity: qty, new_stock: item.current_stock + stockDelta },
      req
    });

    res.json({ success: true, message: `Recorded ${movement_type} of ${qty} ${item.unit}`, newStock: item.current_stock + stockDelta });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
