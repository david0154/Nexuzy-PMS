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
       FROM stock_items WHERE property_id = ?
       ORDER BY category ASC, name ASC`,
      [req.user.property_id]
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

    const initial = Number(current_stock);
    const minimum = Number(min_stock);
    const cost = Number(cost_price);
    if (![initial, minimum, cost].every(Number.isFinite) || initial < 0 || minimum < 0 || cost < 0) {
      return res.status(400).json({ success: false, error: 'Stock, minimum level and cost must be valid non-negative numbers' });
    }
    const duplicate = await db.get('SELECT id FROM stock_items WHERE property_id = ? AND name = ? COLLATE NOCASE', [req.user.property_id, String(name).trim()]);
    if (duplicate) return res.status(409).json({ success: false, error: 'An inventory item with this name already exists' });

    const id = uuidv4();
    await db.run(
      `INSERT INTO stock_items (id, property_id, name, category, unit, current_stock, min_stock, cost_price, reorder_level)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.user.property_id, String(name).trim(), category, unit, initial, minimum, cost, minimum * 1.5]
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
    if (!stock_item_id || !['receipt', 'issue', 'wastage', 'adjustment'].includes(movement_type) || !Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ success: false, error: 'Valid item, movement type, and quantity required' });
    }

    const item = await db.get('SELECT * FROM stock_items WHERE id = ? AND property_id = ?', [stock_item_id, req.user.property_id]);
    if (!item) return res.status(404).json({ success: false, error: 'Stock item not found' });

    let stockDelta = qty;
    if (movement_type === 'issue' || movement_type === 'wastage') {
      stockDelta = -qty;
      if (Number(item.current_stock) < qty) {
        return res.status(400).json({ success: false, error: `Insufficient stock. Current: ${item.current_stock} ${item.unit}` });
      }
    }

    if (movement_type === 'adjustment') stockDelta = qty - Number(item.current_stock);
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
