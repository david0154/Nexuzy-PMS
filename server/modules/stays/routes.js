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
  createFolioInvoice,
  recordPayment,
  billableNights,
  postStayRoomNights,
  round2
} = require('../../services/billing');
const {
  postLocalTaxForStay,
  applyCheckoutRounding
} = require('../../services/tax');
const {
  recommendRooms,
  assertRoomAssignable,
  markAllocationCheckedIn,
  insertAllocation,
  releaseStayAllocation,
  transferStayRoom
} = require('../../services/allocation');

const APPROVER_ROLES = ['admin', 'general_manager'];
// Only reception-side roles may create or change a stay.
const STAY_WRITE_ROLES = ['admin', 'general_manager', 'front_desk', 'cashier'];

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
       WHERE s.status = 'occupied' AND s.property_id = ?
       ORDER BY r.room_number ASC`,
      [req.user.property_id]
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
       WHERE res.check_in_date = ? AND res.status = 'confirmed' AND res.property_id = ?`,
      [today, req.user.property_id]
    );

    // Group rooms arriving today
    const grpArrivals = await db.all(
      `SELECT gr.*, grp.group_name, grp.group_booking_number,
              rt.name as room_type_name, r.room_number
       FROM group_room_reservations gr
       JOIN group_reservations grp ON gr.group_id = grp.id
       JOIN room_types rt ON gr.room_type_id = rt.id
       LEFT JOIN rooms r ON gr.assigned_room_id = r.id
       WHERE gr.planned_check_in = ? AND gr.status = 'reserved' AND grp.property_id = ?`,
      [today, req.user.property_id]
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
       WHERE s.expected_check_out = ? AND s.status = 'occupied' AND s.property_id = ?`,
      [today, req.user.property_id]
    );
    res.json({ success: true, today, departures, total: departures.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/stays/check-in-reservation (Check in an existing confirmed reservation)
router.post('/check-in-reservation', authenticateToken, requireRoles(...STAY_WRITE_ROLES), async (req, res) => {
  try {
    const { reservation_id, assigned_room_id, auto_assign = false } = req.body;
    const resv = await db.get(
      `SELECT res.*, rt.tax_rate FROM reservations res
       JOIN room_types rt ON res.room_type_id = rt.id
       WHERE res.id = ? AND res.property_id = ?`,
      [reservation_id, req.user.property_id]
    );

    if (!resv) return res.status(404).json({ success: false, error: 'Reservation not found for this property' });
    if (resv.status !== 'confirmed') return res.status(400).json({ success: false, error: `Reservation is in ${resv.status} status` });

    let roomId = assigned_room_id || resv.assigned_room_id;
    const property = await db.get('SELECT * FROM properties WHERE id = ?', [req.user.property_id]);
    if (!property) return res.status(404).json({ success: false, error: 'Property not found' });

    if (!roomId) {
      const recommended = await recommendRooms(db, req.user.property_id, {
        check_in: resv.check_in_date,
        check_out: resv.check_out_date,
        room_type_id: resv.room_type_id,
        adults: resv.adult_count,
        children: resv.child_count,
        bed_preference: resv.bed_preference,
        ac_preference: resv.ac_preference,
        floor_preference: resv.floor_preference,
        accessibility_required: Boolean(Number(resv.accessibility_required)),
        smoking_preference: resv.smoking_preference,
        amenities_preference: resv.amenities_preference,
        immediate: true,
        limit: 5
      });
      const shouldAuto = Boolean(auto_assign) || Boolean(Number(property.auto_assign_on_checkin)) ||
        String(property.room_assignment_mode || '') === 'auto' || String(resv.assignment_mode || '') === 'auto';
      if (!recommended.best || !shouldAuto) {
        return res.status(409).json({
          success: false,
          error: recommended.best
            ? 'This reservation has no room assigned. Confirm the recommended room or choose another room.'
            : 'No suitable room is available for this reservation. Change the dates or room type, or free a room.',
          requires_room_selection: true,
          recommendation: recommended.best,
          recommendations: recommended.rooms
        });
      }
      roomId = recommended.best.id;
    }

    const room = await db.get('SELECT * FROM rooms WHERE id = ? AND property_id = ?', [roomId, req.user.property_id]);
    if (!room) return res.status(404).json({ success: false, error: 'Assigned room does not belong to this property' });
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

    await db.transaction(async (conn) => {
      // Re-validate inside the write transaction: another device may have
      // assigned or occupied this room after the screen was loaded.
      await assertRoomAssignable(conn, {
        propertyId: req.user.property_id,
        roomId,
        checkIn: resv.check_in_date,
        checkOut: resv.check_out_date,
        excludeReservationId: reservation_id,
        immediate: true,
        requireReady: false
      });

      // 1. Create Stay
      await conn.run(
        `INSERT INTO stays (id, stay_number, property_id, reservation_id, room_id, primary_guest_id, check_in_time, expected_check_out, status, nightly_rate, adults, children, checked_in_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'occupied', ?, ?, ?, ?)`,
        [stayId, stayNo, req.user.property_id, reservation_id, roomId, resv.guest_id, checkInTime, resv.check_out_date, resv.rate_per_night, resv.adult_count, resv.child_count, req.user.id]
      );

      // 2. Create Folio
      const taxRate = resv.tax_rate || 12.0;

      await conn.run(
        `INSERT INTO folios (id, folio_number, property_id, stay_id, folio_type, status, total_charges, total_payments, balance)
         VALUES (?, ?, ?, ?, 'room', 'open', 0, 0, 0)`,
        [folioId, folioNo, req.user.property_id, stayId]
      );

      // 3. Post first night charge (later nights are posted by the night audit).
      const firstNightTax = round2(Number(resv.rate_per_night) * (taxRate / 100));
      await conn.run(
        `INSERT INTO folio_entries (id, folio_id, date, department, description, quantity, unit_price, tax_rate, tax_amount, total_amount, created_by)
         VALUES (?, ?, date('now'), 'room_rent', 'Night 1 Room Rent', 1, ?, ?, ?, ?, ?)`,
        [uuidv4(), folioId, resv.rate_per_night, taxRate, firstNightTax, round2(Number(resv.rate_per_night) + firstNightTax), req.user.id]
      );

      // Link any prior deposit payments to this folio
      await conn.run(
        'UPDATE payments SET folio_id = ? WHERE reservation_id = ? AND property_id = ?',
        [folioId, reservation_id, req.user.property_id]
      );

      // 4. Update reservation status
      await conn.run(
        "UPDATE reservations SET status = 'checked_in', assigned_room_id = ? WHERE id = ? AND property_id = ?",
        [roomId, reservation_id, req.user.property_id]
      );

      // 5. Update room status to occupied
      await conn.run("UPDATE rooms SET operational_status = 'occupied' WHERE id = ? AND property_id = ?", [roomId, req.user.property_id]);

      // 6. Close the checklist: allocation history now reflects the active stay.
      const marked = await markAllocationCheckedIn(conn, {
        propertyId: req.user.property_id,
        reservationId: reservation_id,
        stayId,
        userId: req.user.id
      });
      if (!marked) {
        await insertAllocation(conn, {
          propertyId: req.user.property_id,
          reservationId: reservation_id,
          stayId,
          roomId,
          guestId: resv.guest_id,
          status: 'checked_in',
          userId: req.user.id,
          reason: 'Assigned at check-in'
        });
      }

      // 7. Post any configured local tax for every stay night, exactly once.
      const freshStay = await conn.get('SELECT * FROM stays WHERE id = ?', [stayId]);
      await postLocalTaxForStay(conn, property, freshStay, { userId: req.user.id });
      await recalcFolio(conn, folioId);
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
router.post('/walk-in', authenticateToken, requireRoles(...STAY_WRITE_ROLES), async (req, res) => {
  try {
    let {
      first_name, last_name, phone, email, id_type, id_number, room_id, nights, rate_per_night,
      deposit_paid, adults, children, auto_assign = false,
      room_type_id, bed_preference, ac_preference, floor_preference,
      accessibility_required, smoking_preference, amenities_preference
    } = req.body;

    if (!first_name || !phone || !rate_per_night) {
      return res.status(400).json({ success: false, error: 'First name, phone and rate are required' });
    }

    const stayNights = Number(nights) || 1;
    if (!Number.isInteger(stayNights) || stayNights < 1 || stayNights > 365) {
      return res.status(400).json({ success: false, error: 'Nights must be a whole number between 1 and 365' });
    }
    if (!(Number(rate_per_night) > 0) || Number(rate_per_night) > 1000000) {
      return res.status(400).json({ success: false, error: 'Room rate must be greater than zero' });
    }
    if (deposit_paid !== undefined && !(Number(deposit_paid) >= 0)) {
      return res.status(400).json({ success: false, error: 'Deposit must be zero or greater' });
    }

    const adultCount = Number.isInteger(Number(adults)) && Number(adults) >= 1 ? Number(adults) : 1;
    const childCount = Number.isInteger(Number(children)) && Number(children) >= 0 ? Number(children) : 0;

    const property = await db.get('SELECT * FROM properties WHERE id = ?', [req.user.property_id]);
    if (!property) return res.status(404).json({ success: false, error: 'Property not found' });

    const checkInTime = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const expDate = new Date();
    expDate.setDate(expDate.getDate() + stayNights);
    const expectedCheckOut = expDate.toISOString().slice(0, 10);

    if (!room_id) {
      const recommended = await recommendRooms(db, req.user.property_id, {
        check_in: checkInTime.slice(0, 10),
        check_out: expectedCheckOut,
        room_type_id,
        adults: adultCount,
        children: childCount,
        bed_preference,
        ac_preference,
        floor_preference,
        accessibility_required: Boolean(accessibility_required),
        smoking_preference,
        amenities_preference,
        max_rate: Number(rate_per_night),
        immediate: true,
        limit: 5
      });
      const shouldAuto = Boolean(auto_assign) || String(property.room_assignment_mode || '') === 'auto' || Boolean(Number(property.auto_assign_on_checkin));
      if (!recommended.best || !shouldAuto) {
        return res.status(409).json({
          success: false,
          error: recommended.best
            ? 'Confirm the recommended room or choose another available room.'
            : 'No suitable room is available for these guest requirements and dates.',
          requires_room_selection: true,
          recommendation: recommended.best,
          recommendations: recommended.rooms
        });
      }
      room_id = recommended.best.id;
      rate_per_night = rate_per_night || recommended.best.rate;
    }

    const room = await db.get(
      'SELECT r.*, rt.tax_rate FROM rooms r JOIN room_types rt ON r.room_type_id = rt.id WHERE r.id = ? AND r.property_id = ?',
      [room_id, req.user.property_id]
    );
    if (!room) return res.status(404).json({ success: false, error: 'Room not found for this property' });
    if (room.operational_status === 'occupied') {
      return res.status(400).json({ success: false, error: `Room ${room.room_number} is already occupied` });
    }
    if (['out_of_order', 'out_of_service', 'blocked'].includes(room.operational_status)) {
      return res.status(409).json({ success: false, error: `Room ${room.room_number} is ${room.operational_status.replace(/_/g, ' ')}` });
    }

    const guestId = uuidv4();
    const stayId = uuidv4();
    const stayNo = `STY-WLK-${Date.now().toString().slice(-6)}-${room.room_number}`;
    const folioId = uuidv4();
    const folioNo = `FOL-${room.room_number}-${Date.now().toString().slice(-4)}`;

    await db.transaction(async (conn) => {
      await assertRoomAssignable(conn, {
        propertyId: req.user.property_id,
        roomId: room_id,
        checkIn: checkInTime.slice(0, 10),
        checkOut: expectedCheckOut,
        immediate: true,
        requireReady: false
      });

      // 1. Create Guest
      await conn.run(
        `INSERT INTO guests (id, property_id, first_name, last_name, phone, email, id_type, id_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [guestId, req.user.property_id, first_name, last_name || null, phone, email || null, id_type || null, id_number || null]
      );

      // 2. Create Stay
      await conn.run(
        `INSERT INTO stays (id, stay_number, property_id, room_id, primary_guest_id, check_in_time, expected_check_out, status, nightly_rate, adults, children, checked_in_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'occupied', ?, ?, ?, ?)`,
        [stayId, stayNo, req.user.property_id, room_id, guestId, checkInTime, expectedCheckOut, rate_per_night, adultCount, childCount, req.user.id]
      );

      // 3. Create Folio & post initial charge
      const taxRate = room.tax_rate || 12.0;
      const deposit = Number(deposit_paid) || 0;

      await conn.run(
        `INSERT INTO folios (id, folio_number, property_id, stay_id, folio_type, status, total_charges, total_payments, balance)
         VALUES (?, ?, ?, ?, 'room', 'open', 0, 0, 0)`,
        [folioId, folioNo, req.user.property_id, stayId]
      );

      const firstNightTax = round2(Number(rate_per_night) * (taxRate / 100));
      await conn.run(
        `INSERT INTO folio_entries (id, folio_id, date, department, description, quantity, unit_price, tax_rate, tax_amount, total_amount, created_by)
         VALUES (?, ?, date('now'), 'room_rent', 'Night 1 Room Rent', 1, ?, ?, ?, ?, ?)`,
        [uuidv4(), folioId, rate_per_night, taxRate, firstNightTax, round2(Number(rate_per_night) + firstNightTax), req.user.id]
      );

      if (deposit > 0) {
        await conn.run(
          `INSERT INTO payments (id, receipt_number, property_id, folio_id, amount, payment_method, payment_type, cashier_id, notes)
           VALUES (?, ?, ?, ?, ?, 'cash', 'advance_deposit', ?, 'Walk-in initial deposit')`,
          [uuidv4(), `REC-WLK-${Date.now().toString().slice(-4)}`, req.user.property_id, folioId, deposit, req.user.id]
        );
      }

      // 4. Update room to occupied and record the allocation history.
      await conn.run("UPDATE rooms SET operational_status = 'occupied' WHERE id = ? AND property_id = ?", [room_id, req.user.property_id]);
      await insertAllocation(conn, {
        propertyId: req.user.property_id,
        stayId,
        roomId: room_id,
        guestId,
        status: 'checked_in',
        userId: req.user.id,
        reason: auto_assign ? 'Automatic walk-in assignment' : 'Walk-in assignment'
      });

      const freshStay = await conn.get('SELECT * FROM stays WHERE id = ?', [stayId]);
      await postLocalTaxForStay(conn, property, freshStay, { userId: req.user.id });
      await recalcFolio(conn, folioId);
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

    res.json({
      success: true,
      message: `Walk-in check-in complete for Room ${room.room_number}`,
      stayId,
      stayNo,
      room: { id: room.id, room_number: room.room_number },
      housekeeping_warning: !['clean', 'inspected'].includes(room.housekeeping_status)
        ? `Room ${room.room_number} is ${String(room.housekeeping_status).replace(/_/g, ' ')}; housekeeping should complete it.`
        : null
    });
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
    const preview = await buildCheckoutPreview(db, req.params.id, req.user.property_id, {
      checkout_date: req.query.checkout_date || null
    });
    if (!preview) return res.status(404).json({ success: false, error: 'Stay not found for this property' });
    res.json({ success: true, preview });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/:id/checkout-preview/confirm', authenticateToken, requireRoles(...CHECKOUT_ROLES), async (req, res) => {
  try {
    const stay = await db.get(
      "SELECT * FROM stays WHERE id = ? AND property_id = ? AND status = 'occupied'",
      [req.params.id, req.user.property_id]
    );
    if (!stay) return res.status(404).json({ success: false, error: 'Active stay not found for this property' });
    const property = await db.get('SELECT * FROM properties WHERE id = ?', [req.user.property_id]);
    const checkoutDate = req.body.checkout_date || null;

    const result = await db.transaction(async (conn) => {
      // Catch up the room nights and local tax this stay is actually billed for.
      await postStayRoomNights(conn, { stay, userId: req.user.id, checkoutDate });
      await postLocalTaxForStay(conn, property, stay, {
        userId: req.user.id,
        nights: billableNights(stay, checkoutDate)
      });
      const preview = await buildCheckoutPreview(conn, req.params.id, req.user.property_id, { checkout_date: checkoutDate });
      if (!preview) throw new Error('Stay not found');
      const snapshot = await confirmCheckoutPreview(conn, {
        propertyId: req.user.property_id,
        stayId: req.params.id,
        preview,
        userId: req.user.id,
        notes: req.body.notes || null
      });
      return { snapshot, preview };
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'CONFIRM_CHECKOUT_BILL',
      entityType: 'stay',
      entityId: req.params.id,
      details: {
        snapshot_id: result.snapshot.id,
        total_charges: result.preview.totals.gross_charges,
        total_payments: result.preview.totals.total_payments,
        balance: result.preview.totals.balance,
        room_number: result.preview.stay.room_number
      },
      req
    });

    res.json({
      success: true,
      message: 'Bill preview confirmed. You can now issue the final invoice and check out.',
      snapshot_id: result.snapshot.id,
      preview: result.preview
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/:id/invoice', authenticateToken, requireRoles(...CHECKOUT_ROLES), async (req, res) => {
  try {
    const stay = await db.get(
      `SELECT s.*, f.id AS folio_id FROM stays s LEFT JOIN folios f ON f.stay_id = s.id
       WHERE s.id = ? AND s.property_id = ?`,
      [req.params.id, req.user.property_id]
    );
    if (!stay) return res.status(404).json({ success: false, error: 'Stay not found for this property' });
    if (!stay.folio_id) return res.status(400).json({ success: false, error: 'Active folio not found' });

    const checkoutDate = req.body.checkout_date || null;
    // Turn the bill preview's remaining nights into real ledger rows, so the
    // locked tax invoice carries every night of the stay.
    await db.transaction(async (conn) => {
      await postStayRoomNights(conn, { stay, userId: req.user.id, checkoutDate });
    });

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
      const preview = await buildCheckoutPreview(db, req.params.id, req.user.property_id, { checkout_date: checkoutDate });
      if (!preview) return res.status(404).json({ success: false, error: 'Stay not found' });
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
       WHERE s.id = ? AND s.property_id = ?`,
      [id, req.user.property_id]
    );
    if (!stay) return res.status(404).json({ success: false, error: 'Stay not found for this property' });
    if (stay.status === 'checked_out') return res.status(400).json({ success: false, error: 'Stay is already checked out' });
    if (!stay.folio_id) return res.status(400).json({ success: false, error: 'Active folio not found' });

    const checkoutDate = req.body.checkout_date || null;
    // Post the nights still owed for this stay before the bill is reviewed, so
    // every night of a multi-night booking is on the final bill.
    const property = await db.get('SELECT * FROM properties WHERE id = ?', [req.user.property_id]);
    await db.transaction(async (conn) => {
      await postStayRoomNights(conn, { stay, userId: req.user.id, checkoutDate });
      if (property) {
        await postLocalTaxForStay(conn, property, stay, {
          userId: req.user.id,
          nights: billableNights(stay, checkoutDate)
        });
      }
    });

    const preview = await buildCheckoutPreview(db, id, req.user.property_id, { checkout_date: checkoutDate });
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

      await releaseStayAllocation(conn, {
        propertyId: req.user.property_id,
        stayId: id,
        reservationId: stay.reservation_id,
        userId: req.user.id,
        reason: 'Checked out'
      });
      await conn.run(
        "UPDATE rooms SET operational_status = 'available', housekeeping_status = 'dirty' WHERE id = ? AND property_id = ?",
        [stay.room_id, req.user.property_id]
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

      // The permanent room QR stays; only the stay-bound guest sessions end.
      await conn.run(
        "UPDATE guest_sessions SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, revoked_by = ? WHERE stay_id = ?",
        [req.user.id, id]
      );

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

// POST /api/v1/stays/:id/checkout-payment
// One combined financial checkout: server computes room + restaurant + local tax,
// applies optional rounding, collects the balance, issues the invoice and closes
// the stay. The browser never sends a payable amount.
router.post('/:id/checkout-payment', authenticateToken, requireRoles(...CHECKOUT_ROLES), async (req, res) => {
  try {
    const method = String(req.body.payment_method || '').toLowerCase();
    if (!['cash', 'upi', 'card'].includes(method)) {
      return res.status(400).json({ success: false, error: 'Choose Cash, UPI or Card' });
    }
    const key = String(req.headers['idempotency-key'] || req.body.idempotency_key || '').trim() || null;
    const refundAcknowledged = Boolean(req.body.refund_acknowledged);

    const result = await db.transaction(async (conn) => {
      const stay = await conn.get(
        `SELECT s.*, r.room_number, f.id AS folio_id, f.folio_number, f.status AS folio_status
         FROM stays s
         JOIN rooms r ON s.room_id = r.id
         JOIN folios f ON f.stay_id = s.id
         WHERE s.id = ? AND s.property_id = ?
         ORDER BY f.created_at DESC LIMIT 1`,
        [req.params.id, req.user.property_id]
      );
      if (!stay) {
        const error = new Error('Stay not found for this property');
        error.statusCode = 404;
        throw error;
      }

      if (key) {
        const replay = await conn.get(
          "SELECT * FROM idempotency_records WHERE property_id = ? AND scope = 'checkout' AND idempotency_key = ?",
          [req.user.property_id, key]
        );
        if (replay) {
          const invoice = await conn.get('SELECT * FROM invoices WHERE folio_id = ? ORDER BY created_at DESC LIMIT 1', [stay.folio_id]);
          return { duplicate: true, stay, invoice: invoice || null, payment: null, preview: null };
        }
      }

      if (stay.status === 'checked_out') {
        const error = new Error('This stay is already checked out');
        error.statusCode = 409;
        throw error;
      }
      if (stay.folio_status === 'closed') {
        const error = new Error('The guest folio is already closed');
        error.statusCode = 409;
        throw error;
      }

      const property = await conn.get('SELECT * FROM properties WHERE id = ?', [req.user.property_id]);
      if (!property) throw new Error('Property not found');

      const checkoutDate = req.body.checkout_date || null;
      await postStayRoomNights(conn, { stay, userId: req.user.id, checkoutDate });
      await postLocalTaxForStay(conn, property, stay, {
        userId: req.user.id,
        nights: billableNights(stay, checkoutDate)
      });
      const rounding = await applyCheckoutRounding(conn, {
        property, folioId: stay.folio_id, stayId: stay.id, userId: req.user.id
      });

      let preview = await buildCheckoutPreview(conn, stay.id, req.user.property_id, { checkout_date: checkoutDate });
      if (!preview) throw new Error('Stay could not be loaded for checkout');

      let refundDue = round2(preview.totals.refund_due);
      if (refundDue > 0.004 && !refundAcknowledged) {
        const error = new Error(`Guest is owed a refund of ${preview.property.currency_symbol || 'Rs'}${refundDue.toFixed(2)}. Process or acknowledge the refund before checkout.`);
        error.statusCode = 409;
        error.details = { refund_due: refundDue, requires_refund_acknowledgement: true };
        throw error;
      }

      const payable = round2(preview.totals.balance_due);
      let payment = null;
      if (payable > 0.004) {
        const receipt = await recordPayment(conn, {
          propertyId: req.user.property_id,
          folioId: stay.folio_id,
          amount: payable,
          paymentMethod: method,
          paymentType: 'settlement',
          cashierId: req.user.id,
          transactionRef: req.body.transaction_ref || null,
          notes: `Combined checkout payment for Room ${stay.room_number}`,
          idempotencyKey: key ? `checkout-payment:${key}` : null,
          device: req.headers['user-agent'] || null,
          receiptPayload: {
            document_label: 'CHECKOUT PAYMENT RECEIPT',
            is_tax_invoice: false,
            disclaimer: 'This document acknowledges money received. It is not a tax invoice.',
            folio_number: stay.folio_number,
            room_number: stay.room_number,
            amount: payable,
            payment_method: method,
            transaction_ref: req.body.transaction_ref || null,
            received_at: new Date().toISOString()
          }
        });
        payment = receipt.payment;

        const shift = await conn.get(
          "SELECT id FROM cashier_shifts WHERE user_id = ? AND status = 'open' ORDER BY opening_time DESC LIMIT 1",
          [req.user.id]
        );
        if (shift) {
          let field = 'total_cash';
          if (method === 'card') field = 'total_card';
          else if (method === 'upi') field = 'total_upi';
          await conn.run(`UPDATE cashier_shifts SET ${field} = ${field} + ? WHERE id = ?`, [payable, shift.id]);
        }
      }

      preview = await buildCheckoutPreview(conn, stay.id, req.user.property_id);
      const snapshot = await confirmCheckoutPreview(conn, {
        propertyId: req.user.property_id,
        stayId: stay.id,
        preview,
        userId: req.user.id,
        notes: 'Confirmed by combined checkout payment'
      });
      const invoiceResult = await createFolioInvoice(conn, {
        propertyId: req.user.property_id,
        folioId: stay.folio_id,
        userId: req.user.id,
        snapshotId: snapshot.id
      });

      const checkOutTime = new Date().toISOString().replace('T', ' ').substring(0, 19);
      await conn.run(
        "UPDATE stays SET status = 'checked_out', actual_check_out_time = ?, checked_out_by = ? WHERE id = ? AND property_id = ?",
        [checkOutTime, req.user.id, stay.id, req.user.property_id]
      );
      await conn.run(
        "UPDATE folios SET status = 'closed', closed_at = CURRENT_TIMESTAMP, closed_by = ? WHERE id = ?",
        [req.user.id, stay.folio_id]
      );
      await releaseStayAllocation(conn, {
        propertyId: req.user.property_id,
        stayId: stay.id,
        reservationId: stay.reservation_id,
        userId: req.user.id,
        reason: 'Checked out with payment'
      });
      await conn.run(
        "UPDATE rooms SET operational_status = 'available', housekeeping_status = 'dirty' WHERE id = ? AND property_id = ?",
        [stay.room_id, req.user.property_id]
      );
      await conn.run(
        `INSERT INTO housekeeping_tasks (id, property_id, room_id, task_type, status, priority, notes)
         VALUES (?, ?, ?, 'checkout_cleaning', 'dirty', 'high', ?)`,
        [uuidv4(), req.user.property_id, stay.room_id, `Checkout cleaning for Room ${stay.room_number}`]
      );
      if (stay.reservation_id) {
        await conn.run(
          "UPDATE reservations SET status = 'checked_out', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND property_id = ?",
          [stay.reservation_id, req.user.property_id]
        );
      }
      if (stay.group_room_reservation_id) {
        await conn.run(
          "UPDATE group_room_reservations SET status = 'checked_out', actual_check_out = ? WHERE id = ?",
          [checkOutTime, stay.group_room_reservation_id]
        );
      }

      await conn.run(
        "UPDATE guest_sessions SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, revoked_by = ? WHERE stay_id = ?",
        [req.user.id, stay.id]
      );
      await recalcFolio(conn, stay.folio_id);

      if (key) {
        await conn.run(
          `INSERT OR IGNORE INTO idempotency_records (id, property_id, scope, idempotency_key, reference_id)
           VALUES (?, ?, 'checkout', ?, ?)`,
          [uuidv4(), req.user.property_id, key, stay.id]
        );
      }

      return {
        duplicate: false,
        stay,
        preview,
        invoice: invoiceResult.invoice,
        payment,
        rounding,
        payable,
        refund_due: refundDue
      };
    });

    if (result.duplicate) {
      return res.json({
        success: true,
        duplicate: true,
        message: 'This checkout was already completed.',
        invoice: result.invoice
      });
    }

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'COMBINED_CHECKOUT_PAYMENT',
      entityType: 'stay',
      entityId: result.stay.id,
      details: {
        room_number: result.stay.room_number,
        payable: result.payable,
        payment_method: method,
        receipt_number: result.payment ? result.payment.receipt_number : null,
        rounding_adjustment: result.rounding ? result.rounding.adjustment : 0,
        invoice_number: result.invoice ? result.invoice.invoice_number : null,
        refund_due: result.refund_due
      },
      req
    });

    res.json({
      success: true,
      message: `Room ${result.stay.room_number} checked out. Invoice and receipt generated.`,
      duplicate: false,
      stay_number: result.stay.stay_number,
      room_number: result.stay.room_number,
      payment: result.payment ? {
        receipt_number: result.payment.receipt_number,
        amount: result.payment.amount,
        payment_method: result.payment.payment_method
      } : null,
      amount_collected: result.payable,
      rounding: {
        enabled: Boolean(result.rounding && result.rounding.applied),
        adjustment: result.rounding ? result.rounding.adjustment : 0
      },
      refund_due: result.refund_due,
      invoice: result.invoice,
      totals: result.preview ? result.preview.totals : null,
      invoice_pdf_url: `/api/v1/folios/${result.stay.folio_id}/invoice/pdf`
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({
      success: false,
      error: err.message,
      ...(err.details || {})
    });
  }
});

// POST /api/v1/stays/:id/room-move (Transfer guest to another room)
router.post('/:id/room-move', authenticateToken, requireRoles(...STAY_WRITE_ROLES), async (req, res) => {
  try {
    const { id } = req.params;
    const { target_room_id, reason } = req.body;

    if (!target_room_id) return res.status(400).json({ success: false, error: 'target_room_id is required' });
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ success: false, error: 'A reason is required for a room change' });
    }

    const result = await db.transaction(async (conn) => {
      const property = await conn.get('SELECT * FROM properties WHERE id = ?', [req.user.property_id]);
      return transferStayRoom(conn, {
        propertyId: req.user.property_id,
        stayId: id,
        newRoomId: target_room_id,
        userId: req.user.id,
        reason: String(reason).trim(),
        property
      });
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'ROOM_MOVE',
      entityType: 'stay',
      entityId: id,
      details: {
        from: result.previous_room_number,
        to: result.room.room_number,
        reason,
        guest_session_updated: true
      },
      req
    });

    res.json({
      success: true,
      message: `Guest moved from Room ${result.previous_room_number} to Room ${result.room.room_number}`,
      room: result.room,
      previous_room_id: result.previous_room_id
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/stays/:id/whatsapp — pre-filled WhatsApp message for the final bill
router.get('/:id/whatsapp', authenticateToken, requireRoles(...CHECKOUT_ROLES), async (req, res) => {
  try {
    const preview = await buildCheckoutPreview(db, req.params.id, req.user.property_id);
    if (!preview) return res.status(404).json({ success: false, error: 'Stay not found for this property' });

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
router.post('/:id/extend', authenticateToken, requireRoles(...STAY_WRITE_ROLES), async (req, res) => {
  try {
    const nights = Number(req.body.nights);
    if (!Number.isInteger(nights) || nights < 1 || nights > 365) {
      return res.status(400).json({ success: false, error: 'Extension must be a whole number of nights between 1 and 365' });
    }

    const stay = await db.get(
      `SELECT s.*, r.room_number FROM stays s JOIN rooms r ON s.room_id = r.id
       WHERE s.id = ? AND s.property_id = ?`,
      [req.params.id, req.user.property_id]
    );
    if (!stay) return res.status(404).json({ success: false, error: 'Stay not found for this property' });
    if (stay.status !== 'occupied') {
      return res.status(400).json({ success: false, error: 'Only an occupied stay can be extended' });
    }

    const base = new Date(`${String(stay.expected_check_out).slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(base.getTime())) {
      return res.status(400).json({ success: false, error: 'The stay has an invalid departure date' });
    }
    base.setUTCDate(base.getUTCDate() + nights);
    const newCheckOut = base.toISOString().slice(0, 10);

    const property = await db.get('SELECT * FROM properties WHERE id = ?', [req.user.property_id]);
    await db.transaction(async (conn) => {
      await conn.run('UPDATE stays SET expected_check_out = ? WHERE id = ? AND property_id = ?', [newCheckOut, stay.id, req.user.property_id]);
      if (stay.reservation_id) {
        await conn.run(
          `UPDATE reservations SET check_out_date = ?, updated_at = CURRENT_TIMESTAMP, version = version + 1
           WHERE id = ? AND property_id = ?`,
          [newCheckOut, stay.reservation_id, req.user.property_id]
        );
      }
      const freshStay = await conn.get('SELECT * FROM stays WHERE id = ?', [stay.id]);
      await postLocalTaxForStay(conn, property, freshStay, { userId: req.user.id });
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
