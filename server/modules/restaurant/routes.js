const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const { authenticateToken, requireRoles } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');
const { round2, recordPayment, recalcFolio } = require('../../services/billing');
const { nextDocumentNumber, insertDocument } = require('../../services/documents');
const { sendInvoicePdf } = require('../../services/pdf');
const { normalizePhone, whatsappUrl, formatMoney } = require('../../services/whatsapp');

const SERVICE_ROLES = ['admin', 'general_manager', 'front_desk', 'cashier', 'captain', 'waiter'];
const APPROVER_ROLES = ['admin', 'general_manager'];
const PAYMENT_METHODS = ['cash', 'card', 'upi', 'bank_transfer', 'netbanking'];
const PAYMENT_MODE_LABELS = { cash: 'Cash', card: 'Card', upi: 'UPI', bank_transfer: 'Bank transfer', netbanking: 'Net banking' };
const BOOKING_ACTIVE_STATUSES = ['pending', 'confirmed', 'seated'];
const STATIONS = ['kitchen', 'bar', 'bakery'];

function menuCode(name) {
  const base = String(name || 'ITEM').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 18) || 'ITEM';
  return `${base}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function validMenuPrice(value) {
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 && price <= 1000000;
}

function validTaxRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 && rate <= 28;
}

function idempotencyKey(req, body = {}) {
  return req.headers['idempotency-key'] || body.idempotency_key || null;
}

function normalizePaymentMode(value) {
  const mode = String(value || '').toLowerCase().trim();
  const aliases = {
    bank: 'bank_transfer', neft: 'bank_transfer', rtgs: 'bank_transfer', imps: 'bank_transfer',
    net_banking: 'netbanking', netbanking: 'netbanking', online: 'netbanking'
  };
  return aliases[mode] || mode;
}

function validBookingDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function validBookingTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}

async function validateMenuItems(conn, items) {
  if (!Array.isArray(items) || !items.length) throw new Error('Order must contain at least one item');
  const lines = [];
  for (const item of items) {
    const menuItem = await conn.get('SELECT * FROM menu_items WHERE id = ?', [item.menu_item_id]);
    if (!menuItem) throw new Error(`Menu item ${item.menu_item_id} not found`);
    if (menuItem.is_available === 0) throw new Error(`${menuItem.name} is currently unavailable`);
    const quantity = Number(item.quantity);
    if (!(quantity > 0)) throw new Error(`Invalid quantity for ${menuItem.name}`);

    // Prices and tax rates are authoritative on the server. A client cannot
    // reduce a charge by editing the request payload.
    const unitPrice = round2(menuItem.price);
    const taxRate = Number(menuItem.tax_rate || 5);
    const lineSub = round2(quantity * unitPrice);
    const lineTax = round2(lineSub * (taxRate / 100));
    const addons = Array.isArray(item.addons) ? item.addons : [];
    const addonTotal = round2(addons.reduce((sum, a) => sum + Number(a.price || 0), 0) * quantity);

    lines.push({
      menuItem,
      quantity,
      unitPrice,
      taxRate,
      lineSub: round2(lineSub + addonTotal),
      lineTax,
      total: round2(lineSub + addonTotal + lineTax),
      addonsJson: addons.length ? JSON.stringify(addons) : null,
      notes: item.notes || null
    });
  }
  return lines;
}

async function loadOrder(conn, orderId) {
  const order = await conn.get('SELECT * FROM restaurant_orders WHERE id = ?', [orderId]);
  if (!order) return null;
  order.items = await conn.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY created_at ASC', [orderId]);
  const table = order.table_id ? await conn.get('SELECT * FROM restaurant_tables WHERE id = ?', [order.table_id]) : null;
  const room = order.room_id ? await conn.get('SELECT * FROM rooms WHERE id = ?', [order.room_id]) : null;
  return { ...order, table, room };
}

function billPayload(order) {
  return {
    document_label: 'RESTAURANT BILL',
    is_tax_invoice: false,
    disclaimer: 'Restaurant bill. GST is charged on food and beverage service. Retain for your records.',
    order_number: order.order_number,
    bill_number: order.bill_number,
    order_type: order.order_type,
    table_number: order.table ? order.table.table_number : null,
    room_number: order.room ? order.room.room_number : null,
    items: order.items,
    subtotal: order.subtotal,
    tax_amount: order.tax_amount,
    total_amount: order.total_amount,
    payment_method: order.settlement_method,
    settled_at: order.settled_at
  };
}

// ---------------------------------------------------------------
// Tables / menu
// ---------------------------------------------------------------
router.get('/tables', authenticateToken, async (req, res) => {
  try {
    const tables = await db.all(
      `SELECT t.*, o.order_number, o.total_amount as current_order_total
       FROM restaurant_tables t
       LEFT JOIN restaurant_orders o ON t.current_order_id = o.id
       ORDER BY t.section ASC, t.table_number ASC`
    );
    res.json({ success: true, tables });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/menu', authenticateToken, async (req, res) => {
  try {
    const categories = await db.all(
      'SELECT * FROM menu_categories WHERE property_id = ? AND is_active = 1 ORDER BY display_order ASC, name ASC',
      [req.user.property_id]
    );
    const items = await db.all(
      'SELECT * FROM menu_items WHERE property_id = ? AND is_available = 1 ORDER BY name ASC',
      [req.user.property_id]
    );
    res.json({ success: true, categories, items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// Menu administration (categories and items)
// ---------------------------------------------------------------
router.get('/menu/manage', authenticateToken, requireRoles(...APPROVER_ROLES), async (req, res) => {
  try {
    const categories = await db.all(
      `SELECT c.*, (SELECT COUNT(*) FROM menu_items i WHERE i.category_id = c.id) AS item_count
       FROM menu_categories c WHERE c.property_id = ?
       ORDER BY c.display_order ASC, c.name ASC`,
      [req.user.property_id]
    );
    const items = await db.all(
      `SELECT i.*, c.name AS category_name
       FROM menu_items i JOIN menu_categories c ON i.category_id = c.id
       WHERE i.property_id = ? ORDER BY c.name ASC, i.name ASC`,
      [req.user.property_id]
    );
    res.json({ success: true, categories, items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/menu/categories', authenticateToken, requireRoles(...APPROVER_ROLES), async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'Category name is required' });
    const duplicate = await db.get(
      'SELECT id FROM menu_categories WHERE property_id = ? AND name = ? COLLATE NOCASE',
      [req.user.property_id, name]
    );
    if (duplicate) return res.status(409).json({ success: false, error: 'A menu category with this name already exists' });

    const id = uuidv4();
    await db.run(
      'INSERT INTO menu_categories (id, property_id, name, display_order, is_active) VALUES (?, ?, ?, ?, 1)',
      [id, req.user.property_id, name, Number(req.body.display_order) || 0]
    );
    await logAudit({
      propertyId: req.user.property_id, userId: req.user.id, action: 'CREATE_MENU_CATEGORY',
      entityType: 'menu_category', entityId: id, details: { name }, req
    });
    res.status(201).json({ success: true, message: 'Menu category created', id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/menu/categories/:id', authenticateToken, requireRoles(...APPROVER_ROLES), async (req, res) => {
  try {
    const category = await db.get('SELECT * FROM menu_categories WHERE id = ? AND property_id = ?', [req.params.id, req.user.property_id]);
    if (!category) return res.status(404).json({ success: false, error: 'Menu category not found' });
    const name = req.body.name !== undefined ? String(req.body.name).trim() : category.name;
    if (!name) return res.status(400).json({ success: false, error: 'Category name is required' });
    const duplicate = await db.get(
      'SELECT id FROM menu_categories WHERE property_id = ? AND name = ? COLLATE NOCASE AND id != ?',
      [req.user.property_id, name, category.id]
    );
    if (duplicate) return res.status(409).json({ success: false, error: 'A menu category with this name already exists' });

    await db.run(
      'UPDATE menu_categories SET name = ?, display_order = ?, is_active = ? WHERE id = ?',
      [
        name,
        req.body.display_order !== undefined ? Number(req.body.display_order) || 0 : category.display_order,
        req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : category.is_active,
        category.id
      ]
    );
    res.json({ success: true, message: 'Menu category updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/menu/categories/:id', authenticateToken, requireRoles(...APPROVER_ROLES), async (req, res) => {
  try {
    const category = await db.get('SELECT * FROM menu_categories WHERE id = ? AND property_id = ?', [req.params.id, req.user.property_id]);
    if (!category) return res.status(404).json({ success: false, error: 'Menu category not found' });
    const used = await db.get('SELECT COUNT(*) AS count FROM menu_items WHERE category_id = ?', [category.id]);
    if (Number(used.count) > 0) {
      return res.status(409).json({ success: false, error: 'Move or archive the items in this category before removing it' });
    }
    await db.run('UPDATE menu_categories SET is_active = 0 WHERE id = ?', [category.id]);
    res.json({ success: true, message: 'Menu category archived' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/menu/items', authenticateToken, requireRoles(...APPROVER_ROLES), async (req, res) => {
  try {
    const { category_id, name, description, price, unit, station, tax_rate, hsn_sac, is_veg, is_available, code } = req.body;
    if (!category_id) return res.status(400).json({ success: false, error: 'Menu category is required' });
    if (!String(name || '').trim()) return res.status(400).json({ success: false, error: 'Item name is required' });
    if (!validMenuPrice(price)) return res.status(400).json({ success: false, error: 'Price must be between 0 and 10,00,000' });
    if (tax_rate !== undefined && !validTaxRate(tax_rate)) return res.status(400).json({ success: false, error: 'GST rate must be between 0 and 28' });
    if (station && !STATIONS.includes(station)) return res.status(400).json({ success: false, error: 'Station must be kitchen, bar or bakery' });

    const category = await db.get('SELECT * FROM menu_categories WHERE id = ? AND property_id = ?', [category_id, req.user.property_id]);
    if (!category) return res.status(400).json({ success: false, error: 'Menu category not found' });
    const duplicate = await db.get(
      'SELECT id FROM menu_items WHERE property_id = ? AND name = ? COLLATE NOCASE',
      [req.user.property_id, String(name).trim()]
    );
    if (duplicate) return res.status(409).json({ success: false, error: 'A menu item with this name already exists' });

    const id = uuidv4();
    await db.run(
      `INSERT INTO menu_items
       (id, property_id, category_id, name, code, description, price, unit, station, tax_rate, hsn_sac, is_available, is_veg)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, req.user.property_id, category.id, String(name).trim(), String(code || '').trim() || menuCode(name),
        description || null, Number(price), unit || 'portion', station || 'kitchen',
        tax_rate !== undefined ? Number(tax_rate) : 5, hsn_sac || '996331',
        is_available === false ? 0 : 1, is_veg === false ? 0 : 1
      ]
    );
    await logAudit({
      propertyId: req.user.property_id, userId: req.user.id, action: 'CREATE_MENU_ITEM',
      entityType: 'menu_item', entityId: id, details: { name, price, category: category.name }, req
    });
    res.status(201).json({ success: true, message: 'Menu item created', id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/menu/items/:id', authenticateToken, requireRoles(...APPROVER_ROLES), async (req, res) => {
  try {
    const item = await db.get('SELECT * FROM menu_items WHERE id = ? AND property_id = ?', [req.params.id, req.user.property_id]);
    if (!item) return res.status(404).json({ success: false, error: 'Menu item not found' });

    const categoryId = req.body.category_id || item.category_id;
    const category = await db.get('SELECT * FROM menu_categories WHERE id = ? AND property_id = ?', [categoryId, req.user.property_id]);
    if (!category) return res.status(400).json({ success: false, error: 'Menu category not found' });

    const name = req.body.name !== undefined ? String(req.body.name).trim() : item.name;
    if (!name) return res.status(400).json({ success: false, error: 'Item name is required' });
    const price = req.body.price !== undefined ? Number(req.body.price) : item.price;
    if (!validMenuPrice(price)) return res.status(400).json({ success: false, error: 'Price must be between 0 and 10,00,000' });
    const taxRate = req.body.tax_rate !== undefined ? Number(req.body.tax_rate) : item.tax_rate;
    if (!validTaxRate(taxRate)) return res.status(400).json({ success: false, error: 'GST rate must be between 0 and 28' });
    const station = req.body.station || item.station;
    if (!STATIONS.includes(station)) return res.status(400).json({ success: false, error: 'Station must be kitchen, bar or bakery' });

    const duplicate = await db.get(
      'SELECT id FROM menu_items WHERE property_id = ? AND name = ? COLLATE NOCASE AND id != ?',
      [req.user.property_id, name, item.id]
    );
    if (duplicate) return res.status(409).json({ success: false, error: 'A menu item with this name already exists' });

    await db.run(
      `UPDATE menu_items SET category_id = ?, name = ?, description = ?, price = ?, unit = ?,
         station = ?, tax_rate = ?, hsn_sac = ?, is_available = ?, is_veg = ? WHERE id = ?`,
      [
        category.id, name, req.body.description !== undefined ? req.body.description : item.description,
        price, req.body.unit || item.unit, station, taxRate,
        req.body.hsn_sac !== undefined ? req.body.hsn_sac : item.hsn_sac,
        req.body.is_available !== undefined ? (req.body.is_available ? 1 : 0) : item.is_available,
        req.body.is_veg !== undefined ? (req.body.is_veg ? 1 : 0) : item.is_veg,
        item.id
      ]
    );
    res.json({ success: true, message: 'Menu item updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/menu/items/:id', authenticateToken, requireRoles(...APPROVER_ROLES), async (req, res) => {
  try {
    const item = await db.get('SELECT * FROM menu_items WHERE id = ? AND property_id = ?', [req.params.id, req.user.property_id]);
    if (!item) return res.status(404).json({ success: false, error: 'Menu item not found' });
    await db.run('UPDATE menu_items SET is_available = 0 WHERE id = ?', [item.id]);
    res.json({ success: true, message: 'Menu item archived. Past bills keep their original charge.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// Create order
// ---------------------------------------------------------------
router.post('/orders', authenticateToken, requireRoles(...SERVICE_ROLES), async (req, res) => {
  try {
    const { table_id, order_type = 'dine_in', room_id, stay_id: inputStayId, items, waiter_name, guest_name } = req.body;
    let stayId = inputStayId || null;
    const key = idempotencyKey(req, req.body);

    if (key) {
      const existing = await db.get(
        'SELECT * FROM restaurant_orders WHERE property_id = ? AND idempotency_key = ?',
        [req.user.property_id, key]
      );
      if (existing) {
        return res.json({
          success: true,
          duplicate: true,
          message: 'This order was already created.',
          orderId: existing.id,
          orderNumber: existing.order_number,
          totalAmount: existing.total_amount
        });
      }
    }

    const lines = await validateMenuItems(db, items);
    const subtotal = round2(lines.reduce((s, l) => s + l.lineSub, 0));
    const taxAmount = round2(lines.reduce((s, l) => s + l.lineTax, 0));
    const totalAmount = round2(subtotal + taxAmount);

    if (order_type === 'dine_in' && table_id) {
      const table = await db.get('SELECT * FROM restaurant_tables WHERE id = ?', [table_id]);
      if (!table) return res.status(404).json({ success: false, error: 'Table not found' });
      if (table.current_order_id) {
        return res.status(409).json({
          success: false,
          error: `Table ${table.table_number} already has an open order. Resume that order instead of creating a second one.`,
          open_order_id: table.current_order_id
        });
      }
    }
    if (room_id) {
      const stay = await db.get(
        "SELECT id FROM stays WHERE room_id = ? AND status = 'occupied' ORDER BY check_in_time DESC LIMIT 1",
        [room_id]
      );
      if (!stay) {
        return res.status(400).json({ success: false, error: 'No active in-house stay found for this room' });
      }
      if (!stayId) stayId = stay.id;
    }

    const orderId = uuidv4();
    const orderNo = `ORD-${Date.now().toString().slice(-6)}`;

    await db.transaction(async (conn) => {
      await conn.run(
        `INSERT INTO restaurant_orders
         (id, order_number, property_id, table_id, order_type, stay_id, room_id, status,
          subtotal, tax_amount, total_amount, waiter_name, guest_name, idempotency_key, payment_status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, 'unpaid', CURRENT_TIMESTAMP)`,
        [
          orderId, orderNo, req.user.property_id, table_id || null, order_type,
          stayId || null, room_id || null, subtotal, taxAmount, totalAmount,
          waiter_name || req.user.full_name, guest_name || null, key
        ]
      );

      for (const line of lines) {
        await conn.run(
          `INSERT INTO order_items
           (id, order_id, menu_item_id, item_name, quantity, unit_price, tax_rate, tax_amount,
            total_amount, status, notes, addons_json, kot_round)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, 0)`,
          [
            uuidv4(), orderId, line.menuItem.id, line.menuItem.name, line.quantity,
            line.unitPrice, line.taxRate, line.lineTax, line.total, line.notes, line.addonsJson
          ]
        );
      }

      if (table_id) {
        await conn.run(
          "UPDATE restaurant_tables SET status = 'occupied', current_order_id = ? WHERE id = ? AND current_order_id IS NULL",
          [orderId, table_id]
        );
      }
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'CREATE_RESTAURANT_ORDER',
      entityType: 'restaurant_order',
      entityId: orderId,
      details: { order_number: orderNo, order_type, total_amount: totalAmount, table_id, room_id },
      req
    });

    res.json({
      success: true,
      message: 'Order created successfully',
      orderId,
      orderNumber: orderNo,
      subtotal,
      taxAmount,
      totalAmount
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/orders/:id', authenticateToken, async (req, res) => {
  try {
    const order = await loadOrder(db, req.params.id);
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add a later round of items to an existing order.
router.post('/orders/:id/items', authenticateToken, requireRoles(...SERVICE_ROLES), async (req, res) => {
  try {
    const order = await db.get('SELECT * FROM restaurant_orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    if (['settled', 'posted_to_room', 'cancelled'].includes(order.status)) {
      return res.status(400).json({ success: false, error: `Cannot add items to a ${order.status} order` });
    }

    const lines = await validateMenuItems(db, req.body.items);
    const subtotal = round2(lines.reduce((s, l) => s + l.lineSub, 0));
    const taxAmount = round2(lines.reduce((s, l) => s + l.lineTax, 0));

    await db.transaction(async (conn) => {
      for (const line of lines) {
        await conn.run(
          `INSERT INTO order_items
           (id, order_id, menu_item_id, item_name, quantity, unit_price, tax_rate, tax_amount,
            total_amount, status, notes, addons_json, kot_round)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, 0)`,
          [
            uuidv4(), order.id, line.menuItem.id, line.menuItem.name, line.quantity,
            line.unitPrice, line.taxRate, line.lineTax, line.total, line.notes, line.addonsJson
          ]
        );
      }
      await conn.run(
        `UPDATE restaurant_orders SET subtotal = subtotal + ?, tax_amount = tax_amount + ?,
         total_amount = total_amount + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [subtotal, taxAmount, round2(subtotal + taxAmount), order.id]
      );
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'ADD_RESTAURANT_ORDER_ITEMS',
      entityType: 'restaurant_order',
      entityId: order.id,
      details: { added_total: round2(subtotal + taxAmount) },
      req
    });

    const updated = await loadOrder(db, order.id);
    res.json({ success: true, message: 'Items added. Send a new KOT round for the changed items.', order: updated });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// KOT rounds
// ---------------------------------------------------------------
router.post('/orders/:id/send-kitchen', authenticateToken, requireRoles(...SERVICE_ROLES), async (req, res) => {
  try {
    const { notes } = req.body;
    const order = await db.get('SELECT * FROM restaurant_orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    if (['settled', 'posted_to_room', 'cancelled'].includes(order.status)) {
      return res.status(400).json({ success: false, error: `Cannot send a KOT for a ${order.status} order` });
    }

    const newItems = await db.all(
      "SELECT * FROM order_items WHERE order_id = ? AND status = 'new' AND kot_id IS NULL",
      [order.id]
    );
    if (!newItems.length) {
      return res.status(400).json({ success: false, error: 'No new items to send. Previously sent items are not duplicated.' });
    }

    const station = req.body.station || newItems[0].station || 'kitchen';
    const roundRow = await db.get(
      'SELECT COALESCE(MAX(round_number), 0) AS round FROM kitchen_tickets WHERE order_id = ?',
      [order.id]
    );
    const round = Number(roundRow.round) + 1;
    const kotId = uuidv4();
    const kotNo = `KOT-${Date.now().toString().slice(-6)}`;

    await db.transaction(async (conn) => {
      await conn.run(
        `INSERT INTO kitchen_tickets
         (id, kot_number, order_id, table_id, room_id, station, status, round_number, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'preparing', ?, ?, ?)`,
        [kotId, kotNo, order.id, order.table_id, order.room_id, station, round, notes || null, req.user.id]
      );
      for (const item of newItems) {
        await conn.run(
          "UPDATE order_items SET status = 'preparing', kot_id = ?, kot_round = ? WHERE id = ?",
          [kotId, round, item.id]
        );
      }
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'SEND_KOT',
      entityType: 'kitchen_ticket',
      entityId: kotId,
      details: { kot_number: kotNo, round, item_count: newItems.length, station },
      req
    });

    res.json({
      success: true,
      message: `KOT round ${round} sent to ${station}`,
      kotNumber: kotNo,
      kotId,
      round,
      itemCount: newItems.length
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/kds', authenticateToken, async (req, res) => {
  try {
    const tickets = await db.all(
      `SELECT kt.*, t.table_number, r.room_number, o.order_number, o.order_type
       FROM kitchen_tickets kt
       JOIN restaurant_orders o ON kt.order_id = o.id
       LEFT JOIN restaurant_tables t ON kt.table_id = t.id
       LEFT JOIN rooms r ON kt.room_id = r.id
       WHERE kt.status IN ('new', 'preparing', 'ready')
       ORDER BY kt.created_at ASC`
    );
    for (const ticket of tickets) {
      ticket.items = await db.all('SELECT * FROM order_items WHERE kot_id = ?', [ticket.id]);
    }
    res.json({ success: true, tickets });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/kds/:id/status', authenticateToken, requireRoles(...SERVICE_ROLES, 'kitchen'), async (req, res) => {
  try {
    const { status } = req.body;
    if (!['preparing', 'ready', 'served'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid KOT status' });
    }
    const ticket = await db.get('SELECT * FROM kitchen_tickets WHERE id = ?', [req.params.id]);
    if (!ticket) return res.status(404).json({ success: false, error: 'KOT not found' });
    if (ticket.status === 'cancelled') {
      return res.status(400).json({ success: false, error: 'Cancelled KOTs cannot be progressed' });
    }
    await db.transaction(async (conn) => {
      await conn.run('UPDATE kitchen_tickets SET status = ? WHERE id = ?', [status, req.params.id]);
      await conn.run("UPDATE order_items SET status = ? WHERE kot_id = ? AND status != 'cancelled'", [status, req.params.id]);
    });
    res.json({ success: true, message: `KOT marked as ${status}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/kds/:id/cancel', authenticateToken, requireRoles(...APPROVER_ROLES), async (req, res) => {
  try {
    if (!req.body.reason) return res.status(400).json({ success: false, error: 'Cancellation reason is required' });
    const ticket = await db.get('SELECT * FROM kitchen_tickets WHERE id = ?', [req.params.id]);
    if (!ticket) return res.status(404).json({ success: false, error: 'KOT not found' });
    if (ticket.status === 'cancelled') return res.status(400).json({ success: false, error: 'KOT is already cancelled' });

    await db.transaction(async (conn) => {
      await conn.run(
        "UPDATE kitchen_tickets SET status = 'cancelled', cancel_reason = ? WHERE id = ?",
        [req.body.reason, ticket.id]
      );
      await conn.run(
        "UPDATE order_items SET status = 'cancelled' WHERE kot_id = ? AND status != 'served'",
        [ticket.id]
      );
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'CANCEL_KOT',
      entityType: 'kitchen_ticket',
      entityId: ticket.id,
      details: { reason: req.body.reason, kot_number: ticket.kot_number },
      req
    });

    res.json({ success: true, message: 'KOT cancelled with an audit record' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/kds/:id/reprint', authenticateToken, requireRoles(...SERVICE_ROLES, 'kitchen'), async (req, res) => {
  try {
    const ticket = await db.get('SELECT * FROM kitchen_tickets WHERE id = ?', [req.params.id]);
    if (!ticket) return res.status(404).json({ success: false, error: 'KOT not found' });
    await db.run(
      'UPDATE kitchen_tickets SET print_count = print_count + 1, printed_at = CURRENT_TIMESTAMP WHERE id = ?',
      [ticket.id]
    );
    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'REPRINT_KOT',
      entityType: 'kitchen_ticket',
      entityId: ticket.id,
      details: { kot_number: ticket.kot_number, print_count: Number(ticket.print_count || 0) + 1 },
      req
    });
    const updated = await db.get('SELECT * FROM kitchen_tickets WHERE id = ?', [ticket.id]);
    res.json({ success: true, message: 'KOT marked as reprinted', ticket: updated, reprint: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// Independent restaurant bill settlement
// ---------------------------------------------------------------
router.post('/orders/:id/settle', authenticateToken, requireRoles(...SERVICE_ROLES), async (req, res) => {
  try {
    const payment_method = normalizePaymentMode(req.body.payment_method || 'cash');
    if (!PAYMENT_METHODS.includes(payment_method)) {
      return res.status(400).json({ success: false, error: `Unsupported payment method. Use one of: ${PAYMENT_METHODS.join(', ')}` });
    }
    const order = await loadOrder(db, req.params.id);
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    if (order.status === 'settled' || order.status === 'posted_to_room') {
      return res.status(400).json({
        success: false,
        error: `Order is already ${order.status.replace(/_/g, ' ')}. It cannot be charged again.`
      });
    }
    if (order.status === 'cancelled') {
      return res.status(400).json({ success: false, error: 'Cancelled orders cannot be settled' });
    }

    const key = idempotencyKey(req, req.body);
    const duplicate = key ? await db.get(
      'SELECT * FROM restaurant_orders WHERE property_id = ? AND idempotency_key = ? AND status = ?',
      [req.user.property_id, key, 'settled']
    ) : null;
    if (duplicate) {
      return res.json({
        success: true,
        duplicate: true,
        message: 'This bill was already settled.',
        billNumber: duplicate.bill_number,
        totalAmount: duplicate.total_amount
      });
    }

    const result = await db.transaction(async (conn) => {
      const fresh = await conn.get('SELECT * FROM restaurant_orders WHERE id = ?', [order.id]);
      if (fresh.status !== 'active') throw new Error(`Order is already ${fresh.status.replace(/_/g, ' ')}`);

      const billNo = await nextDocumentNumber(conn, req.user.property_id, 'restaurant_bill', { prefix: 'REST-BILL' });
      await conn.run(
        `UPDATE restaurant_orders
         SET status = 'settled', settlement_method = ?, settled_at = CURRENT_TIMESTAMP,
             bill_number = ?, payment_status = 'paid', updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [payment_method, billNo, order.id]
      );

      const receipt = await recordPayment(conn, {
        propertyId: req.user.property_id,
        restaurantOrderId: order.id,
        amount: order.total_amount,
        paymentMethod: payment_method,
        paymentType: 'settlement',
        cashierId: req.user.id,
        notes: `Restaurant Bill ${billNo} for Order ${order.order_number}`,
        idempotencyKey: key ? `${key}:settle` : null,
        device: req.headers['user-agent'] || null,
        receiptType: 'payment_receipt',
        receiptPayload: {
          document_label: 'PAYMENT RECEIPT',
          is_tax_invoice: false,
          disclaimer: 'Acknowledges payment of the restaurant bill. Not a hotel tax invoice.',
          bill_number: billNo,
          order_number: order.order_number,
          amount: order.total_amount,
          payment_method,
          received_at: new Date().toISOString()
        }
      });

      const billDocId = await insertDocument(conn, {
        propertyId: req.user.property_id,
        documentType: 'restaurant_bill',
        documentNumber: billNo,
        payload: { ...billPayload({ ...order, bill_number: billNo, settlement_method: payment_method }), receipt_number: receipt.payment.receipt_number },
        totalAmount: order.total_amount,
        issuedBy: req.user.id
      });

      if (order.table_id) {
        await conn.run(
          "UPDATE restaurant_tables SET status = 'available', current_order_id = NULL WHERE id = ? AND current_order_id = ?",
          [order.table_id, order.id]
        );
      }

      const shift = await conn.get(
        "SELECT id FROM cashier_shifts WHERE user_id = ? AND status = 'open' LIMIT 1",
        [req.user.id]
      );
      if (shift) {
        let field = 'total_cash';
        if (payment_method === 'card') field = 'total_card';
        else if (payment_method === 'upi') field = 'total_upi';
        else if (payment_method === 'bank_transfer') field = 'total_upi';
        await conn.run(`UPDATE cashier_shifts SET ${field} = ${field} + ? WHERE id = ?`, [order.total_amount, shift.id]);
      }

      return { billNo, receipt, billDocId };
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'SETTLE_RESTAURANT_ORDER',
      entityType: 'restaurant_order',
      entityId: order.id,
      details: {
        billNo: result.billNo,
        amount: order.total_amount,
        payment_method,
        receipt_number: result.receipt.payment.receipt_number
      },
      req
    });

    res.json({
      success: true,
      message: 'Restaurant bill settled successfully',
      orderId: order.id,
      billNumber: result.billNo,
      receiptNumber: result.receipt.payment.receipt_number,
      totalAmount: order.total_amount
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// Restaurant bill document (JSON + downloadable PDF)
// ---------------------------------------------------------------
async function restaurantBillPayload(orderId, propertyId) {
  const order = await loadOrder(db, orderId);
  if (!order) return null;
  if (!order.bill_number) {
    const err = new Error(
      order.status === 'posted_to_room'
        ? 'This order was posted to a room folio. Download the guest tax invoice instead.'
        : 'Settle the restaurant order before downloading its bill.'
    );
    err.status = 409;
    throw err;
  }
  const property = await db.get(
    `SELECT name, address, city, state, gstin, phone, email, currency_symbol, logo_url,
            bank_name, bank_account_number, bank_ifsc, upi_id, phone_country_code
     FROM properties WHERE id = ?`,
    [propertyId]
  );
  const payload = billPayload(order);
  return {
    ...payload,
    id: order.id,
    is_restaurant_bill: true,
    date: order.settled_at,
    customer: { name: order.guest_name || 'Walk-in Guest' },
    property: property || { name: 'Hotel' },
    subtotal: order.subtotal,
    total_tax: order.tax_amount,
    grand_total: order.total_amount,
    paid_amount: order.total_amount,
    balance_due: 0
  };
}

router.get('/orders/:id/bill', authenticateToken, requireRoles(...SERVICE_ROLES), async (req, res) => {
  try {
    const bill = await restaurantBillPayload(req.params.id, req.user.property_id);
    if (!bill) return res.status(404).json({ success: false, error: 'Restaurant order not found' });
    res.json({ success: true, bill });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

router.get('/orders/:id/bill/pdf', authenticateToken, requireRoles(...SERVICE_ROLES), async (req, res) => {
  try {
    const bill = await restaurantBillPayload(req.params.id, req.user.property_id);
    if (!bill) return res.status(404).json({ success: false, error: 'Restaurant order not found' });
    await sendInvoicePdf(res, bill, `${bill.bill_number}.pdf`);
  } catch (err) {
    if (!res.headersSent) res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/restaurant/orders/:id/whatsapp — pre-filled share message
router.get('/orders/:id/whatsapp', authenticateToken, requireRoles(...SERVICE_ROLES), async (req, res) => {
  try {
    const bill = await restaurantBillPayload(req.params.id, req.user.property_id);
    if (!bill) return res.status(404).json({ success: false, error: 'Restaurant order not found' });
    const property = await db.get(
      'SELECT name, phone, upi_id, phone_country_code FROM properties WHERE id = ?',
      [req.user.property_id]
    );
    const phone = normalizePhone(req.query.phone, property ? property.phone_country_code : '91');
    if (!phone) {
      return res.status(400).json({ success: false, error: 'Enter a valid guest phone number with country code' });
    }

    const lines = [
      `*${property ? property.name : 'Restaurant'}*`,
      `Restaurant Bill - ${bill.bill_number}`,
      `Order: ${bill.order_number}`,
      bill.table_number ? `Table: ${bill.table_number}` : null,
      `Total: ${formatMoney(bill.grand_total)}`,
      `Payment: ${PAYMENT_MODE_LABELS[normalizePaymentMode(bill.payment_method)] || bill.payment_method || 'paid'}`
    ].filter(Boolean);
    if (property && property.upi_id) lines.push(`Pay by UPI: ${property.upi_id}`);
    if (property && property.phone) lines.push(`Contact: ${property.phone}`);
    lines.push('', 'Your PDF bill is attached. Thank you for dining with us.');

    const message = lines.join('\n');
    res.json({ success: true, phone, message, url: whatsappUrl(phone, message) });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// Post an order to an active guest folio (exactly once)
// ---------------------------------------------------------------
router.post('/orders/:id/post-to-room', authenticateToken, requireRoles(...SERVICE_ROLES), async (req, res) => {
  try {
    const order = await loadOrder(db, req.params.id);
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    if (order.status === 'settled' || order.status === 'posted_to_room') {
      return res.status(400).json({
        success: false,
        error: `Order is already ${order.status.replace(/_/g, ' ')}. It cannot be posted again.`
      });
    }
    if (order.status === 'cancelled') {
      return res.status(400).json({ success: false, error: 'Cancelled orders cannot be posted' });
    }

    const targetRoomId = req.body.room_id || order.room_id;
    if (!targetRoomId) {
      return res.status(400).json({ success: false, error: 'Target room ID is required to post to room' });
    }

    const result = await db.transaction(async (conn) => {
      const stay = await conn.get(
        `SELECT s.*, r.room_number, f.id as folio_id, f.status AS folio_status
         FROM stays s
         JOIN rooms r ON s.room_id = r.id
         JOIN folios f ON f.stay_id = s.id
         WHERE s.room_id = ? AND s.status = 'occupied'
         ORDER BY s.check_in_time DESC LIMIT 1`,
        [targetRoomId]
      );

      if (!stay || !stay.folio_id) {
        throw new Error('Cannot post to room: No active occupied stay or folio found for this room.');
      }
      if (stay.folio_status === 'closed') {
        throw new Error('Cannot post to room: the guest folio is closed.');
      }

      const alreadyPosted = await conn.get(
        `SELECT id FROM folio_entries
         WHERE folio_id = ? AND reference_type = 'restaurant_order' AND reference_id = ?`,
        [stay.folio_id, order.id]
      );
      if (alreadyPosted) {
        throw new Error('This restaurant order has already been posted to the room folio.');
      }

      const fresh = await conn.get('SELECT * FROM restaurant_orders WHERE id = ?', [order.id]);
      if (fresh.status !== 'active') throw new Error(`Order is already ${fresh.status.replace(/_/g, ' ')}`);

      const taxRate = fresh.subtotal > 0
        ? round2((Number(fresh.tax_amount) / Number(fresh.subtotal)) * 100)
        : 5;
      const entryId = uuidv4();
      await conn.run(
        `INSERT INTO folio_entries
         (id, folio_id, date, department, description, quantity, unit_price, tax_rate, tax_amount,
          total_amount, reference_id, reference_type, created_by, idempotency_key)
         VALUES (?, ?, date('now'), ?, ?, 1, ?, ?, ?, ?, ?, 'restaurant_order', ?, ?)`,
        [
          entryId, stay.folio_id,
          fresh.order_type === 'room_service' ? 'room_service' : 'restaurant',
          `Restaurant Order ${fresh.order_number} (${fresh.order_type.replace(/_/g, ' ')})`,
          fresh.subtotal, taxRate, fresh.tax_amount, fresh.total_amount,
          order.id, req.user.id, `restaurant-order:${order.id}`
        ]
      );

      await recalcFolio(conn, stay.folio_id);

      await conn.run(
        `UPDATE restaurant_orders
         SET status = 'posted_to_room', settlement_method = 'room_folio', stay_id = ?,
             room_id = ?, posted_folio_id = ?, payment_status = 'posted_to_room',
             settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [stay.id, targetRoomId, stay.folio_id, order.id]
      );

      if (order.table_id) {
        await conn.run(
          "UPDATE restaurant_tables SET status = 'available', current_order_id = NULL WHERE id = ? AND current_order_id = ?",
          [order.table_id, order.id]
        );
      }

      const shift = await conn.get(
        "SELECT id FROM cashier_shifts WHERE user_id = ? AND status = 'open' LIMIT 1",
        [req.user.id]
      );
      if (shift) {
        await conn.run(
          'UPDATE cashier_shifts SET total_room_postings = total_room_postings + ? WHERE id = ?',
          [fresh.total_amount, shift.id]
        );
      }

      return { stay, entryId };
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'POST_RESTAURANT_TO_ROOM',
      entityType: 'restaurant_order',
      entityId: order.id,
      details: {
        room_number: result.stay.room_number,
        stay_id: result.stay.id,
        folio_id: result.stay.folio_id,
        amount: order.total_amount
      },
      req
    });

    res.json({
      success: true,
      message: `Posted ₹${order.total_amount} to Room ${result.stay.room_number} folio.`,
      roomNumber: result.stay.room_number,
      folioId: result.stay.folio_id,
      folioEntryId: result.entryId
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// Restaurant reconciliation: separate payment vs room posting
// ---------------------------------------------------------------
router.get('/reconciliation', authenticateToken, async (req, res) => {
  try {
    const from = req.query.from || '1900-01-01';
    const to = req.query.to || '2999-12-31';
    const orders = await db.all(
      `SELECT o.id, o.order_number, o.order_type, o.status, o.payment_status, o.bill_number,
              o.subtotal, o.tax_amount, o.total_amount, o.settlement_method, o.settled_at,
              o.posted_folio_id, r.room_number, t.table_number, f.folio_number
       FROM restaurant_orders o
       LEFT JOIN rooms r ON o.room_id = r.id
       LEFT JOIN restaurant_tables t ON o.table_id = t.id
       LEFT JOIN folios f ON o.posted_folio_id = f.id
       WHERE o.status IN ('settled','posted_to_room')
         AND date(COALESCE(o.settled_at, o.created_at)) BETWEEN date(?) AND date(?)
       ORDER BY o.settled_at DESC`,
      [from, to]
    );

    const separate = orders.filter(o => o.status === 'settled');
    const posted = orders.filter(o => o.status === 'posted_to_room');

    res.json({
      success: true,
      from,
      to,
      summary: {
        separate_bills_count: separate.length,
        separate_bills_total: round2(separate.reduce((s, o) => s + Number(o.total_amount || 0), 0)),
        room_posted_count: posted.length,
        room_posted_total: round2(posted.reduce((s, o) => s + Number(o.total_amount || 0), 0))
      },
      separate_bills: separate,
      room_posted_orders: posted
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// Restaurant table advance bookings
// A booking captures the guest, slot, table, advance amount and payment mode.
// The advance is posted as a real payment/receipt; only then is the booking
// shown as confirmed. Cancelling releases the table and can refund the advance
// through the approver-only refund ledger.
// ---------------------------------------------------------------
async function loadRestaurantBooking(bookingId, propertyId) {
  return db.get(
    `SELECT b.*, t.table_number, t.section, t.capacity,
            p.name AS property_name, p.phone AS property_phone, p.upi_id,
            p.address AS property_address, p.city AS property_city, p.state AS property_state,
            p.gstin AS property_gstin, p.email AS property_email, p.currency_symbol,
            p.logo_url, p.phone_country_code
     FROM restaurant_bookings b
     LEFT JOIN restaurant_tables t ON b.table_id = t.id
     JOIN properties p ON b.property_id = p.id
     WHERE b.id = ? AND b.property_id = ?`,
    [bookingId, propertyId]
  );
}

async function bookingAdvancePaid(conn, bookingId) {
  const paid = await conn.get(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM payments
     WHERE restaurant_booking_id = ? AND COALESCE(status, 'posted') = 'posted'`,
    [bookingId]
  );
  const refunded = await conn.get(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM payment_refunds WHERE restaurant_booking_id = ?',
    [bookingId]
  ).catch(() => ({ total: 0 }));
  return {
    paid: round2(paid.total),
    refunded: round2(refunded.total),
    net: round2(Number(paid.total) - Number(refunded.total))
  };
}

function bookingWhatsappMessage(booking, netAdvance) {
  const lines = [
    `*${booking.property_name}*`,
    `Table Booking - ${booking.booking_number}`,
    `Guest: ${booking.guest_name}`,
    `Date: ${booking.booking_date} at ${String(booking.booking_time).slice(0, 5)}`,
    `Guests: ${booking.guest_count}${booking.table_number ? ` | Table: ${booking.table_number}` : ''}`,
    `Status: ${String(booking.status).replace(/_/g, ' ')}`
  ];
  if (netAdvance > 0) {
    lines.push(`Advance paid: ${formatMoney(netAdvance)} (${PAYMENT_MODE_LABELS[booking.payment_mode] || booking.payment_mode || 'paid'})`);
  }
  if (booking.upi_id) lines.push(`Pay by UPI: ${booking.upi_id}`);
  if (booking.property_phone) lines.push(`Hotel contact: ${booking.property_phone}`);
  lines.push('', 'We look forward to serving you.');
  return lines.join('\n');
}

router.get('/bookings', authenticateToken, requireRoles(...SERVICE_ROLES), async (req, res) => {
  try {
    const where = ['b.property_id = ?'];
    const params = [req.user.property_id];
    if (req.query.date) { where.push('date(b.booking_date) = date(?)'); params.push(req.query.date); }
    if (req.query.status) { where.push('b.status = ?'); params.push(req.query.status); }
    if (req.query.search) {
      where.push('(b.guest_name LIKE ? OR b.guest_phone LIKE ? OR b.booking_number LIKE ?)');
      const s = `%${req.query.search}%`;
      params.push(s, s, s);
    }

    const bookings = await db.all(
      `SELECT b.*, t.table_number, t.section,
              (SELECT COALESCE(SUM(p.amount), 0) FROM payments p
               WHERE p.restaurant_booking_id = b.id AND COALESCE(p.status, 'posted') = 'posted') AS advance_paid
       FROM restaurant_bookings b
       LEFT JOIN restaurant_tables t ON b.table_id = t.id
       WHERE ${where.join(' AND ')}
       ORDER BY date(b.booking_date) ASC, time(b.booking_time) ASC`,
      params
    );

    res.json({
      success: true,
      bookings,
      payment_modes: PAYMENT_MODES.map(value => ({ value, label: PAYMENT_MODE_LABELS[value] || value })),
      summary: {
        pending: bookings.filter(b => b.status === 'pending').length,
        confirmed: bookings.filter(b => b.status === 'confirmed').length,
        seated: bookings.filter(b => b.status === 'seated').length
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/bookings', authenticateToken, requireRoles(...SERVICE_ROLES), async (req, res) => {
  try {
    const guestName = String(req.body.guest_name || '').trim();
    const guestPhone = String(req.body.guest_phone || '').trim();
    const bookingDate = String(req.body.booking_date || '');
    const bookingTime = String(req.body.booking_time || '');
    const guestCount = Number(req.body.guest_count) || 2;
    const advance = round2(req.body.advance_amount);
    const paymentMode = normalizePaymentMode(req.body.payment_mode);
    const key = idempotencyKey(req, req.body);

    if (!guestName) return res.status(400).json({ success: false, error: 'Guest name is required' });
    if (!normalizePhone(guestPhone)) {
      return res.status(400).json({ success: false, error: 'A valid guest phone number is required' });
    }
    if (!validBookingDate(bookingDate)) {
      return res.status(400).json({ success: false, error: 'Booking date must be YYYY-MM-DD' });
    }
    if (!validBookingTime(bookingTime)) {
      return res.status(400).json({ success: false, error: 'Booking time must be HH:MM (24-hour)' });
    }
    if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > 100) {
      return res.status(400).json({ success: false, error: 'Guest count must be between 1 and 100' });
    }
    if (advance < 0) return res.status(400).json({ success: false, error: 'Advance amount cannot be negative' });
    if (advance > 0 && !PAYMENT_METHODS.includes(paymentMode)) {
      return res.status(400).json({ success: false, error: `Choose a valid payment mode: ${PAYMENT_MODES_LABEL_TEXT()}` });
    }

    if (key) {
      const existing = await db.get(
        'SELECT * FROM restaurant_bookings WHERE property_id = ? AND idempotency_key = ?',
        [req.user.property_id, key]
      );
      if (existing) {
        return res.json({
          success: true,
          duplicate: true,
          message: 'This booking was already created.',
          booking: existing
        });
      }
    }

    const property = await db.get('SELECT name FROM properties WHERE id = ?', [req.user.property_id]);

    const result = await db.transaction(async (conn) => {
      let table = null;
      if (req.body.table_id) {
        table = await conn.get(
          'SELECT * FROM restaurant_tables WHERE id = ? AND property_id = ?',
          [req.body.table_id, req.user.property_id]
        );
        if (!table) throw new Error('Selected table was not found');
        const clash = await conn.get(
          `SELECT booking_number FROM restaurant_bookings
           WHERE property_id = ? AND table_id = ? AND booking_date = ?
             AND status IN ('pending','confirmed','seated') AND time(booking_time) = time(?)`,
          [req.user.property_id, table.id, bookingDate, bookingTime]
        );
        if (clash) throw new Error(`Table ${table.table_number} already has booking ${clash.booking_number} at this time`);
      }

      const bookingId = uuidv4();
      const bookingNumber = await nextDocumentNumber(conn, req.user.property_id, 'restaurant_booking');
      const status = advance > 0 ? 'confirmed' : 'pending';

      await conn.run(
        `INSERT INTO restaurant_bookings
         (id, property_id, booking_number, guest_name, guest_phone, guest_email, booking_date,
          booking_time, guest_count, table_id, advance_amount, payment_mode, transaction_ref,
          idempotency_key, status, notes, confirmed_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          bookingId, req.user.property_id, bookingNumber, guestName, guestPhone,
          req.body.guest_email || null, bookingDate, bookingTime, guestCount,
          table ? table.id : null, advance, advance > 0 ? paymentMode : null,
          req.body.transaction_ref || null, key, status, req.body.notes || null,
          status === 'confirmed' ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null,
          req.user.id
        ]
      );

      let receipt = null;
      if (advance > 0) {
        const receiptResult = await recordPayment(conn, {
          propertyId: req.user.property_id,
          restaurantBookingId: bookingId,
          amount: advance,
          paymentMethod: paymentMode,
          paymentType: 'advance_deposit',
          cashierId: req.user.id,
          transactionRef: req.body.transaction_ref || null,
          notes: `Restaurant booking ${bookingNumber} advance`,
          idempotencyKey: key ? `${key}:advance` : null,
          device: req.headers['user-agent'] || null,
          receiptType: 'advance_receipt',
          receiptPayload: {
            document_label: 'RESTAURANT BOOKING ADVANCE RECEIPT',
            is_tax_invoice: false,
            disclaimer: 'Acknowledges the advance received for a restaurant table booking. It is not a tax invoice.',
            booking_number: bookingNumber,
            guest_name: guestName,
            booking_date: bookingDate,
            booking_time: bookingTime,
            guest_count: guestCount,
            table_number: table ? table.table_number : null,
            property_name: property ? property.name : 'Hotel',
            amount: advance,
            payment_method: paymentMode,
            received_at: new Date().toISOString()
          }
        });
        receipt = receiptResult.payment;
        await conn.run('UPDATE restaurant_bookings SET payment_id = ? WHERE id = ?', [receipt.id, bookingId]);
      }

      if (table && advance > 0 && bookingDate === new Date().toISOString().slice(0, 10) && table.status === 'available') {
        await conn.run("UPDATE restaurant_tables SET status = 'reserved' WHERE id = ?", [table.id]);
      }

      return { bookingId, bookingNumber, status, receipt };
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'CREATE_RESTAURANT_BOOKING',
      entityType: 'restaurant_booking',
      entityId: result.bookingId,
      details: {
        booking_number: result.bookingNumber,
        booking_date: bookingDate,
        booking_time: bookingTime,
        guest_count: guestCount,
        advance,
        payment_mode: paymentMode,
        status: result.status
      },
      req
    });

    const booking = await loadRestaurantBooking(result.bookingId, req.user.property_id);
    res.status(201).json({
      success: true,
      message: result.status === 'confirmed'
        ? `Booking ${result.bookingNumber} confirmed with advance`
        : `Booking ${result.bookingNumber} saved. Record an advance to confirm it.`,
      booking,
      receipt: result.receipt || null
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Record an additional/late advance and confirm a pending booking.
router.post('/bookings/:id/advance', authenticateToken, requireRoles(...SERVICE_ROLES), async (req, res) => {
  try {
    const booking = await db.get(
      'SELECT * FROM restaurant_bookings WHERE id = ? AND property_id = ?',
      [req.params.id, req.user.property_id]
    );
    if (!booking) return res.status(404).json({ success: false, error: 'Booking not found' });
    if (!BOOKING_ACTIVE_STATUSES.includes(booking.status)) {
      return res.status(400).json({ success: false, error: `Cannot add an advance to a ${booking.status} booking` });
    }

    const amount = round2(req.body.amount);
    const mode = normalizePaymentMode(req.body.payment_mode);
    if (!(amount > 0)) return res.status(400).json({ success: false, error: 'A valid advance amount is required' });
    if (!PAYMENT_METHODS.includes(mode)) {
      return res.status(400).json({ success: false, error: `Choose a valid payment mode: ${PAYMENT_MODES_LABEL_TEXT()}` });
    }

    const result = await db.transaction(async (conn) => {
      const receiptResult = await recordPayment(conn, {
        propertyId: req.user.property_id,
        restaurantBookingId: booking.id,
        amount,
        paymentMethod: mode,
        paymentType: 'advance_deposit',
        cashierId: req.user.id,
        transactionRef: req.body.transaction_ref || null,
        notes: `Restaurant booking ${booking.booking_number} advance`,
        idempotencyKey: idempotencyKey(req, req.body),
        receiptType: 'advance_receipt',
        receiptPayload: {
          document_label: 'RESTAURANT BOOKING ADVANCE RECEIPT',
          is_tax_invoice: false,
          disclaimer: 'Acknowledges the advance received for a restaurant table booking. It is not a tax invoice.',
          booking_number: booking.booking_number,
          guest_name: booking.guest_name,
          amount,
          payment_method: mode,
          received_at: new Date().toISOString()
        }
      });
      await conn.run(
        `UPDATE restaurant_bookings
         SET advance_amount = advance_amount + ?, payment_mode = ?,
             status = CASE WHEN status = 'pending' THEN 'confirmed' ELSE status END,
             confirmed_at = COALESCE(confirmed_at, CURRENT_TIMESTAMP), payment_id = ?
         WHERE id = ?`,
        [amount, mode, receiptResult.payment.id, booking.id]
      );
      if (booking.table_id) {
        await conn.run(
          "UPDATE restaurant_tables SET status = 'reserved' WHERE id = ? AND status = 'available' AND ? = date('now')",
          [booking.table_id, booking.booking_date]
        );
      }
      const updated = await conn.get('SELECT * FROM restaurant_bookings WHERE id = ?', [booking.id]);
      return { updated, receipt: receiptResult.payment };
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'RECORD_RESTAURANT_BOOKING_ADVANCE',
      entityType: 'restaurant_booking',
      entityId: booking.id,
      details: { amount, payment_mode: mode, booking_number: booking.booking_number },
      req
    });

    res.json({
      success: true,
      message: `Advance recorded. Booking ${booking.booking_number} is confirmed.`,
      booking: result.updated,
      receipt: result.receipt
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/bookings/:id/cancel', authenticateToken, requireRoles(...SERVICE_ROLES), async (req, res) => {
  try {
    if (!req.body.reason) return res.status(400).json({ success: false, error: 'Cancellation reason is required' });
    const booking = await db.get(
      'SELECT * FROM restaurant_bookings WHERE id = ? AND property_id = ?',
      [req.params.id, req.user.property_id]
    );
    if (!booking) return res.status(404).json({ success: false, error: 'Booking not found' });
    if (['cancelled', 'completed'].includes(booking.status)) {
      return res.status(400).json({ success: false, error: `Booking is already ${booking.status}` });
    }

    const refundAmount = round2(req.body.refund_amount);
    if (refundAmount > 0 && !APPROVER_ROLES.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Only an administrator or general manager can refund a booking advance' });
    }

    const result = await db.transaction(async (conn) => {
      let refund = null;
      if (refundAmount > 0) {
        const paid = await bookingAdvancePaid(conn, booking.id);
        if (refundAmount > paid.net + 0.004) {
          throw new Error(`Refund exceeds the net advance received (${paid.net})`);
        }
        const refundNo = await nextDocumentNumber(conn, req.user.property_id, 'credit_note');
        const refundId = uuidv4();
        await conn.run(
          `INSERT INTO payment_refunds
           (id, receipt_number, property_id, payment_id, restaurant_booking_id, amount,
            refund_method, reason, transaction_ref, approved_by, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            refundId, refundNo, req.user.property_id, booking.payment_id || null, booking.id,
            refundAmount, normalizePaymentMode(req.body.refund_method || booking.payment_mode || 'cash'),
            `Restaurant booking ${booking.booking_number}: ${req.body.reason}`,
            req.body.transaction_ref || null, req.user.id, req.user.id
          ]
        );
        await insertDocument(conn, {
          propertyId: req.user.property_id,
          documentType: 'credit_note',
          documentNumber: refundNo,
          payload: {
            document_label: 'RESTAURANT BOOKING REFUND / CREDIT NOTE',
            is_tax_invoice: false,
            booking_number: booking.booking_number,
            guest_name: booking.guest_name,
            amount: refundAmount,
            reason: req.body.reason,
            issued_at: new Date().toISOString()
          },
          totalAmount: refundAmount,
          issuedBy: req.user.id
        });
        refund = { id: refundId, receipt_number: refundNo, amount: refundAmount };
      }

      await conn.run(
        "UPDATE restaurant_bookings SET status = 'cancelled', cancel_reason = ?, cancelled_at = CURRENT_TIMESTAMP WHERE id = ?",
        [req.body.reason, booking.id]
      );
      if (booking.table_id) {
        await conn.run(
          "UPDATE restaurant_tables SET status = 'available' WHERE id = ? AND status = 'reserved' AND current_order_id IS NULL",
          [booking.table_id]
        );
      }
      return { refund };
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'CANCEL_RESTAURANT_BOOKING',
      entityType: 'restaurant_booking',
      entityId: booking.id,
      details: { booking_number: booking.booking_number, reason: req.body.reason, refund: result.refund },
      req
    });

    res.json({
      success: true,
      message: 'Restaurant booking cancelled',
      refund: result.refund
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/bookings/:id/seat', authenticateToken, requireRoles(...SERVICE_ROLES), async (req, res) => {
  try {
    const booking = await db.get(
      'SELECT * FROM restaurant_bookings WHERE id = ? AND property_id = ?',
      [req.params.id, req.user.property_id]
    );
    if (!booking) return res.status(404).json({ success: false, error: 'Booking not found' });
    if (['cancelled', 'completed', 'no_show'].includes(booking.status)) {
      return res.status(400).json({ success: false, error: `Cannot seat a ${booking.status} booking` });
    }

    const tableId = req.body.table_id || booking.table_id;
    if (tableId) {
      const table = await db.get(
        'SELECT * FROM restaurant_tables WHERE id = ? AND property_id = ?',
        [tableId, req.user.property_id]
      );
      if (!table) return res.status(400).json({ success: false, error: 'Table not found' });
    }

    await db.run(
      "UPDATE restaurant_bookings SET status = 'seated', table_id = COALESCE(?, table_id) WHERE id = ?",
      [tableId || null, booking.id]
    );

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'SEAT_RESTAURANT_BOOKING',
      entityType: 'restaurant_booking',
      entityId: booking.id,
      details: { booking_number: booking.booking_number, table_id: tableId || null },
      req
    });

    res.json({ success: true, message: 'Guest marked as seated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/bookings/:id/complete', authenticateToken, requireRoles(...SERVICE_ROLES), async (req, res) => {
  try {
    const booking = await db.get(
      'SELECT * FROM restaurant_bookings WHERE id = ? AND property_id = ?',
      [req.params.id, req.user.property_id]
    );
    if (!booking) return res.status(404).json({ success: false, error: 'Booking not found' });

    await db.transaction(async (conn) => {
      await conn.run("UPDATE restaurant_bookings SET status = 'completed' WHERE id = ?", [booking.id]);
      if (booking.table_id) {
        await conn.run(
          "UPDATE restaurant_tables SET status = 'available' WHERE id = ? AND status = 'reserved' AND current_order_id IS NULL",
          [booking.table_id]
        );
      }
    });

    res.json({ success: true, message: 'Booking completed' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/bookings/:id/whatsapp', authenticateToken, requireRoles(...SERVICE_ROLES), async (req, res) => {
  try {
    const booking = await loadRestaurantBooking(req.params.id, req.user.property_id);
    if (!booking) return res.status(404).json({ success: false, error: 'Booking not found' });
    const paid = await bookingAdvancePaid(db, booking.id);
    const phone = normalizePhone(req.query.phone || booking.guest_phone, booking.phone_country_code || '91');
    if (!phone) {
      return res.status(400).json({ success: false, error: 'A valid guest phone number with country code is required' });
    }
    const message = bookingWhatsappMessage(booking, paid.net);
    res.json({ success: true, phone, message, url: whatsappUrl(phone, message) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/bookings/:id/receipt/pdf', authenticateToken, requireRoles(...SERVICE_ROLES), async (req, res) => {
  try {
    const booking = await loadRestaurantBooking(req.params.id, req.user.property_id);
    if (!booking) return res.status(404).json({ success: false, error: 'Booking not found' });
    const paid = await bookingAdvancePaid(db, booking.id);
    const amount = paid.net;

    const invoice = {
      invoice_number: booking.booking_number,
      date: booking.booking_date,
      document_label: 'RESTAURANT BOOKING ADVANCE RECEIPT',
      is_tax_invoice: false,
      is_restaurant_bill: true,
      disclaimer: 'Acknowledges the advance received for a restaurant table booking. It is not a GST tax invoice.',
      property: {
        name: booking.property_name,
        address: booking.property_address,
        city: booking.property_city,
        state: booking.property_state,
        gstin: booking.property_gstin,
        phone: booking.property_phone,
        email: booking.property_email,
        logo_url: booking.logo_url,
        upi_id: booking.upi_id
      },
      customer: { name: booking.guest_name, phone: booking.guest_phone },
      table_number: booking.table_number,
      payment_method: booking.payment_mode,
      items: [{
        description: `Table booking on ${booking.booking_date} at ${String(booking.booking_time).slice(0, 5)} for ${booking.guest_count} guest(s)`,
        hsn_sac: '996331',
        quantity: 1,
        unit_price: amount,
        tax_rate: 0,
        tax_amount: 0,
        total_amount: amount
      }],
      subtotal: amount,
      total_tax: 0,
      grand_total: amount,
      paid_amount: amount,
      balance_due: 0
    };

    await sendInvoicePdf(res, invoice, `${booking.booking_number}.pdf`);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});

function PAYMENT_MODES_LABEL_TEXT() {
  return PAYMENT_METHODS.map(value => PAYMENT_MODE_LABELS[value] || value).join(', ');
}

module.exports = router;
