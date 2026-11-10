const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const { authenticateToken } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');

// GET /api/v1/guests
router.get('/guests', authenticateToken, async (req, res) => {
  try {
    const { search } = req.query;
    let query = 'SELECT * FROM guests';
    const params = [];
    if (search) {
      query += ` WHERE first_name LIKE ? OR last_name LIKE ? OR phone LIKE ? OR email LIKE ?`;
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }
    query += ' ORDER BY created_at DESC LIMIT 50';
    const guests = await db.all(query, params);
    res.json({ success: true, guests });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/guests
router.post('/guests', authenticateToken, async (req, res) => {
  try {
    const { first_name, last_name, phone, email, id_type, id_number, address, city, state, company_name, gstin } = req.body;
    if (!first_name || !phone) {
      return res.status(400).json({ success: false, error: 'First name and phone are required' });
    }

    const id = uuidv4();
    await db.run(
      `INSERT INTO guests (id, property_id, first_name, last_name, phone, email, id_type, id_number, address, city, state, company_name, gstin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.user.property_id, first_name, last_name, phone, email, id_type, id_number, address, city, state, company_name, gstin]
    );

    const guest = await db.get('SELECT * FROM guests WHERE id = ?', [id]);
    res.json({ success: true, guest });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/reservations
router.get('/', authenticateToken, async (req, res) => {
  try {
    const reservations = await db.all(
      `SELECT res.*, 
              g.first_name || ' ' || COALESCE(g.last_name, '') as guest_name,
              g.phone as guest_phone, g.email as guest_email,
              rt.name as room_type_name,
              r.room_number
       FROM reservations res
       JOIN guests g ON res.guest_id = g.id
       JOIN room_types rt ON res.room_type_id = rt.id
       LEFT JOIN rooms r ON res.assigned_room_id = r.id
       ORDER BY res.check_in_date DESC`
    );
    res.json({ success: true, reservations });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/reservations (Double-Booking Protected Transaction)
router.post('/', authenticateToken, async (req, res) => {
  try {
    const {
      guest_id, guest_data,
      check_in_date, check_out_date,
      room_type_id, assigned_room_id,
      adult_count, child_count,
      rate_per_night, deposit_amount,
      booking_source, special_requests
    } = req.body;

    if (!check_in_date || !check_out_date || !room_type_id) {
      return res.status(400).json({ success: false, error: 'Check-in, check-out dates and room type are required' });
    }

    let finalGuestId = guest_id;

    // Execute in transaction
    const result = await db.transaction(async () => {
      // 1. If new guest provided, create profile
      if (!finalGuestId && guest_data) {
        finalGuestId = uuidv4();
        await db.run(
          `INSERT INTO guests (id, property_id, first_name, last_name, phone, email, id_type, id_number, city, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            finalGuestId,
            req.user.property_id,
            guest_data.first_name,
            guest_data.last_name || null,
            guest_data.phone,
            guest_data.email || null,
            guest_data.id_type || null,
            guest_data.id_number || null,
            guest_data.city || null,
            guest_data.state || null
          ]
        );
      }

      if (!finalGuestId) {
        throw new Error('Valid guest ID or guest details required');
      }

      // 2. Overlapping booking check if specific room is requested
      if (assigned_room_id) {
        const conflict = await db.get(
          `SELECT r.room_number FROM rooms r
           WHERE r.id = ? AND (
             r.operational_status = 'out_of_order'
             OR EXISTS (
               SELECT 1 FROM stays s 
               WHERE s.room_id = r.id AND s.status = 'occupied'
                 AND date(s.check_in_time) < date(?) AND date(s.expected_check_out) > date(?)
             )
             OR EXISTS (
               SELECT 1 FROM reservations res
               WHERE res.assigned_room_id = r.id AND res.status = 'confirmed'
                 AND date(res.check_in_date) < date(?) AND date(res.check_out_date) > date(?)
             )
             OR EXISTS (
               SELECT 1 FROM group_room_reservations gr
               WHERE gr.assigned_room_id = r.id AND gr.status IN ('reserved', 'checked_in')
                 AND date(gr.planned_check_in) < date(?) AND date(gr.planned_check_out) > date(?)
             )
           )`,
          [assigned_room_id, check_out_date, check_in_date, check_out_date, check_in_date, check_out_date, check_in_date]
        );

        if (conflict) {
          throw new Error(`Double booking prevented: Room ${conflict.room_number} is already reserved/occupied for selected dates.`);
        }
      }

      const resId = uuidv4();
      const bookingRef = `RES-${Date.now().toString().slice(-6)}`;
      const depositPaid = Number(deposit_amount) || 0;

      await db.run(
        `INSERT INTO reservations 
         (id, booking_reference, property_id, guest_id, check_in_date, check_out_date, room_type_id, assigned_room_id, adult_count, child_count, rate_per_night, deposit_required, deposit_paid, status, booking_source, special_requests)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)`,
        [
          resId,
          bookingRef,
          req.user.property_id,
          finalGuestId,
          check_in_date,
          check_out_date,
          room_type_id,
          assigned_room_id || null,
          adult_count || 1,
          child_count || 0,
          rate_per_night,
          depositPaid,
          depositPaid,
          booking_source || 'direct',
          special_requests || null
        ]
      );

      // Record Advance Payment Receipt if deposit was collected (Section 35.1)
      if (depositPaid > 0) {
        const paymentId = uuidv4();
        const receiptNo = `REC-ADV-${Date.now().toString().slice(-6)}`;
        await db.run(
          `INSERT INTO payments (id, receipt_number, property_id, reservation_id, amount, payment_method, payment_type, cashier_id, notes)
           VALUES (?, ?, ?, ?, ?, 'upi', 'advance_deposit', ?, 'Advance deposit at reservation creation')`,
          [paymentId, receiptNo, req.user.property_id, resId, depositPaid, req.user.id]
        );
      }

      return { resId, bookingRef };
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'CREATE_RESERVATION',
      entityType: 'reservation',
      entityId: result.resId,
      details: { bookingRef: result.bookingRef, check_in_date, check_out_date },
      req
    });

    res.json({
      success: true,
      message: 'Reservation created successfully',
      bookingReference: result.bookingRef,
      reservationId: result.resId
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/v1/reservations/:id/cancel
router.post('/:id/cancel', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    await db.run("UPDATE reservations SET status = 'cancelled' WHERE id = ?", [id]);

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'CANCEL_RESERVATION',
      entityType: 'reservation',
      entityId: id,
      details: { reason },
      req
    });

    res.json({ success: true, message: 'Reservation cancelled' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
