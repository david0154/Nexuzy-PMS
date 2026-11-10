const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const { authenticateToken } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');

// GET /api/v1/restaurant/tables
router.get('/tables', authenticateToken, async (req, res) => {
  try {
    const tables = await db.all(
      `SELECT t.*, o.order_number, o.total_amount as current_order_total
       FROM restaurant_tables t
       LEFT JOIN restaurant_orders o ON t.current_order_id = o.id
       ORDER BY t.table_number ASC`
    );
    res.json({ success: true, tables });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/restaurant/menu
router.get('/menu', authenticateToken, async (req, res) => {
  try {
    const categories = await db.all('SELECT * FROM menu_categories WHERE is_active = 1 ORDER BY display_order ASC');
    const items = await db.all('SELECT * FROM menu_items WHERE is_available = 1 ORDER BY name ASC');
    res.json({ success: true, categories, items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/restaurant/orders (Create Dine-In, Takeaway, or Room Service Order)
router.post('/orders', authenticateToken, async (req, res) => {
  try {
    const { table_id, order_type = 'dine_in', room_id, stay_id, items, waiter_name } = req.body;

    if (!items || !items.length) {
      return res.status(400).json({ success: false, error: 'Order must contain at least one item' });
    }

    const orderId = uuidv4();
    const orderNo = `ORD-${Date.now().toString().slice(-6)}`;

    let subtotal = 0;
    let taxAmount = 0;

    items.forEach(it => {
      const lineSub = Number(it.quantity) * Number(it.unit_price);
      const lineTax = Math.round(lineSub * (Number(it.tax_rate || 5.0) / 100) * 100) / 100;
      subtotal += lineSub;
      taxAmount += lineTax;
    });

    const totalAmount = subtotal + taxAmount;

    await db.transaction(async () => {
      // 1. Create Order
      await db.run(
        `INSERT INTO restaurant_orders 
         (id, order_number, property_id, table_id, order_type, stay_id, room_id, status, subtotal, tax_amount, total_amount, waiter_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        [orderId, orderNo, req.user.property_id, table_id || null, order_type, stay_id || null, room_id || null, subtotal, taxAmount, totalAmount, waiter_name || req.user.full_name]
      );

      // 2. Insert Order Items
      for (const it of items) {
        const lineSub = Number(it.quantity) * Number(it.unit_price);
        const lineTax = Math.round(lineSub * (Number(it.tax_rate || 5.0) / 100) * 100) / 100;
        await db.run(
          `INSERT INTO order_items (id, order_id, menu_item_id, item_name, quantity, unit_price, tax_rate, tax_amount, total_amount, status, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
          [uuidv4(), orderId, it.menu_item_id, it.item_name, it.quantity, it.unit_price, it.tax_rate || 5.0, lineTax, lineSub + lineTax, it.notes || null]
        );
      }

      // 3. If Dine-in, mark table occupied and link current order
      if (table_id) {
        await db.run("UPDATE restaurant_tables SET status = 'occupied', current_order_id = ? WHERE id = ?", [orderId, table_id]);
      }
    });

    res.json({
      success: true,
      message: 'Order created successfully',
      orderId,
      orderNumber: orderNo,
      totalAmount
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/restaurant/orders/:id/send-kitchen (Generate KOT)
router.post('/orders/:id/send-kitchen', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { station = 'kitchen', notes } = req.body;

    const order = await db.get('SELECT * FROM restaurant_orders WHERE id = ?', [id]);
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });

    const kotId = uuidv4();
    const kotNo = `KOT-${Date.now().toString().slice(-4)}`;

    await db.transaction(async () => {
      await db.run(
        `INSERT INTO kitchen_tickets (id, kot_number, order_id, table_id, room_id, station, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, 'preparing', ?)`,
        [kotId, kotNo, id, order.table_id, order.room_id, station, notes || null]
      );

      await db.run("UPDATE order_items SET status = 'preparing', kot_id = ? WHERE order_id = ? AND status = 'new'", [kotId, id]);
    });

    res.json({ success: true, message: 'KOT sent to kitchen', kotNumber: kotNo, kotId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/restaurant/kds (Kitchen Display System tickets)
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

    for (const t of tickets) {
      t.items = await db.all('SELECT * FROM order_items WHERE kot_id = ?', [t.id]);
    }

    res.json({ success: true, tickets });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/v1/restaurant/kds/:id/status
router.patch('/kds/:id/status', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // 'preparing', 'ready', 'served'
    await db.run('UPDATE kitchen_tickets SET status = ? WHERE id = ?', [status, id]);
    await db.run('UPDATE order_items SET status = ? WHERE kot_id = ?', [status, id]);
    res.json({ success: true, message: `KOT marked as ${status}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/restaurant/orders/:id/settle (Direct Restaurant Settlement - Section 34.3)
router.post('/orders/:id/settle', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { payment_method = 'cash' } = req.body;

    const order = await db.get('SELECT * FROM restaurant_orders WHERE id = ?', [id]);
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    if (order.status === 'settled' || order.status === 'posted_to_room') {
      return res.status(400).json({ success: false, error: `Order is already ${order.status}` });
    }

    const billNo = `REST-BILL-${Date.now().toString().slice(-6)}`;

    await db.transaction(async () => {
      // 1. Mark order settled
      await db.run(
        `UPDATE restaurant_orders 
         SET status = 'settled', settlement_method = ?, settled_at = CURRENT_TIMESTAMP 
         WHERE id = ?`,
        [payment_method, id]
      );

      // 2. Free up table if dine-in
      if (order.table_id) {
        await db.run("UPDATE restaurant_tables SET status = 'available', current_order_id = NULL WHERE id = ?", [order.table_id]);
      }

      // 3. Record restaurant payment
      await db.run(
        `INSERT INTO payments (id, receipt_number, property_id, amount, payment_method, payment_type, cashier_id, notes)
         VALUES (?, ?, ?, ?, ?, 'settlement', ?, ?)`,
        [uuidv4(), billNo, req.user.property_id, order.total_amount, payment_method, req.user.id, `Restaurant Bill for Order ${order.order_number}`]
      );

      // 4. Update cashier shift
      const shift = await db.get("SELECT id FROM cashier_shifts WHERE user_id = ? AND status = 'open' LIMIT 1", [req.user.id]);
      if (shift) {
        let field = 'total_cash';
        if (payment_method === 'card') field = 'total_card';
        else if (payment_method === 'upi') field = 'total_upi';
        await db.run(`UPDATE cashier_shifts SET ${field} = ${field} + ? WHERE id = ?`, [order.total_amount, shift.id]);
      }
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'SETTLE_RESTAURANT_ORDER',
      entityType: 'restaurant_order',
      entityId: id,
      details: { billNo, amount: order.total_amount, payment_method },
      req
    });

    res.json({
      success: true,
      message: 'Restaurant bill settled successfully',
      billNumber: billNo,
      totalAmount: order.total_amount
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/restaurant/orders/:id/post-to-room (Post to Room Folio - Section 34.4)
router.post('/orders/:id/post-to-room', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { room_id } = req.body;

    const order = await db.get('SELECT * FROM restaurant_orders WHERE id = ?', [id]);
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    if (order.status === 'settled' || order.status === 'posted_to_room') {
      return res.status(400).json({ success: false, error: `Order is already ${order.status}` });
    }

    const targetRoomId = room_id || order.room_id;
    if (!targetRoomId) {
      return res.status(400).json({ success: false, error: 'Target room ID is required to post to room' });
    }

    // Validate room is occupied and has active stay
    const stay = await db.get(
      `SELECT s.*, r.room_number, f.id as folio_id 
       FROM stays s
       JOIN rooms r ON s.room_id = r.id
       JOIN folios f ON f.stay_id = s.id
       WHERE s.room_id = ? AND s.status = 'occupied'
       ORDER BY s.check_in_time DESC LIMIT 1`,
      [targetRoomId]
    );

    if (!stay || !stay.folio_id) {
      return res.status(400).json({
        success: false,
        error: 'Cannot post to room: No active occupied stay or folio found for this room.'
      });
    }

    await db.transaction(async () => {
      // 1. Post to folio
      const entryId = uuidv4();
      const desc = `Restaurant Order ${order.order_number} (${order.order_type})`;
      await db.run(
        `INSERT INTO folio_entries 
         (id, folio_id, date, department, description, quantity, unit_price, tax_rate, tax_amount, total_amount, reference_id, reference_type, created_by)
         VALUES (?, ?, date('now'), 'restaurant', ?, 1, ?, 5.0, ?, ?, ?, 'restaurant_order', ?)`,
        [entryId, stay.folio_id, desc, order.subtotal, order.tax_amount, order.total_amount, order.id, req.user.id]
      );

      // 2. Update folio balance
      await db.run(
        `UPDATE folios 
         SET total_charges = total_charges + ?,
             balance = balance + ?
         WHERE id = ?`,
        [order.total_amount, order.total_amount, stay.folio_id]
      );

      // 3. Mark order as posted_to_room
      await db.run(
        `UPDATE restaurant_orders 
         SET status = 'posted_to_room', settlement_method = 'room_folio', stay_id = ?, room_id = ?, settled_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [stay.id, targetRoomId, id]
      );

      // 4. Free up table if dine-in
      if (order.table_id) {
        await db.run("UPDATE restaurant_tables SET status = 'available', current_order_id = NULL WHERE id = ?", [order.table_id]);
      }

      // 5. Update shift total_room_postings
      const shift = await db.get("SELECT id FROM cashier_shifts WHERE user_id = ? AND status = 'open' LIMIT 1", [req.user.id]);
      if (shift) {
        await db.run('UPDATE cashier_shifts SET total_room_postings = total_room_postings + ? WHERE id = ?', [order.total_amount, shift.id]);
      }
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'POST_RESTAURANT_TO_ROOM',
      entityType: 'restaurant_order',
      entityId: id,
      details: { room_number: stay.room_number, stay_id: stay.id, amount: order.total_amount },
      req
    });

    res.json({
      success: true,
      message: `Posted ₹${order.total_amount} to Room ${stay.room_number} folio.`,
      roomNumber: stay.room_number,
      folioId: stay.folio_id
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
