const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const { authenticateToken, requireRoles } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');
const {
  recalcFolio,
  buildCheckoutPreview,
  confirmCheckoutPreview,
  createFolioInvoice
} = require('../../services/billing');

const APPROVER_ROLES = ['admin', 'general_manager'];

function snapshotMatchesPreview(snapshot, preview) {
  try {
    const saved = JSON.parse(snapshot.snapshot_json).totals;
    return Math.abs(Number(saved.gross_charges) - Number(preview.totals.gross_charges)) < 0.01 &&
      Math.abs(Number(saved.total_tax) - Number(preview.totals.total_tax)) < 0.01;
  } catch (err) {
    return false;
  }
}

// GET /api/v1/stays/in-house
router.get('/in-house', authenticateToken, async (req, res) => {
  try {
    const stays = await db.all(
      `SELECT s.*, 
              r.room_number, r.floor, r.building,
              rt.name as room_type_name,
              g.first_name || ' ' || COALESCE(g.last_name, '') as guest_name,
              g.phone as guest_phone, g.email as guest_email,
              f.id as folio_id, f.folio_number, f.total_charges, f.total_payments, f.balance
       FROM stays s
       JOIN rooms r ON s.room_id = r.id
       JOIN room_types rt ON r.room_type_id = rt.id
       JOIN guests g ON s.primary_guest_id = g.id
       LEFT JOIN folios f ON f.stay_id = s.id
       WHERE s.status = 'occupied'
       ORDER BY r.room_number ASC`
    );
    res.json({ success: true, in_house_count: stays.length, stays });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/stays/arrivals
router.get('/arrivals', authenticateToken, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    // Individual reservations arriving today
    const indArrivals = await db.all(
      `SELECT res.*, 
              g.first_name || ' ' || COALESCE(g.last_name, '') as guest_name,
              g.phone as guest_phone,
              rt.name as room_type_name,
              r.room_number
       FROM reservations res
       JOIN guests g ON res.guest_id = g.id
       JOIN room_types rt ON res.room_type_id = rt.id
       LEFT JOIN rooms r ON res.assigned_room_id = r.id
       WHERE res.check_in_date = ? AND res.status = 'confirmed'`,
      [today]
    );

    // Group rooms arriving today
    const grpArrivals = await db.all(
      `SELECT gr.*, grp.group_name, grp.group_booking_number,
              rt.name as room_type_name, r.room_number
       FROM group_room_reservations gr
       JOIN group_reservations grp ON gr.group_id = grp.id
       JOIN room_types rt ON gr.room_type_id = rt.id
       LEFT JOIN rooms r ON gr.assigned_room_id = r.id
       WHERE gr.planned_check_in = ? AND gr.status = 'reserved'`,
      [today]
    );

    res.json({
      success: true,
      today,
      individual_arrivals: indArrivals,
      group_arrivals: grpArrivals,
      total: indArrivals.length + grpArrivals.length
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/stays/departures
router.get('/departures', authenticateToken, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const departures = await db.all(
      `SELECT s.*, 
              r.room_number,
              g.first_name || ' ' || COALESCE(g.last_name, '') as guest_name,
              f.balance
       FROM stays s
       JOIN rooms r ON s.room_id = r.id
       JOIN guests g ON s.primary_guest_id = g.id
       LEFT JOIN folios f ON f.stay_id = s.id
       WHERE s.expected_check_out = ? AND s.status = 'occupied'`,
      [today]
    );
    res.json({ success: true, today, departures, total: departures.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/stays/check-in-reservation (Check in an existing confirmed reservation)
router.post('/check-in-reservation', authenticateToken, async (req, res) => {
  try {
    const { reservation_id, assigned_room_id } = req.body;
    const resv = await db.get(
      `SELECT res.*, rt.tax_rate FROM reservations res 
       JOIN room_types rt ON res.room_type_id = rt.id 
       WHERE res.id = ?`,
      [reservation_id]
    );

    if (!resv) return res.status(404).json({ success: false, error: 'Reservation not found' });
    if (resv.status !== 'confirmed') return res.status(400).json({ success: false, error: `Reservation is in ${resv.status} status` });

    const roomId = assigned_room_id || resv.assigned_room_id;
    if (!roomId) return res.status(400).json({ success: false, error: 'Please assign a room' });

    const room = await db.get('SELECT * FROM rooms WHERE id = ?', [roomId]);
    if (['occupied'].includes(room.operational_status)) {
      return res.status(400).json({ success: false, error: `Room ${room.room_number} is already occupied` });
    }
    if (['out_of_order', 'out_of_service', 'blocked'].includes(room.operational_status)) {
      return res.status(409).json({
        success: false,
        error: `Room ${room.room_number} is ${room.operational_status.replace(/_/g, ' ')} and cannot be assigned`
      });
    }

    const checkInTime = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const stayId = uuidv4();
    const stayNo = `STY-${Date.now().toString().slice(-6)}-${room.room_number}`;
    const folioId = uuidv4();
    const folioNo = `FOL-${room.room_number}-${Date.now().toString().slice(-4)}`;

    await db.transaction(async () => {
      // 1. Create Stay
      await db.run(
        `INSERT INTO stays (id, stay_number, property_id, reservation_id, room_id, primary_guest_id, check_in_time, expected_check_out, status, nightly_rate, adults, children, checked_in_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'occupied', ?, ?, ?, ?)`,
        [stayId, stayNo, req.user.property_id, reservation_id, roomId, resv.guest_id, checkInTime, resv.check_out_date, resv.rate_per_night, resv.adult_count, resv.child_count, req.user.id]
      );

      // 2. Create Folio
      const taxRate = resv.tax_rate || 12.0;
      const taxAmt = Math.round(resv.rate_per_night * (taxRate / 100));
      const totalNightCharge = resv.rate_per_night + taxAmt;
      const deposit = resv.deposit_paid || 0;
      const initialBalance = totalNightCharge - deposit;

      await db.run(
        `INSERT INTO folios (id, folio_number, property_id, stay_id, folio_type, status, total_charges, total_payments, balance)
         VALUES (?, ?, ?, ?, 'room', 'open', ?, ?, ?)`,
        [folioId, folioNo, req.user.property_id, stayId, totalNightCharge, deposit, initialBalance]
      );

      // 3. Post first night charge
      await db.run(
        `INSERT INTO folio_entries (id, folio_id, date, department, description, quantity, unit_price, tax_rate, tax_amount, total_amount, created_by)
         VALUES (?, ?, date('now'), 'room_rent', 'Night 1 Room Rent', 1, ?, ?, ?, ?, ?)`,
        [uuidv4(), folioId, resv.rate_per_night, taxRate, taxAmt, totalNightCharge, req.user.id]
      );

      // Link any prior deposit payments to this folio
      if (deposit > 0) {
        await db.run('UPDATE payments SET folio_id = ? WHERE reservation_id = ?', [folioId, reservation_id]);
      }

      // 4. Update reservation status
      await db.run("UPDATE reservations SET status = 'checked_in', assigned_room_id = ? WHERE id = ?", [roomId, reservation_id]);

      // 5. Update room status to occupied
      await db.run("UPDATE rooms SET operational_status = 'occupied' WHERE id = ?", [roomId]);
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'CHECK_IN_RESERVATION',
      entityType: 'stay',
      entityId: stayId,
      details: { reservation_id, room_number: room.room_number },
      req
    });

    res.json({ success: true, message: `Checked into Room ${room.room_number}`, stayId, stayNo });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/stays/walk-in (Instant Walk-In Check In)
router.post('/walk-in', authenticateToken, async (req, res) => {
  try {
    const { first_name, last_name, phone, email, id_type, id_number, room_id, nights, rate_per_night, deposit_paid } = req.body;

    if (!first_name || !phone || !room_id || !rate_per_night) {
      return res.status(400).json({ success: false, error: 'First name, phone, room and rate are required' });
    }

    const room = await db.get('SELECT r.*, rt.tax_rate FROM rooms r JOIN room_types rt ON r.room_type_id = rt.id WHERE r.id = ?', [room_id]);
    if (!room) return res.status(404).json({ success: false, error: 'Room not found' });
    if (room.operational_status === 'occupied') {
      return res.status(400).json({ success: false, error: `Room ${room.room_number} is already occupied` });
    }

    const checkInTime = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const expDate = new Date();
    expDate.setDate(expDate.getDate() + (Number(nights) || 1));
    const expectedCheckOut = expDate.toISOString().slice(0, 10);

    const guestId = uuidv4();
    const stayId = uuidv4();
    const stayNo = `STY-WLK-${Date.now().toString().slice(-6)}-${room.room_number}`;
    const folioId = uuidv4();
    const folioNo = `FOL-${room.room_number}-${Date.now().toString().slice(-4)}`;

    await db.transaction(async () => {
      // 1. Create Guest
      await db.run(
        `INSERT INTO guests (id, property_id, first_name, last_name, phone, email, id_type, id_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [guestId, req.user.property_id, first_name, last_name || null, phone, email || null, id_type || null, id_number || null]
      );

      // 2. Create Stay
      await db.run(
        `INSERT INTO stays (id, stay_number, property_id, room_id, primary_guest_id, check_in_time, expected_check_out, status, nightly_rate, checked_in_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'occupied', ?, ?)`,
        [stayId, stayNo, req.user.property_id, room_id, guestId, checkInTime, expectedCheckOut, rate_per_night, req.user.id]
      );

      // 3. Create Folio & post initial charge
      const taxRate = room.tax_rate || 12.0;
      const taxAmt = Math.round(rate_per_night * (taxRate / 100));
      const totalNightCharge = Number(rate_per_night) + taxAmt;
      const deposit = Number(deposit_paid) || 0;
      const balance = totalNightCharge - deposit;

      await db.run(
        `INSERT INTO folios (id, folio_number, property_id, stay_id, folio_type, status, total_charges, total_payments, balance)
         VALUES (?, ?, ?, ?, 'room', 'open', ?, ?, ?)`,
        [folioId, folioNo, req.user.property_id, stayId, totalNightCharge, deposit, balance]
      );

      await db.run(
        `INSERT INTO folio_entries (id, folio_id, date, department, description, quantity, unit_price, tax_rate, tax_amount, total_amount, created_by)
         VALUES (?, ?, date('now'), 'room_rent', 'Night 1 Room Rent', 1, ?, ?, ?, ?, ?)`,
        [uuidv4(), folioId, rate_per_night, taxRate, taxAmt, totalNightCharge, req.user.id]
      );

      if (deposit > 0) {
        await db.run(
          `INSERT INTO payments (id, receipt_number, property_id, folio_id, amount, payment_method, payment_type, cashier_id, notes)
           VALUES (?, ?, ?, ?, ?, 'cash', 'advance_deposit', ?, 'Walk-in initial deposit')`,
          [uuidv4(), `REC-WLK-${Date.now().toString().slice(-4)}`, req.user.property_id, folioId, deposit, req.user.id]
        );
      }

      // 4. Update room to occupied
      await db.run("UPDATE rooms SET operational_status = 'occupied' WHERE id = ?", [room_id]);
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'WALK_IN_CHECK_IN',
      entityType: 'stay',
      entityId: stayId,
      details: { room_number: room.room_number, guest: first_name },
      req
    });

    res.json({ success: true, message: `Walk-in check-in complete for Room ${room.room_number}`, stayId, stayNo });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// Checkout bill preview, confirmation, invoice and final checkout
// ---------------------------------------------------------------
const CHECKOUT_ROLES = ['admin', 'general_manager', 'front_desk', 'cashier'];

router.get('/:id/checkout-preview', authenticateToken, requireRoles(...CHECKOUT_ROLES), async (req, res) => {
  try {
    const preview = await buildCheckoutPreview(db, req.params.id);
    if (!preview) return res.status(404).json({ success: false, error: 'Stay not found' });
    res.json({ success: true, preview });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/:id/checkout-preview/confirm', authenticateToken, requireRoles(...CHECKOUT_ROLES), async (req, res) => {
  try {
    const stay = await db.get("SELECT * FROM stays WHERE id = ? AND status = 'occupied'", [req.params.id]);
    if (!stay) return res.status(404).json({ success: false, error: 'Active stay not found' });

    const preview = await buildCheckoutPreview(db, req.params.id);
    if (!preview) return res.status(404).json({ success: false, error: 'Stay not found' });

    const snapshot = await db.transaction(async (conn) => {
      return confirmCheckoutPreview(conn, {
        propertyId: req.user.property_id,
        stayId: req.params.id,
        preview,
        userId: req.user.id,
        notes: req.body.notes || null
      });
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'CONFIRM_CHECKOUT_BILL',
      entityType: 'stay',
      entityId: req.params.id,
      details: {
        snapshot_id: snapshot.id,
        total_charges: preview.totals.gross_charges,
        total_payments: preview.totals.total_payments,
        balance: preview.totals.balance,
        room_number: preview.stay.room_number
      },
      req
    });

    res.json({
      success: true,
      message: 'Bill preview confirmed. You can now issue the final invoice and check out.',
      snapshot_id: snapshot.id,
      preview
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/:id/invoice', authenticateToken, requireRoles(...CHECKOUT_ROLES), async (req, res) => {
  try {
    const stay = await db.get(
      `SELECT s.*, f.id AS folio_id FROM stays s LEFT JOIN folios f ON f.stay_id = s.id WHERE s.id = ?`,
      [req.params.id]
    );
    if (!stay) return res.status(404).json({ success: false, error: 'Stay not found' });
    if (!stay.folio_id) return res.status(400).json({ success: false, error: 'Active folio not found' });

    const snapshot = await db.get(
      "SELECT * FROM checkout_snapshots WHERE stay_id = ? AND status IN ('confirmed','invoice_issued') ORDER BY confirmed_at DESC LIMIT 1",
      [req.params.id]
    );
    if (!snapshot && !(req.body.allow_override && APPROVER_ROLES.includes(req.user.role))) {
      return res.status(409).json({
        success: false,
        error: 'Confirm the checkout bill preview before generating the final invoice.',
        requires_bill_confirmation: true
      });
    }

    if (snapshot) {
      const preview = await buildCheckoutPreview(db, req.params.id);
      if (!snapshotMatchesPreview(snapshot, preview) &&
          !(req.body.allow_override && APPROVER_ROLES.includes(req.user.role))) {
        return res.status(409).json({
          success: false,
          error: 'The bill changed after it was confirmed. Review and confirm the bill again before invoicing.',
          requires_bill_confirmation: true
        });
      }
    }

    const result = await db.transaction(async (conn) => {
      return createFolioInvoice(conn, {
        propertyId: req.user.property_id,
        folioId: stay.folio_id,
        userId: req.user.id,
        snapshotId: snapshot ? snapshot.id : null
      });
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: result.duplicate ? 'INVOICE_DUPLICATE_BLOCKED' : 'GENERATE_FINAL_INVOICE',
      entityType: 'stay',
      entityId: req.params.id,
      details: { invoice_number: result.invoice.invoice_number, duplicate: result.duplicate },
      req
    });

    res.json({
      success: true,
      duplicate: result.duplicate,
      invoice: result.invoice,
      message: result.duplicate
        ? `Invoice ${result.invoice.invoice_number} already exists.`
        : 'Final tax invoice generated'
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/:id/check-out', authenticateToken, requireRoles(...CHECKOUT_ROLES), async (req, res) => {
  try {
    const { id } = req.params;
    const { allow_override = false, refund_acknowledged = false } = req.body;
    const canOverride = Boolean(allow_override) && APPROVER_ROLES.includes(req.user.role);

    const stay = await db.get(
      `SELECT s.*, r.room_number, f.id as folio_id, f.status AS folio_status
       FROM stays s
       JOIN rooms r ON s.room_id = r.id
       LEFT JOIN folios f ON f.stay_id = s.id
       WHERE s.id = ?`,
      [id]
    );
    if (!stay) return res.status(404).json({ success: false, error: 'Stay not found' });
    if (stay.status === 'checked_out') return res.status(400).json({ success: false, error: 'Stay is already checked out' });
    if (!stay.folio_id) return res.status(400).json({ success: false, error: 'Active folio not found' });

    const preview = await buildCheckoutPreview(db, id);
    if (!preview) return res.status(404).json({ success: false, error: 'Stay not found' });

    const snapshot = await db.get(
      "SELECT * FROM checkout_snapshots WHERE stay_id = ? AND status IN ('confirmed','invoice_issued') ORDER BY confirmed_at DESC LIMIT 1",
      [id]
    );

    if (!snapshot && !canOverride) {
      return res.status(409).json({
        success: false,
        error: 'Review and confirm the checkout bill before completing checkout.',
        requires_bill_confirmation: true,
        preview
      });
    }

    if (snapshot && !snapshotMatchesPreview(snapshot, preview) && !canOverride) {
      return res.status(409).json({
        success: false,
        error: 'The bill changed after it was confirmed. Review and confirm the bill again before checkout.',
        requires_bill_confirmation: true,
        preview
      });
    }

    if (preview.totals.balance_due > 0.004 && !canOverride) {
      return res.status(400).json({
        success: false,
        error: `Cannot checkout: Room ${stay.room_number} has an unpaid balance of ₹${preview.totals.balance_due}. Settle the folio before checkout.`,
        balance_due: preview.totals.balance_due
      });
    }

    if (preview.totals.refund_due > 0.004 && !refund_acknowledged && !canOverride) {
      return res.status(409).json({
        success: false,
        error: `Guest is owed a refund of ₹${preview.totals.refund_due}. Process the refund or acknowledge it before checkout.`,
        refund_due: preview.totals.refund_due,
        requires_refund_acknowledgement: true
      });
    }

    let invoice = preview.existing_invoice;
    if (snapshot) {
      const invoiceResult = await db.transaction(async (conn) => {
        return createFolioInvoice(conn, {
          propertyId: req.user.property_id,
          folioId: stay.folio_id,
          userId: req.user.id,
          snapshotId: snapshot.id
        });
      });
      invoice = invoiceResult.invoice;
    }

    const checkOutTime = new Date().toISOString().replace('T', ' ').substring(0, 19);
    await db.transaction(async (conn) => {
      await conn.run(
        "UPDATE stays SET status = 'checked_out', actual_check_out_time = ?, checked_out_by = ? WHERE id = ?",
        [checkOutTime, req.user.id, id]
      );

      await conn.run(
        "UPDATE folios SET status = 'closed', closed_at = CURRENT_TIMESTAMP, closed_by = ? WHERE id = ?",
        [req.user.id, stay.folio_id]
      );

      await conn.run(
        "UPDATE rooms SET operational_status = 'available', housekeeping_status = 'dirty' WHERE id = ?",
        [stay.room_id]
      );

      await conn.run(
        `INSERT INTO housekeeping_tasks (id, property_id, room_id, task_type, status, priority, notes)
         VALUES (?, ?, ?, 'checkout_cleaning', 'dirty', 'high', ?)`,
        [uuidv4(), req.user.property_id, stay.room_id, `Checkout cleaning for Room ${stay.room_number}`]
      );

      if (stay.reservation_id) {
        await conn.run("UPDATE reservations SET status = 'checked_out' WHERE id = ?", [stay.reservation_id]);
      }
      if (stay.group_room_reservation_id) {
        await conn.run(
          "UPDATE group_room_reservations SET status = 'checked_out', actual_check_out = ? WHERE id = ?",
          [checkOutTime, stay.group_room_reservation_id]
        );
      }

      await recalcFolio(conn, stay.folio_id);
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'CHECK_OUT_STAY',
      entityType: 'stay',
      entityId: id,
      details: {
        room_number: stay.room_number,
        balance: preview.totals.balance,
        refund_due: preview.totals.refund_due,
        invoice_number: invoice ? invoice.invoice_number : null,
        bill_confirmed: Boolean(snapshot),
        override_used: canOverride && !snapshot
      },
      req
    });

    res.json({
      success: true,
      message: `Room ${stay.room_number} checked out successfully. Housekeeping notified.`,
      invoice: invoice || null,
      balance: preview.totals.balance,
      refund_due: preview.totals.refund_due
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/stays/:id/room-move (Transfer guest to another room)
router.post('/:id/room-move', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { target_room_id, reason } = req.body;

    const stay = await db.get('SELECT s.*, r.room_number as old_room FROM stays s JOIN rooms r ON s.room_id = r.id WHERE s.id = ?', [id]);
    if (!stay || stay.status !== 'occupied') return res.status(400).json({ success: false, error: 'Active occupied stay required' });

    const newRoom = await db.get('SELECT * FROM rooms WHERE id = ?', [target_room_id]);
    if (!newRoom) return res.status(404).json({ success: false, error: 'Target room not found' });
    if (newRoom.operational_status === 'occupied') {
      return res.status(400).json({ success: false, error: `Room ${newRoom.room_number} is already occupied` });
    }

    await db.transaction(async () => {
      // Release old room to housekeeping dirty
      await db.run("UPDATE rooms SET operational_status = 'available', housekeeping_status = 'dirty' WHERE id = ?", [stay.room_id]);
      // Mark new room occupied
      await db.run("UPDATE rooms SET operational_status = 'occupied' WHERE id = ?", [target_room_id]);
      // Update stay record
      await db.run('UPDATE stays SET room_id = ? WHERE id = ?', [target_room_id, id]);
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'ROOM_MOVE',
      entityType: 'stay',
      entityId: id,
      details: { from: stay.old_room, to: newRoom.room_number, reason },
      req
    });

    res.json({ success: true, message: `Guest moved from Room ${stay.old_room} to Room ${newRoom.room_number}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/stays/:id/whatsapp — pre-filled WhatsApp message for the final bill
router.get('/:id/whatsapp', authenticateToken, requireRoles(...CHECKOUT_ROLES), async (req, res) => {
  try {
    const preview = await buildCheckoutPreview(db, req.params.id);
    if (!preview) return res.status(404).json({ success: false, error: 'Stay not found' });

    const { normalizePhone, whatsappUrl, formatMoney } = require('../../services/whatsapp');
    const phone = normalizePhone(
      req.query.phone || preview.stay.guest.phone,
      preview.property.phone_country_code || '91'
    );
    if (!phone) {
      return res.status(400).json({
        success: false,
        error: 'A valid guest phone number with country code is required to send a WhatsApp bill.'
      });
    }

    const t = preview.totals;
    const lines = [
      `*${preview.property.name}*`,
      `Checkout Bill - Room ${preview.stay.room_number}`,
      `Guest: ${preview.stay.guest.name}`,
      preview.stay.booking_reference ? `Booking: ${preview.stay.booking_reference}` : null,
      `${String(preview.stay.check_in_time).slice(0, 10)} to ${preview.stay.expected_check_out} (${preview.stay.nights} night(s))`,
      `Total charges: ${formatMoney(t.gross_charges)}`,
      `Payments received: ${formatMoney(t.total_payments)}`,
      `Balance due: ${formatMoney(t.balance_due)}`
    ].filter(Boolean);
    if (preview.property.upi_id) lines.push(`Pay by UPI: ${preview.property.upi_id}`);
    if (preview.property.phone) lines.push(`Hotel contact: ${preview.property.phone}`);
    lines.push('', 'Your PDF bill is attached. Thank you for staying with us.');

    const message = lines.join('\n');
    res.json({ success: true, phone, message, url: whatsappUrl(phone, message) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/stays/:id/extend (Extend an occupied stay's departure date)
router.post('/:id/extend', authenticateToken, async (req, res) => {
  try {
    const nights = Number(req.body.nights);
    if (!Number.isInteger(nights) || nights < 1 || nights > 365) {
      return res.status(400).json({ success: false, error: 'Extension must be a whole number of nights between 1 and 365' });
    }

    const stay = await db.get(
      `SELECT s.*, r.room_number FROM stays s JOIN rooms r ON s.room_id = r.id WHERE s.id = ?`,
      [req.params.id]
    );
    if (!stay) return res.status(404).json({ success: false, error: 'Stay not found' });
    if (stay.status !== 'occupied') {
      return res.status(400).json({ success: false, error: 'Only an occupied stay can be extended' });
    }

    const base = new Date(`${String(stay.expected_check_out).slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(base.getTime())) {
      return res.status(400).json({ success: false, error: 'The stay has an invalid departure date' });
    }
    base.setUTCDate(base.getUTCDate() + nights);
    const newCheckOut = base.toISOString().slice(0, 10);

    await db.transaction(async (conn) => {
      await conn.run('UPDATE stays SET expected_check_out = ? WHERE id = ?', [newCheckOut, stay.id]);
      if (stay.reservation_id) {
        await conn.run(
          `UPDATE reservations SET check_out_date = ?, updated_at = CURRENT_TIMESTAMP, version = version + 1
           WHERE id = ?`,
          [newCheckOut, stay.reservation_id]
        );
      }
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'EXTEND_STAY',
      entityType: 'stay',
      entityId: stay.id,
      beforeValue: { expected_check_out: stay.expected_check_out },
      afterValue: { expected_check_out: newCheckOut },
      details: { room_number: stay.room_number, nights, nightly_rate: stay.nightly_rate },
      req
    });

    res.json({
      success: true,
      message: `Room ${stay.room_number} extended by ${nights} night(s) to ${newCheckOut}`,
      previous_check_out: String(stay.expected_check_out).slice(0, 10),
      new_check_out: newCheckOut,
      extra_room_charges: round2(Number(stay.nightly_rate) * nights)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
