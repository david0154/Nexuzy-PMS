// Stock movement rules shared by the inventory API and purchase receiving.
// Every movement is written to a permanent ledger row inside the caller's
// transaction. Stock is only ever updated through this module.

const { v4: uuidv4 } = require('uuid');

const MOVEMENT_TYPES = {
  purchase: 'increase',
  return: 'increase',
  transfer_in: 'increase',
  issue: 'decrease',
  wastage: 'decrease',
  transfer_out: 'decrease',
  adjustment: 'adjustment'
};

const MOVEMENT_ALIASES = {
  receipt: 'purchase',
  received: 'purchase',
  stock_in: 'purchase',
  stock_out: 'issue'
};

const MOVEMENT_LABELS = {
  purchase: 'Purchase / Receipt',
  issue: 'Issue',
  wastage: 'Wastage',
  return: 'Return',
  adjustment: 'Adjustment',
  transfer_in: 'Transfer In',
  transfer_out: 'Transfer Out'
};

function normalizeMovementType(value) {
  const raw = String(value || '').toLowerCase().trim();
  const type = MOVEMENT_ALIASES[raw] || raw;
  return Object.prototype.hasOwnProperty.call(MOVEMENT_TYPES, type) ? type : null;
}

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parseQuantity(value) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw httpError('Quantity must be a number greater than zero');
  }
  return Math.round(quantity * 1000) / 1000;
}

function parseNonNegative(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw httpError(`${label} must be zero or greater`);
  }
  return number;
}

/**
 * Applies one stock movement. Must run inside db.transaction().
 * @returns {Promise<{movement: object, item: object, previousStock: number, newStock: number}>}
 */
async function recordMovement(conn, {
  propertyId,
  stockItemId,
  movementType,
  quantity,
  unitCost = null,
  reference = null,
  reason = null,
  userId = null,
  approvedBy = null,
  allowNegative = false,
  direction = null,
  movementGroup = null
}) {
  if (!propertyId) throw httpError('Property context is required');
  if (!stockItemId) throw httpError('Stock item is required');

  const type = normalizeMovementType(movementType);
  if (!type) {
    throw httpError(`Unsupported movement type. Use one of: ${Object.keys(MOVEMENT_TYPES).join(', ')}`);
  }

  const qty = parseQuantity(quantity);
  const item = await conn.get(
    'SELECT * FROM stock_items WHERE id = ? AND property_id = ?',
    [stockItemId, propertyId]
  );
  if (!item) throw httpError('Stock item not found for this property', 404);

  let delta = 0;
  if (MOVEMENT_TYPES[type] === 'increase') {
    delta = qty;
  } else if (MOVEMENT_TYPES[type] === 'decrease') {
    delta = -qty;
  } else {
    // Adjustments are explicit: the browser cannot use an unknown direction to
    // increase stock accidentally.
    const dir = String(direction || '').toLowerCase();
    if (!['increase', 'decrease'].includes(dir)) {
      throw httpError('An adjustment requires direction "increase" or "decrease"');
    }
    delta = dir === 'increase' ? qty : -qty;
  }

  const previousStock = Number(item.current_stock) || 0;
  const newStock = Math.round((previousStock + delta) * 1000) / 1000;
  if (newStock < 0 && !allowNegative) {
    throw httpError(`Insufficient stock. Current: ${previousStock} ${item.unit}`);
  }

  const cost = unitCost === null || unitCost === undefined ? null : parseNonNegative(unitCost, 'Cost price');
  const movementId = uuidv4();
  const resultingCost = cost === null ? Number(item.cost_price) || 0 : cost;

  const updated = await conn.run(
    `UPDATE stock_items
     SET current_stock = ?, cost_price = ?
     WHERE id = ? AND property_id = ?`,
    [newStock, resultingCost, item.id, propertyId]
  );
  if (!updated.changes) throw httpError('Stock item could not be updated', 409);

  await conn.run(
    `INSERT INTO stock_movements
     (id, property_id, stock_item_id, movement_type, quantity, unit_cost,
      previous_stock, new_stock, reference, reason, movement_group, approved_by, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      movementId, propertyId, item.id, type, qty, cost,
      previousStock, newStock, reference || null, reason || null,
      movementGroup || null, approvedBy || null, userId || null
    ]
  );

  const movement = await conn.get('SELECT * FROM stock_movements WHERE id = ?', [movementId]);
  const freshItem = await conn.get('SELECT * FROM stock_items WHERE id = ?', [item.id]);
  return { movement, item: freshItem, previousStock, newStock };
}

module.exports = {
  MOVEMENT_TYPES,
  MOVEMENT_LABELS,
  normalizeMovementType,
  parseQuantity,
  parseNonNegative,
  recordMovement,
  httpError
};
