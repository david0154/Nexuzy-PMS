const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const { authenticateToken, requireRoles } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');
const {
  MOVEMENT_LABELS,
  normalizeMovementType,
  parseQuantity,
  parseNonNegative,
  recordMovement,
  httpError
} = require('../../services/inventory');

const INVENTORY_ROLES = ['admin', 'general_manager', 'inventory', 'restaurant_manager'];
const MOVEMENT_ROLES = [...INVENTORY_ROLES, 'housekeeping', 'maintenance', 'kitchen'];
const INVENTORY_CATEGORIES = [
  'kitchen_ingredients', 'beverages', 'housekeeping_supplies', 'amenities',
  'maintenance_supplies', 'linen', 'general', 'other'
];

function sendError(res, err) {
  const status = err.statusCode || 500;
  res.status(status).json({ success: false, error: err.message });
}

// GET /api/v1/inventory/items
router.get('/items', authenticateToken, async (req, res) => {
  try {
    const where = ['property_id = ?'];
    const params = [req.user.property_id];
    if (req.query.category) { where.push('category = ?'); params.push(req.query.category); }
    if (req.query.search) {
      where.push('name LIKE ?');
      params.push(`%${String(req.query.search).slice(0, 80)}%`);
    }

    const items = await db.all(
      `SELECT *,
              CASE WHEN current_stock <= min_stock THEN 1 ELSE 0 END AS is_low_stock
       FROM stock_items
       WHERE ${where.join(' AND ')}
       ORDER BY category ASC, name ASC`,
      params
    );
    res.json({ success: true, items, movement_types: Object.entries(MOVEMENT_LABELS).map(([value, label]) => ({ value, label })) });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/v1/inventory/items/:id/movements
router.get('/items/:id/movements', authenticateToken, async (req, res) => {
  try {
    const item = await db.get(
      'SELECT * FROM stock_items WHERE id = ? AND property_id = ?',
      [req.params.id, req.user.property_id]
    );
    if (!item) return res.status(404).json({ success: false, error: 'Stock item not found' });

    const movements = await db.all(
      `SELECT m.*, u.full_name AS created_by_name
       FROM stock_movements m
       LEFT JOIN users u ON m.created_by = u.id
       WHERE m.stock_item_id = ? AND (m.property_id = ? OR m.property_id IS NULL)
       ORDER BY m.created_at DESC
       LIMIT 500`,
      [item.id, req.user.property_id]
    );
    res.json({ success: true, item, movements });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/v1/inventory/movements
router.get('/movements', authenticateToken, async (req, res) => {
  try {
    const where = ['m.property_id = ?'];
    const params = [req.user.property_id];
    if (req.query.type) { where.push('m.movement_type = ?'); params.push(req.query.type); }
    if (req.query.from) { where.push('date(m.created_at) >= date(?)'); params.push(req.query.from); }
    if (req.query.to) { where.push('date(m.created_at) <= date(?)'); params.push(req.query.to); }

    const movements = await db.all(
      `SELECT m.*, s.name AS item_name, s.unit, u.full_name AS created_by_name
       FROM stock_movements m
       JOIN stock_items s ON m.stock_item_id = s.id AND s.property_id = m.property_id
       LEFT JOIN users u ON m.created_by = u.id
       WHERE ${where.join(' AND ')}
       ORDER BY m.created_at DESC
       LIMIT 1000`,
      params
    );
    res.json({ success: true, movements });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/v1/inventory/items
router.post('/items', authenticateToken, requireRoles(...INVENTORY_ROLES), async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const category = String(req.body.category || '').trim();
    const unit = String(req.body.unit || '').trim();
    if (!name || !category || !unit) {
      return res.status(400).json({ success: false, error: 'Name, category and unit are required' });
    }
    if (name.length > 120) return res.status(400).json({ success: false, error: 'Item name is too long' });

    const currentStock = parseNonNegative(req.body.current_stock ?? 0, 'Opening stock');
    const minStock = parseNonNegative(req.body.min_stock ?? 10, 'Minimum stock');
    const costPrice = parseNonNegative(req.body.cost_price ?? 0, 'Cost price');
    const reorderLevel = req.body.reorder_level === undefined
      ? minStock * 1.5
      : parseNonNegative(req.body.reorder_level, 'Reorder level');

    const duplicate = await db.get(
      'SELECT id FROM stock_items WHERE property_id = ? AND name = ? COLLATE NOCASE',
      [req.user.property_id, name]
    );
    if (duplicate) {
      return res.status(409).json({ success: false, error: `A stock item named "${name}" already exists` });
    }

    const id = uuidv4();
    await db.transaction(async (conn) => {
      await conn.run(
        `INSERT INTO stock_items
         (id, property_id, name, category, unit, current_stock, min_stock, cost_price, reorder_level)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, req.user.property_id, name, category, unit, currentStock, minStock, costPrice, reorderLevel]
      );

      // Opening stock is a real ledger entry, not an unexplained balance.
      if (currentStock > 0) {
        await conn.run(
          `INSERT INTO stock_movements
           (id, property_id, stock_item_id, movement_type, quantity, unit_cost,
            previous_stock, new_stock, reason, created_by)
           VALUES (?, ?, ?, 'adjustment', ?, ?, 0, ?, 'Opening stock', ?)`,
          [uuidv4(), req.user.property_id, id, currentStock, costPrice, currentStock, req.user.id]
        );
      }
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'CREATE_STOCK_ITEM',
      entityType: 'stock_item',
      entityId: id,
      details: { name, category, unit, current_stock: currentStock, cost_price: costPrice },
      req
    });

    res.status(201).json({ success: true, message: 'Stock item added', id });
  } catch (err) {
    sendError(res, err);
  }
});

// PATCH /api/v1/inventory/items/:id — master data only; stock changes use movements
router.patch('/items/:id', authenticateToken, requireRoles(...INVENTORY_ROLES), async (req, res) => {
  try {
    const item = await db.get(
      'SELECT * FROM stock_items WHERE id = ? AND property_id = ?',
      [req.params.id, req.user.property_id]
    );
    if (!item) return res.status(404).json({ success: false, error: 'Stock item not found' });

    const name = req.body.name !== undefined ? String(req.body.name).trim() : item.name;
    if (!name) return res.status(400).json({ success: false, error: 'Item name is required' });
    const duplicate = await db.get(
      'SELECT id FROM stock_items WHERE property_id = ? AND name = ? COLLATE NOCASE AND id != ?',
      [req.user.property_id, name, item.id]
    );
    if (duplicate) return res.status(409).json({ success: false, error: 'Another stock item already uses this name' });

    const minStock = req.body.min_stock !== undefined ? parseNonNegative(req.body.min_stock, 'Minimum stock') : item.min_stock;
    const costPrice = req.body.cost_price !== undefined ? parseNonNegative(req.body.cost_price, 'Cost price') : item.cost_price;
    const reorderLevel = req.body.reorder_level !== undefined
      ? parseNonNegative(req.body.reorder_level, 'Reorder level')
      : item.reorder_level;

    await db.run(
      `UPDATE stock_items
       SET name = ?, category = ?, unit = ?, min_stock = ?, cost_price = ?, reorder_level = ?
       WHERE id = ? AND property_id = ?`,
      [
        name,
        req.body.category !== undefined ? String(req.body.category).trim() : item.category,
        req.body.unit !== undefined ? String(req.body.unit).trim() : item.unit,
        minStock, costPrice, reorderLevel, item.id, req.user.property_id
      ]
    );

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'UPDATE_STOCK_ITEM',
      entityType: 'stock_item',
      entityId: item.id,
      beforeValue: { name: item.name, min_stock: item.min_stock, cost_price: item.cost_price },
      afterValue: { name, min_stock: minStock, cost_price: costPrice },
      req
    });
    res.json({ success: true, message: 'Stock item updated' });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/v1/inventory/movements
router.post('/movements', authenticateToken, requireRoles(...MOVEMENT_ROLES), async (req, res) => {
  try {
    const { stock_item_id, movement_type, reference, reason, direction, idempotency_key } = req.body;
    const quantity = parseQuantity(req.body.quantity);
    const type = normalizeMovementType(movement_type);
    if (!type) {
      return res.status(400).json({
        success: false,
        error: `Invalid movement type. Use one of: ${Object.keys(MOVEMENT_LABELS).join(', ')}`
      });
    }
    if (!reason && ['wastage', 'adjustment'].includes(type)) {
      return res.status(400).json({ success: false, error: 'A reason is required for wastage and adjustments' });
    }

    // Negative stock may only be forced by an administrator who explicitly
    // confirms it; movement types themselves can never bypass this.
    const allowNegative = Boolean(req.body.allow_negative) &&
      ['admin', 'general_manager'].includes(req.user.role);

    const result = await db.transaction(async (conn) => {
      if (idempotency_key) {
        const existing = await conn.get(
          `SELECT * FROM idempotency_records
           WHERE property_id = ? AND scope = 'stock_movement' AND idempotency_key = ?`,
          [req.user.property_id, String(idempotency_key)]
        );
        if (existing) {
          const movement = existing.reference_id
            ? await conn.get('SELECT * FROM stock_movements WHERE id = ?', [existing.reference_id])
            : null;
          return { duplicate: true, movement, item: null };
        }
      }

      const applied = await recordMovement(conn, {
        propertyId: req.user.property_id,
        stockItemId: stock_item_id,
        movementType: type,
        quantity,
        unitCost: req.body.unit_cost,
        reference: reference || null,
        reason: reason || null,
        userId: req.user.id,
        approvedBy: allowNegative ? req.user.id : null,
        allowNegative,
        direction
      });

      if (idempotency_key) {
        await conn.run(
          `INSERT INTO idempotency_records (id, property_id, scope, idempotency_key, reference_id)
           VALUES (?, ?, 'stock_movement', ?, ?)`,
          [uuidv4(), req.user.property_id, String(idempotency_key), applied.movement.id]
        );
      }
      return { duplicate: false, ...applied };
    });

    if (result.duplicate) {
      return res.json({
        success: true,
        duplicate: true,
        message: 'This stock movement was already recorded.',
        movement: result.movement,
        newStock: result.movement ? result.movement.new_stock : null
      });
    }

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'STOCK_MOVEMENT',
      entityType: 'stock_item',
      entityId: result.item.id,
      beforeValue: { current_stock: result.previousStock },
      afterValue: { current_stock: result.newStock },
      details: {
        movement_id: result.movement.id,
        movement_type: type,
        quantity,
        unit_cost: result.movement.unit_cost,
        reference: reference || null,
        reason: reason || null,
        allow_negative: allowNegative
      },
      req
    });

    res.json({
      success: true,
      message: `Recorded ${MOVEMENT_LABELS[type]} of ${quantity} ${result.item.unit}`,
      newStock: result.newStock,
      movement: result.movement,
      item: result.item
    });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
module.exports.MOVEMENT_ROLES = MOVEMENT_ROLES;
