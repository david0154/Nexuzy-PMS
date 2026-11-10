const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const { authenticateToken, requireRoles } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');

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
    if (room.operational_status === 'occupied') {
      return res.status(400).json({ success: false, error: `Room ${room.room_number} is already occupied` });
    }

    const checkInTime = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const stayId = uuidv4();
    const stayNo = `STY-${Date.now().toString().slice(-6)}-${room.room_number}`;
    const folioId = uuidv4();
    const folioNo = `FOL-${room.room_number}-${Date.now().toString().slice(-4)}`;

    await db.transaction(async () => {
      // 1. Create Stay
      await db.run(
        `INSERT INTO stays (id, stay_number, property_id, reservation_id, room_id, primary_guest_id, check_in_time, expected_check_out, status, nightly_rate, adults, children)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'occupied', ?, ?, ?)`,
        [stayId, stayNo, req.user.property_id, reservation_id, roomId, resv.guest_id, checkInTime, resv.check_out_date, resv.rate_per_night, resv.adult_count, resv.child_count]
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
        `INSERT INTO stays (id, stay_number, property_id, room_id, primary_guest_id, check_in_time, expected_check_out, status, nightly_rate)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'occupied', ?)`,
        [stayId, stayNo, req.user.property_id, room_id, guestId, checkInTime, expectedCheckOut, rate_per_night]
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

// POST /api/v1/stays/:id/check-out (Check out an individual stay)
router.post('/:id/check-out', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { allow_override = false, override_reason } = req.body;

    const stay = await db.get(
      `SELECT s.*, r.room_number, f.id as folio_id, f.balance, f.property_id as folio_property_id, f.status as folio_status
       FROM stays s
       JOIN rooms r ON s.room_id = r.id
       LEFT JOIN folios f ON f.stay_id = s.id
       WHERE s.id = ? AND s.property_id = ?`,
      [id, req.user.property_id]
    );

    if (!stay) return res.status(404).json({ success: false, error: 'Stay not found' });
    if (stay.status === 'checked_out') return res.status(400).json({ success: false, error: 'Stay is already checked out' });

    const outstanding = Number(stay.balance || 0);
    const overrideAuthorized = allow_override === true && ['admin', 'general_manager'].includes(req.user.role) &&
      typeof override_reason === 'string' && override_reason.trim().length >= 8;
    if (outstanding > 0.005 && !overrideAuthorized) {
      return res.status(409).json({
        success: false,
        error: `Cannot checkout: Room ${stay.room_number} has an unpaid folio balance of ₹${outstanding.toFixed(2)}. Settle folio first or obtain an authorised manager override with a reason.`
      });
    }
    if (stay.folio_id && (stay.folio_property_id !== req.user.property_id || stay.folio_status === 'closed')) {
      return res.status(409).json({ success: false, error: 'Folio state does not permit checkout' });
    }

    const checkOutTime = new Date().toISOString().replace('T', ' ').substring(0, 19);

    await db.transaction(async () => {
      // 1. Mark stay checked out
      await db.run('UPDATE stays SET status = \'checked_out\', actual_check_out_time = ? WHERE id = ?', [checkOutTime, id]);

      // 2. Mark folio settled/closed
      if (stay.folio_id) {
        await db.run("UPDATE folios SET status = 'closed' WHERE id = ?", [stay.folio_id]);
      }

      // 3. Mark room available but DIRTY for housekeeping (PRD Section 5.4 & 9)
      await db.run("UPDATE rooms SET operational_status = 'available', housekeeping_status = 'dirty' WHERE id = ?", [stay.room_id]);

      // 4. Auto-generate housekeeping checkout cleaning task
      await db.run(
        `INSERT INTO housekeeping_tasks (id, property_id, room_id, task_type, status, priority, notes)
         VALUES (?, ?, ?, 'checkout_cleaning', 'dirty', 'high', ?)`,
        [uuidv4(), req.user.property_id, stay.room_id, `Checkout cleaning for Room ${stay.room_number}`]
      );
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'CHECK_OUT_STAY',
      entityType: 'stay',
      entityId: id,
      details: { room_number: stay.room_number, folio_balance: stay.balance, override_used: overrideAuthorized, override_reason: overrideAuthorized ? override_reason.trim() : null },
      req
    });

    res.json({ success: true, message: `Room ${stay.room_number} checked out successfully. Housekeeping notified.` });
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

module.exports = router;
