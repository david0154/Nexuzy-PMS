const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const { authenticateToken, requireRoles } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');
const { nextDocumentNumber } = require('../../services/documents');
const { recordMovement, parseQuantity, parseNonNegative, httpError } = require('../../services/inventory');
const { round2 } = require('../../services/billing');

const PURCHASING_ROLES = ['admin', 'general_manager', 'inventory'];
const APPROVER_ROLES = ['admin', 'general_manager'];
const PAYMENT_MODES = ['cash', 'upi', 'card', 'bank_transfer', 'netbanking', 'credit'];

function sendError(res, err) {
  res.status(err.statusCode || 500).json({ success: false, error: err.message });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ------------------------------------------------------------------
// Suppliers
// ------------------------------------------------------------------
router.get('/suppliers', authenticateToken, requireRoles(...PURCHASING_ROLES), async (req, res) => {
  try {
    const where = ['property_id = ?'];
    const params = [req.user.property_id];
    if (req.query.status) { where.push('status = ?'); params.push(req.query.status); }
    if (req.query.search) {
      where.push('(name LIKE ? OR company LIKE ? OR phone LIKE ? OR gstin LIKE ?)');
      const term = `%${String(req.query.search).slice(0, 80)}%`;
      params.push(term, term, term, term);
    }
    const suppliers = await db.all(
      `SELECT * FROM suppliers WHERE ${where.join(' AND ')} ORDER BY name ASC`,
      params
    );
    res.json({ success: true, suppliers });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/suppliers', authenticateToken, requireRoles(...PURCHASING_ROLES), async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'Supplier name is required' });

    const duplicate = await db.get(
      'SELECT id FROM suppliers WHERE property_id = ? AND name = ? COLLATE NOCASE',
      [req.user.property_id, name]
    );
    if (duplicate) return res.status(409).json({ success: false, error: 'A supplier with this name already exists' });

    const id = uuidv4();
    await db.run(
      `INSERT INTO suppliers
       (id, property_id, name, company, contact_person, phone, email, address, gstin, payment_terms, outstanding_balance, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [
        id, req.user.property_id, name,
        req.body.company || null, req.body.contact_person || null, req.body.phone || null,
        req.body.email || null, req.body.address || null, req.body.gstin || null,
        req.body.payment_terms || null,
        req.body.outstanding_balance === undefined ? 0 : parseNonNegative(req.body.outstanding_balance, 'Outstanding balance')
      ]
    );
    await logAudit({
      propertyId: req.user.property_id, userId: req.user.id, action: 'CREATE_SUPPLIER',
      entityType: 'supplier', entityId: id, details: { name, gstin: req.body.gstin || null }, req
    });
    res.status(201).json({ success: true, message: 'Supplier created', id });
  } catch (err) {
    sendError(res, err);
  }
});

router.patch('/suppliers/:id', authenticateToken, requireRoles(...PURCHASING_ROLES), async (req, res) => {
  try {
    const supplier = await db.get(
      'SELECT * FROM suppliers WHERE id = ? AND property_id = ?',
      [req.params.id, req.user.property_id]
    );
    if (!supplier) return res.status(404).json({ success: false, error: 'Supplier not found' });

    const name = req.body.name !== undefined ? String(req.body.name).trim() : supplier.name;
    if (!name) return res.status(400).json({ success: false, error: 'Supplier name is required' });
    const duplicate = await db.get(
      'SELECT id FROM suppliers WHERE property_id = ? AND name = ? COLLATE NOCASE AND id != ?',
      [req.user.property_id, name, supplier.id]
    );
    if (duplicate) return res.status(409).json({ success: false, error: 'Another supplier already uses this name' });

    await db.run(
      `UPDATE suppliers SET name = ?, company = ?, contact_person = ?, phone = ?, email = ?,
         address = ?, gstin = ?, payment_terms = ?, status = ?
       WHERE id = ? AND property_id = ?`,
      [
        name,
        req.body.company !== undefined ? req.body.company : supplier.company,
        req.body.contact_person !== undefined ? req.body.contact_person : supplier.contact_person,
        req.body.phone !== undefined ? req.body.phone : supplier.phone,
        req.body.email !== undefined ? req.body.email : supplier.email,
        req.body.address !== undefined ? req.body.address : supplier.address,
        req.body.gstin !== undefined ? req.body.gstin : supplier.gstin,
        req.body.payment_terms !== undefined ? req.body.payment_terms : supplier.payment_terms,
        req.body.status !== undefined ? (req.body.status === 'archived' ? 'archived' : 'active') : supplier.status,
        supplier.id, req.user.property_id
      ]
    );
    res.json({ success: true, message: 'Supplier updated' });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/suppliers/:id/payments', authenticateToken, requireRoles(...PURCHASING_ROLES), async (req, res) => {
  try {
    const supplier = await db.get(
      'SELECT * FROM suppliers WHERE id = ? AND property_id = ?',
      [req.params.id, req.user.property_id]
    );
    if (!supplier) return res.status(404).json({ success: false, error: 'Supplier not found' });

    const amount = round2(req.body.amount);
    if (!(amount > 0)) return res.status(400).json({ success: false, error: 'Payment amount must be greater than zero' });
    const method = String(req.body.payment_method || 'cash').toLowerCase();
    if (!PAYMENT_MODES.includes(method)) {
      return res.status(400).json({ success: false, error: `Payment method must be one of: ${PAYMENT_MODES.join(', ')}` });
    }

    const id = uuidv4();
    await db.transaction(async (conn) => {
      const fresh = await conn.get('SELECT * FROM suppliers WHERE id = ? AND property_id = ?', [supplier.id, req.user.property_id]);
      await conn.run(
        `INSERT INTO supplier_payments
         (id, property_id, supplier_id, purchase_order_id, amount, payment_method, reference, notes, paid_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, req.user.property_id, fresh.id, req.body.purchase_order_id || null,
          amount, method, req.body.reference || null, req.body.notes || null, req.user.id
        ]
      );
      await conn.run(
        'UPDATE suppliers SET outstanding_balance = MAX(0, ROUND(outstanding_balance - ?, 2)) WHERE id = ?',
        [amount, fresh.id]
      );
    });

    await logAudit({
      propertyId: req.user.property_id, userId: req.user.id, action: 'SUPPLIER_PAYMENT',
      entityType: 'supplier', entityId: supplier.id,
      details: { amount, payment_method: method, reference: req.body.reference || null }, req
    });
    res.json({ success: true, message: 'Supplier payment recorded', id });
  } catch (err) {
    sendError(res, err);
  }
});

// ------------------------------------------------------------------
// Purchase orders
// ------------------------------------------------------------------
async function loadPurchaseOrder(conn, propertyId, id) {
  const order = await conn.get(
    `SELECT po.*, s.name AS supplier_name, s.company AS supplier_company, s.phone AS supplier_phone,
            s.gstin AS supplier_gstin
     FROM purchase_orders po
     JOIN suppliers s ON po.supplier_id = s.id
     WHERE po.id = ? AND po.property_id = ?`,
    [id, propertyId]
  );
  if (!order) return null;
  order.items = await conn.all(
    `SELECT poi.*, si.name AS item_name, si.unit, si.current_stock
     FROM purchase_order_items poi
     JOIN stock_items si ON poi.stock_item_id = si.id
     WHERE poi.purchase_order_id = ?
     ORDER BY si.name ASC`,
    [id]
  );
  return order;
}

router.get('/purchase-orders', authenticateToken, requireRoles(...PURCHASING_ROLES), async (req, res) => {
  try {
    const where = ['po.property_id = ?'];
    const params = [req.user.property_id];
    if (req.query.status) { where.push('po.status = ?'); params.push(req.query.status); }
    if (req.query.from) { where.push('date(po.order_date) >= date(?)'); params.push(req.query.from); }
    if (req.query.to) { where.push('date(po.order_date) <= date(?)'); params.push(req.query.to); }

    const orders = await db.all(
      `SELECT po.*, s.name AS supplier_name,
              (SELECT COUNT(*) FROM purchase_order_items i WHERE i.purchase_order_id = po.id) AS item_count
       FROM purchase_orders po
       JOIN suppliers s ON po.supplier_id = s.id
       WHERE ${where.join(' AND ')}
       ORDER BY date(po.order_date) DESC, po.created_at DESC`,
      params
    );
    res.json({ success: true, purchase_orders: orders });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/purchase-orders/:id', authenticateToken, requireRoles(...PURCHASING_ROLES), async (req, res) => {
  try {
    const order = await loadPurchaseOrder(db, req.user.property_id, req.params.id);
    if (!order) return res.status(404).json({ success: false, error: 'Purchase order not found' });
    res.json({ success: true, purchase_order: order });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/purchase-orders', authenticateToken, requireRoles(...PURCHASING_ROLES), async (req, res) => {
  try {
    const supplier = await db.get(
      'SELECT * FROM suppliers WHERE id = ? AND property_id = ? AND status = ?',
      [req.body.supplier_id, req.user.property_id, 'active']
    );
    if (!supplier) return res.status(400).json({ success: false, error: 'Active supplier not found' });

    const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
    if (!rawItems.length) return res.status(400).json({ success: false, error: 'Add at least one item to the purchase order' });

    const orderDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.order_date || '')) ? req.body.order_date : today();
    const expectedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.expected_date || '')) ? req.body.expected_date : null;

    const lines = [];
    for (const raw of rawItems) {
      const stockItem = await db.get(
        'SELECT * FROM stock_items WHERE id = ? AND property_id = ?',
        [raw.stock_item_id, req.user.property_id]
      );
      if (!stockItem) throw httpError(`Stock item ${raw.stock_item_id} does not belong to this property`);
      const quantity = parseQuantity(raw.quantity);
      const unitCost = parseNonNegative(raw.unit_cost, 'Unit cost');
      const taxRate = raw.tax_rate === undefined ? 0 : Number(raw.tax_rate);
      if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 28) {
        throw httpError('Purchase tax rate must be between 0 and 28');
      }
      const lineTotal = round2(quantity * unitCost * (1 + taxRate / 100));
      lines.push({ stockItem, quantity, unitCost, taxRate, lineTotal, description: raw.description || stockItem.name });
    }

    const subtotal = round2(lines.reduce((sum, l) => sum + l.quantity * l.unitCost, 0));
    const total = round2(lines.reduce((sum, l) => sum + l.lineTotal, 0));
    const taxAmount = round2(total - subtotal);

    const orderId = await db.transaction(async (conn) => {
      const poNumber = await nextDocumentNumber(conn, req.user.property_id, 'purchase_order', { prefix: 'PO' });
      const id = uuidv4();
      await conn.run(
        `INSERT INTO purchase_orders
         (id, property_id, po_number, supplier_id, order_date, expected_date, status,
          subtotal, tax_amount, total_amount, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
        [
          id, req.user.property_id, poNumber, supplier.id, orderDate, expectedDate,
          subtotal, taxAmount, total, req.body.notes || null, req.user.id
        ]
      );
      for (const line of lines) {
        await conn.run(
          `INSERT INTO purchase_order_items
           (id, purchase_order_id, stock_item_id, description, quantity, received_quantity, unit_cost, tax_rate, line_total)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
          [uuidv4(), id, line.stockItem.id, line.description, line.quantity, line.unitCost, line.taxRate, line.lineTotal]
        );
      }
      return id;
    });

    await logAudit({
      propertyId: req.user.property_id, userId: req.user.id, action: 'CREATE_PURCHASE_ORDER',
      entityType: 'purchase_order', entityId: orderId,
      details: { supplier: supplier.name, total_amount: total, item_count: lines.length }, req
    });
    res.status(201).json({ success: true, message: 'Purchase order created as a draft', id: orderId });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/purchase-orders/:id/approve', authenticateToken, requireRoles(...APPROVER_ROLES), async (req, res) => {
  try {
    const order = await loadPurchaseOrder(db, req.user.property_id, req.params.id);
    if (!order) return res.status(404).json({ success: false, error: 'Purchase order not found' });
    if (!['draft', 'pending_approval'].includes(order.status)) {
      return res.status(409).json({ success: false, error: `A ${order.status} purchase order cannot be approved` });
    }

    await db.run(
      "UPDATE purchase_orders SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ? AND property_id = ?",
      [req.user.id, order.id, req.user.property_id]
    );
    await logAudit({
      propertyId: req.user.property_id, userId: req.user.id, action: 'APPROVE_PURCHASE_ORDER',
      entityType: 'purchase_order', entityId: order.id,
      details: { po_number: order.po_number, total_amount: order.total_amount }, req
    });
    res.json({ success: true, message: 'Purchase order approved' });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/purchase-orders/:id/receive', authenticateToken, requireRoles(...PURCHASING_ROLES), async (req, res) => {
  try {
    const rawLines = Array.isArray(req.body.items) ? req.body.items : [];
    if (!rawLines.length) return res.status(400).json({ success: false, error: 'Enter the quantities actually received' });

    const result = await db.transaction(async (conn) => {
      const order = await loadPurchaseOrder(conn, req.user.property_id, req.params.id);
      if (!order) throw httpError('Purchase order not found', 404);
      if (!['approved', 'partially_received'].includes(order.status)) {
        throw httpError('Only an approved purchase order can receive goods');
      }

      let receivedValue = 0;
      const receivedLines = [];
      for (const raw of rawLines) {
        const line = order.items.find(i => i.id === raw.id);
        if (!line) throw httpError('Purchase order item not found in this order');
        const qty = raw.received_quantity === undefined ? Number(line.quantity) - Number(line.received_quantity) : Number(raw.received_quantity);
        if (!Number.isFinite(qty) || qty <= 0) continue;
        const remaining = round2(Number(line.quantity) - Number(line.received_quantity));
        if (qty > remaining + 0.0001) {
          throw httpError(`Cannot receive more than the ordered quantity for ${line.item_name}`);
        }

        // Goods received are the only event that increases stock.
        await recordMovement(conn, {
          propertyId: req.user.property_id,
          stockItemId: line.stock_item_id,
          movementType: 'purchase',
          quantity: qty,
          unitCost: line.unit_cost,
          reference: order.po_number,
          reason: `Goods received against ${order.po_number}`,
          userId: req.user.id,
          movementGroup: order.id
        });

        await conn.run(
          'UPDATE purchase_order_items SET received_quantity = ROUND(received_quantity + ?, 3) WHERE id = ?',
          [qty, line.id]
        );
        receivedValue += Number(line.unit_cost) * qty * (1 + Number(line.tax_rate || 0) / 100);
        receivedLines.push({ id: line.id, item_name: line.item_name, quantity: qty });
      }

      if (!receivedLines.length) throw httpError('No valid received quantities were supplied');

      const freshItems = await conn.all(
        'SELECT * FROM purchase_order_items WHERE purchase_order_id = ?',
        [order.id]
      );
      const fullyReceived = freshItems.every(i => Number(i.received_quantity) + 0.0001 >= Number(i.quantity));
      await conn.run(
        `UPDATE purchase_orders
         SET status = ?, received_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE received_at END
         WHERE id = ? AND property_id = ?`,
        [fullyReceived ? 'received' : 'partially_received', fullyReceived ? 1 : 0, order.id, req.user.property_id]
      );
      await conn.run(
        'UPDATE suppliers SET outstanding_balance = ROUND(outstanding_balance + ?, 2) WHERE id = ? AND property_id = ?',
        [round2(receivedValue), order.supplier_id, req.user.property_id]
      );

      return { order, receivedLines, fullyReceived, receivedValue: round2(receivedValue) };
    });

    await logAudit({
      propertyId: req.user.property_id, userId: req.user.id, action: 'RECEIVE_PURCHASE_ORDER',
      entityType: 'purchase_order', entityId: result.order.id,
      details: {
        po_number: result.order.po_number,
        lines: result.receivedLines,
        fully_received: result.fullyReceived,
        received_value: result.receivedValue
      }, req
    });

    res.json({
      success: true,
      message: result.fullyReceived ? 'Purchase order fully received and stock updated' : 'Delivery recorded; stock updated',
      status: result.fullyReceived ? 'received' : 'partially_received',
      received_value: result.receivedValue
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/purchase-orders/:id/cancel', authenticateToken, requireRoles(...APPROVER_ROLES), async (req, res) => {
  try {
    const order = await db.get(
      'SELECT * FROM purchase_orders WHERE id = ? AND property_id = ?',
      [req.params.id, req.user.property_id]
    );
    if (!order) return res.status(404).json({ success: false, error: 'Purchase order not found' });
    const received = await db.get(
      'SELECT COALESCE(SUM(received_quantity), 0) AS total FROM purchase_order_items WHERE purchase_order_id = ?',
      [order.id]
    );
    if (Number(received.total) > 0) {
      return res.status(409).json({ success: false, error: 'A purchase order with received goods cannot be cancelled' });
    }
    if (order.status === 'received') {
      return res.status(409).json({ success: false, error: 'A received purchase order cannot be cancelled' });
    }

    await db.run(
      "UPDATE purchase_orders SET status = 'cancelled' WHERE id = ? AND property_id = ?",
      [order.id, req.user.property_id]
    );
    await logAudit({
      propertyId: req.user.property_id, userId: req.user.id, action: 'CANCEL_PURCHASE_ORDER',
      entityType: 'purchase_order', entityId: order.id, details: { po_number: order.po_number }, req
    });
    res.json({ success: true, message: 'Purchase order cancelled' });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
