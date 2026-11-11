const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const { authenticateToken, requireRoles } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');
const {
  nextDocumentNumber,
  insertDocument,
  getBookingContext,
  buildBookingDocumentPayload
} = require('../../services/documents');
const { recordPayment, round2 } = require('../../services/billing');
const { sendDocumentEmail } = require('../../services/mailer');
const { sendInvoicePdf } = require('../../services/pdf');
const { normalizePhone, whatsappUrl, formatMoney } = require('../../services/whatsapp');

const BOOKING_ROLES = ['admin', 'general_manager', 'front_desk', 'cashier'];
const APPROVER_ROLES = ['admin', 'general_manager'];

function idempotencyKey(req, body = {}) {
  return req.headers['idempotency-key'] || body.idempotency_key || null;
}

function nightsBetween(checkIn, checkOut) {
  const nights = Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000);
  return Number.isFinite(nights) ? nights : 0;
}

async function roomConflict(conn, roomId, checkIn, checkOut, excludeReservationId = null) {
  const room = await conn.get('SELECT * FROM rooms WHERE id = ?', [roomId]);
  if (!room) return 'Selected room does not exist';
  if (['out_of_order', 'out_of_service', 'blocked'].includes(room.operational_status)) {
    return `Room ${room.room_number} is ${room.operational_status.replace(/_/g, ' ')} and cannot be sold`;
  }

  const stay = await conn.get(
    `SELECT room_number FROM rooms WHERE id = ? AND EXISTS (
       SELECT 1 FROM stays s
       WHERE s.room_id = rooms.id AND s.status = 'occupied'
         AND date(s.check_in_time) < date(?) AND date(s.expected_check_out) > date(?)
     )`,
    [roomId, checkOut, checkIn]
  );
  if (stay) return `Double booking prevented: Room ${room.room_number} is already occupied for selected dates.`;

  const reservation = await conn.get(
    `SELECT r.room_number FROM rooms r
     WHERE r.id = ? AND EXISTS (
       SELECT 1 FROM reservations res
       WHERE res.assigned_room_id = r.id
         AND res.status IN ('confirmed','awaiting_advance','tentative','partially_paid','fully_prepaid','checked_in')
         AND (? IS NULL OR res.id != ?)
         AND date(res.check_in_date) < date(?) AND date(res.check_out_date) > date(?)
     )`,
    [roomId, excludeReservationId, excludeReservationId, checkOut, checkIn]
  );
  if (reservation) return `Double booking prevented: Room ${reservation.room_number} is already reserved for selected dates.`;

  const group = await conn.get(
    `SELECT r.room_number FROM rooms r
     WHERE r.id = ? AND EXISTS (
       SELECT 1 FROM group_room_reservations gr
       WHERE gr.assigned_room_id = r.id
         AND gr.status IN ('reserved','checked_in')
         AND date(gr.planned_check_in) < date(?) AND date(gr.planned_check_out) > date(?)
     )`,
    [roomId, checkOut, checkIn]
  );
  if (group) return `Double booking prevented: Room ${group.room_number} is held by a group reservation for selected dates.`;
  return null;
}

async function priceStay(conn, roomTypeId, ratePerNight, checkIn, checkOut) {
  const roomType = await conn.get('SELECT * FROM room_types WHERE id = ?', [roomTypeId]);
  if (!roomType) throw new Error('Room type not found');
  const nights = Math.max(1, nightsBetween(checkIn, checkOut));
  const roomTotal = round2(Number(ratePerNight) * nights);
  const tax = round2(roomTotal * (Number(roomType.tax_rate || 0) / 100));
  return { roomType, nights, roomTotal, tax, total: round2(roomTotal + tax) };
}

async function issueBookingDocument(conn, { reservation, documentType, userId, propertyId }) {
  if (documentType === 'booking_confirmation' &&
      !['confirmed', 'checked_in', 'checked_out'].includes(reservation.status)) {
    throw new Error('Booking confirmation cannot be issued until the booking is confirmed.');
  }
  const payload = await buildBookingDocumentPayload(conn, reservation.id, documentType);
  const number = await nextDocumentNumber(conn, propertyId, documentType);
  let version = 1;
  if (documentType === 'booking_confirmation') {
    const previous = await conn.get(
      `SELECT COUNT(*) AS count FROM booking_documents
       WHERE reservation_id = ? AND document_type = 'booking_confirmation'`,
      [reservation.id]
    );
    version = Number(previous.count) + 1;
    await conn.run(
      `UPDATE booking_documents SET status = 'superseded'
       WHERE reservation_id = ? AND document_type = 'booking_confirmation' AND status = 'issued'`,
      [reservation.id]
    );
  }
  const id = await insertDocument(conn, {
    propertyId,
    reservationId: reservation.id,
    documentType,
    documentNumber: number,
    version,
    payload,
    totalAmount: payload.price_summary.total_amount,
    balanceAmount: payload.price_summary.balance_due,
    issuedBy: userId
  });
  return conn.get('SELECT * FROM booking_documents WHERE id = ?', [id]);
}

async function refundReservation(conn, { reservation, amount, method, reason, userId, propertyId, transactionRef = null }) {
  const refundAmount = round2(amount);
  if (!(refundAmount > 0)) throw new Error('Valid refund amount required');
  if (!reason) throw new Error('Refund reason is required');

  const ctx = await getBookingContext(conn, reservation.id);
  if (refundAmount > ctx.totals.net_advance + 0.004) {
    throw new Error(`Refund exceeds the net advance received (${ctx.totals.net_advance})`);
  }

  const refundNo = await nextDocumentNumber(conn, propertyId, 'credit_note');
  const refundId = uuidv4();
  await conn.run(
    `INSERT INTO payment_refunds
     (id, receipt_number, property_id, reservation_id, folio_id, amount, refund_method,
      reason, transaction_ref, approved_by, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      refundId, refundNo, propertyId, reservation.id, reservation.folio_id || null,
      refundAmount, method || 'cash', reason, transactionRef, userId, userId
    ]
  );

  await insertDocument(conn, {
    propertyId,
    reservationId: reservation.id,
    documentType: 'credit_note',
    documentNumber: refundNo,
    payload: {
      document_label: 'CREDIT NOTE / REFUND VOUCHER',
      is_tax_invoice: false,
      disclaimer: 'This records an authorised refund against a booking advance. It is not a tax invoice.',
      booking_reference: reservation.booking_reference,
      amount: refundAmount,
      method: method || 'cash',
      reason,
      issued_at: new Date().toISOString()
    },
    totalAmount: refundAmount,
    issuedBy: userId
  });

  const refunded = await conn.get(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM payment_refunds WHERE reservation_id = ?',
    [reservation.id]
  );
  const advances = await conn.get(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM payments
     WHERE reservation_id = ? AND payment_type = 'advance_deposit'
       AND COALESCE(status, 'posted') = 'posted'`,
    [reservation.id]
  );
  const net = round2(Number(advances.total) - Number(refunded.total));
  const total = Number(reservation.total_amount) || 0;
  const paymentStatus = net <= 0
    ? 'refunded'
    : (total > 0 && net >= total - 0.004 ? 'fully_prepaid' : 'partially_paid');
  await conn.run(
    `UPDATE reservations
     SET refunded_amount = ?, payment_status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [round2(refunded.total), paymentStatus, reservation.id]
  );

  return { id: refundId, receipt_number: refundNo, amount: refundAmount };
}

function shiftDate(date, days) {
  const base = new Date(`${String(date).slice(0, 10)}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + Number(days || 0));
  return base.toISOString().slice(0, 10);
}

// Printable booking bill: the reserved stay plus every advance received.
// It is deliberately not a tax invoice; the GST invoice is issued at checkout.
function buildBookingBillInvoice(ctx) {
  const r = ctx.reservation;
  const roomTotal = round2(Number(r.rate_per_night) * ctx.nights);
  const tax = round2(Math.max(0, Number(ctx.totals.total_amount) - roomTotal));
  return {
    invoice_number: r.booking_reference,
    date: new Date().toISOString().slice(0, 10),
    document_label: 'BOOKING BILL / ADVANCE INVOICE',
    is_tax_invoice: false,
    disclaimer: 'Booking bill showing the reserved stay and advances received. The GST tax invoice is issued at checkout.',
    property: {
      name: r.property_name,
      address: r.property_address,
      city: r.property_city,
      state: r.property_state,
      gstin: r.property_gstin,
      phone: r.property_phone,
      email: r.property_email,
      logo_url: r.logo_url,
      bank_name: r.bank_name,
      bank_account_number: r.bank_account_number,
      bank_ifsc: r.bank_ifsc,
      upi_id: r.upi_id
    },
    customer: {
      name: r.guest_name,
      company: r.guest_company,
      gstin: r.guest_gstin,
      phone: r.guest_phone
    },
    booking_reference: r.booking_reference,
    room_number: r.room_number,
    payment_method: ctx.payments.length ? ctx.payments[0].payment_method : null,
    items: [{
      description: `${r.room_type_name} stay: ${ctx.nights} night(s), ${r.check_in_date} to ${r.check_out_date}`,
      hsn_sac: r.hsn_sac || '996311',
      quantity: ctx.nights,
      unit_price: Number(r.rate_per_night),
      tax_rate: Number(r.room_tax_rate || 0),
      tax_amount: tax,
      total_amount: round2(roomTotal + tax)
    }],
    subtotal: roomTotal,
    total_tax: tax,
    grand_total: ctx.totals.total_amount,
    paid_amount: ctx.totals.net_advance,
    balance_due: ctx.totals.balance_due,
    currency_symbol: r.currency_symbol || '₹'
  };
}

// ---------------------------------------------------------------
// Guests
// ---------------------------------------------------------------
router.get('/guests', authenticateToken, async (req, res) => {
  try {
    const { search } = req.query;
    let query = 'SELECT * FROM guests';
    const params = [];
    if (search) {
      query += ' WHERE first_name LIKE ? OR last_name LIKE ? OR phone LIKE ? OR email LIKE ?';
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

// ---------------------------------------------------------------
// Reservations list / detail
// ---------------------------------------------------------------
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { status, payment_status, from, to, search } = req.query;
    const where = ['res.property_id = ?'];
    const params = [req.user.property_id];
    if (status) { where.push('res.status = ?'); params.push(status); }
    if (payment_status) { where.push('res.payment_status = ?'); params.push(payment_status); }
    if (from) { where.push('date(res.check_in_date) >= date(?)'); params.push(from); }
    if (to) { where.push('date(res.check_in_date) <= date(?)'); params.push(to); }
    if (search) {
      where.push("(res.booking_reference LIKE ? OR g.first_name LIKE ? OR g.last_name LIKE ? OR g.phone LIKE ?)");
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }

    const reservations = await db.all(
      `SELECT res.*,
              g.first_name || ' ' || COALESCE(g.last_name, '') as guest_name,
              g.phone as guest_phone, g.email as guest_email,
              rt.name as room_type_name,
              r.room_number,
              (SELECT COUNT(*) FROM booking_documents bd WHERE bd.reservation_id = res.id) as document_count
       FROM reservations res
       JOIN guests g ON res.guest_id = g.id
       JOIN room_types rt ON res.room_type_id = rt.id
       LEFT JOIN rooms r ON res.assigned_room_id = r.id
       WHERE ${where.join(' AND ')}
       ORDER BY res.check_in_date DESC, res.created_at DESC`,
      params
    );
    res.json({ success: true, reservations });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const ctx = await getBookingContext(db, req.params.id);
    if (!ctx) return res.status(404).json({ success: false, error: 'Reservation not found' });

    const documents = await db.all(
      `SELECT id, document_type, document_number, version, status, delivery_status,
              delivery_note, total_amount, balance_amount, issued_by, sent_at, created_at
       FROM booking_documents WHERE reservation_id = ? ORDER BY created_at DESC`,
      [req.params.id]
    );
    const history = await db.all(
      `SELECT id, action, details, user_id, created_at FROM audit_logs
       WHERE entity_type = 'reservation' AND entity_id = ?
       ORDER BY created_at DESC LIMIT 50`,
      [req.params.id]
    );
    res.json({
      success: true,
      reservation: ctx.reservation,
      payments: ctx.payments,
      refunds: ctx.refunds,
      documents,
      history,
      totals: ctx.totals,
      nights: ctx.nights
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// Create reservation (double-booking protected transaction)
// ---------------------------------------------------------------
router.post('/', authenticateToken, requireRoles(...BOOKING_ROLES), async (req, res) => {
  try {
    const {
      guest_id, guest_data,
      check_in_date, check_out_date,
      room_type_id, assigned_room_id,
      adult_count, child_count,
      rate_per_night, deposit_amount, deposit_method,
      booking_source, special_requests,
      rate_plan, idempotency_key: bodyIdempotency
    } = req.body;

    if (!check_in_date || !check_out_date || !room_type_id) {
      return res.status(400).json({ success: false, error: 'Check-in, check-out dates and room type are required' });
    }
    if (nightsBetween(check_in_date, check_out_date) <= 0) {
      return res.status(400).json({ success: false, error: 'Check-out date must be after check-in date' });
    }

    const property = await db.get('SELECT * FROM properties WHERE id = ?', [req.user.property_id]);
    const pricing = await priceStay(db, room_type_id, rate_per_night, check_in_date, check_out_date);
    if (!(Number(rate_per_night) > 0)) {
      return res.status(400).json({ success: false, error: 'A valid nightly rate is required' });
    }

    const policyRequiresAdvance = Boolean(property && property.require_advance_for_confirmation);
    const advanceRequired = policyRequiresAdvance
      ? round2(pricing.total * (Number(property.advance_percentage || 0) / 100))
      : 0;
    const deposit = round2(deposit_amount);
    const paymentStatus = deposit <= 0 ? 'unpaid' : (deposit >= pricing.total ? 'fully_prepaid' : 'partially_paid');
    const status = policyRequiresAdvance && deposit + 0.004 < advanceRequired ? 'awaiting_advance' : 'confirmed';
    const dueDate = property && property.advance_due_days
      ? new Date(Date.now() + Number(property.advance_due_days) * 86400000).toISOString().slice(0, 10)
      : null;

    const result = await db.transaction(async (conn) => {
      let finalGuestId = guest_id;
      if (!finalGuestId && guest_data) {
        finalGuestId = uuidv4();
        await conn.run(
          `INSERT INTO guests (id, property_id, first_name, last_name, phone, email, id_type, id_number, city, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            finalGuestId, req.user.property_id, guest_data.first_name,
            guest_data.last_name || null, guest_data.phone,
            guest_data.email || null, guest_data.id_type || null,
            guest_data.id_number || null, guest_data.city || null, guest_data.state || null
          ]
        );
      }
      if (!finalGuestId) throw new Error('Valid guest ID or guest details required');

      if (assigned_room_id) {
        const conflict = await roomConflict(conn, assigned_room_id, check_in_date, check_out_date);
        if (conflict) throw new Error(conflict);
      }

      const resId = uuidv4();
      const bookingRef = `RES-${Date.now().toString().slice(-6)}`;

      await conn.run(
        `INSERT INTO reservations
         (id, booking_reference, property_id, guest_id, check_in_date, check_out_date,
          room_type_id, assigned_room_id, adult_count, child_count, rate_per_night,
          deposit_required, deposit_paid, status, booking_source, special_requests,
          confirmation_required, total_amount, advance_required, advance_due_date,
          payment_status, rate_plan, confirmed_at, confirmed_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          resId, bookingRef, req.user.property_id, finalGuestId, check_in_date, check_out_date,
          room_type_id, assigned_room_id || null, adult_count || 1, child_count || 0,
          Number(rate_per_night), advanceRequired,
          status, booking_source || 'direct', special_requests || null,
          policyRequiresAdvance ? 1 : 0, pricing.total, advanceRequired, dueDate,
          paymentStatus, rate_plan || 'standard',
          status === 'confirmed' ? new Date().toISOString().replace('T', ' ').substring(0, 19) : null,
          status === 'confirmed' ? req.user.id : null
        ]
      );

      let receipt = null;
      if (deposit > 0) {
        const guestRow = await conn.get('SELECT * FROM guests WHERE id = ?', [finalGuestId]);
        const receiptResult = await recordPayment(conn, {
          propertyId: req.user.property_id,
          reservationId: resId,
          amount: deposit,
          paymentMethod: deposit_method || 'cash',
          paymentType: 'advance_deposit',
          cashierId: req.user.id,
          notes: 'Advance deposit at reservation creation',
          idempotencyKey: idempotencyKey(req, { idempotency_key: bodyIdempotency }),
          device: req.headers['user-agent'] || null,
          receiptType: 'advance_receipt',
          receiptPayload: {
            document_label: 'ADVANCE PAYMENT RECEIPT',
            is_tax_invoice: false,
            disclaimer: 'This document acknowledges money received. It is not a tax invoice.',
            booking_reference: bookingRef,
            guest_name: `${guestRow.first_name || ''} ${guestRow.last_name || ''}`.trim(),
            property_name: property ? property.name : 'Nexuzy PMS',
            amount: deposit,
            payment_method: deposit_method || 'cash',
            received_at: new Date().toISOString()
          }
        });
        receipt = receiptResult.payment;
      }

      const saved = await conn.get('SELECT * FROM reservations WHERE id = ?', [resId]);
      return { resId, bookingRef, reservation: saved, receipt };
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'CREATE_RESERVATION',
      entityType: 'reservation',
      entityId: result.resId,
      details: {
        bookingRef: result.bookingRef,
        check_in_date,
        check_out_date,
        status: result.reservation.status,
        total_amount: result.reservation.total_amount,
        advance_required: result.reservation.advance_required,
        advance_received: deposit
      },
      req
    });

    res.json({
      success: true,
      message: result.reservation.status === 'awaiting_advance'
        ? 'Reservation saved and awaiting the required advance.'
        : 'Reservation created successfully',
      bookingReference: result.bookingRef,
      reservationId: result.resId,
      status: result.reservation.status,
      paymentStatus: result.reservation.payment_status,
      totalAmount: result.reservation.total_amount,
      advanceRequired: result.reservation.advance_required,
      receipt: result.receipt
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// Edit reservation with price-difference confirmation
// ---------------------------------------------------------------
router.patch('/:id', authenticateToken, requireRoles(...BOOKING_ROLES), async (req, res) => {
  try {
    const reservation = await db.get('SELECT * FROM reservations WHERE id = ?', [req.params.id]);
    if (!reservation) return res.status(404).json({ success: false, error: 'Reservation not found' });
    if (['checked_out', 'cancelled', 'no_show'].includes(reservation.status)) {
      return res.status(400).json({ success: false, error: `Cannot edit a booking in ${reservation.status} status` });
    }
    if (reservation.status === 'checked_in' &&
        (req.body.check_in_date || req.body.check_out_date || req.body.assigned_room_id)) {
      return res.status(400).json({
        success: false,
        error: 'Use the in-house room move or extension workflow for a checked-in stay'
      });
    }

    const checkIn = req.body.check_in_date || reservation.check_in_date;
    const checkOut = req.body.check_out_date || reservation.check_out_date;
    if (nightsBetween(checkIn, checkOut) <= 0) {
      return res.status(400).json({ success: false, error: 'Check-out date must be after check-in date' });
    }
    const roomTypeId = req.body.room_type_id || reservation.room_type_id;
    const rate = req.body.rate_per_night !== undefined ? Number(req.body.rate_per_night) : Number(reservation.rate_per_night);
    if (!(rate > 0)) return res.status(400).json({ success: false, error: 'A valid nightly rate is required' });
    const roomId = req.body.assigned_room_id !== undefined ? (req.body.assigned_room_id || null) : reservation.assigned_room_id;

    if (roomId) {
      const conflict = await roomConflict(db, roomId, checkIn, checkOut, reservation.id);
      if (conflict) return res.status(409).json({ success: false, error: conflict, conflict: true });
    }

    const pricing = await priceStay(db, roomTypeId, rate, checkIn, checkOut);
    const oldTotal = Number(reservation.total_amount) ||
      (Number(reservation.rate_per_night) * Math.max(1, nightsBetween(reservation.check_in_date, reservation.check_out_date)));
    const difference = round2(pricing.total - oldTotal);
    const advance = Number(reservation.deposit_paid || 0);
    const revisedBalance = round2(pricing.total - advance);

    if (Math.abs(difference) > 0.004 && !req.body.confirm_change) {
      return res.status(409).json({
        success: false,
        error: 'This change affects the booking total. Review and confirm the revised price.',
        requires_confirmation: true,
        change_summary: {
          old_total: round2(oldTotal),
          new_total: pricing.total,
          difference,
          advance_received: advance,
          revised_balance: revisedBalance,
          currency_symbol: '₹'
        }
      });
    }

    const result = await db.transaction(async (conn) => {
      const before = { ...reservation };
      await conn.run(
        `UPDATE reservations SET
           check_in_date = ?, check_out_date = ?, room_type_id = ?, assigned_room_id = ?,
           adult_count = ?, child_count = ?, rate_per_night = ?, rate_plan = ?,
           special_requests = ?, total_amount = ?, advance_required = ?,
           updated_at = CURRENT_TIMESTAMP, version = version + 1
         WHERE id = ?`,
        [
          checkIn, checkOut, roomTypeId, roomId,
          req.body.adult_count !== undefined ? Number(req.body.adult_count) : reservation.adult_count,
          req.body.child_count !== undefined ? Number(req.body.child_count) : reservation.child_count,
          rate, req.body.rate_plan || reservation.rate_plan || 'standard',
          req.body.special_requests !== undefined ? req.body.special_requests : reservation.special_requests,
          pricing.total,
          req.body.advance_required !== undefined ? round2(req.body.advance_required) : reservation.advance_required,
          reservation.id
        ]
      );

      const updated = await conn.get('SELECT * FROM reservations WHERE id = ?', [reservation.id]);
      let confirmation = null;
      if (Math.abs(difference) > 0.004 && ['confirmed', 'partially_paid', 'fully_prepaid'].includes(updated.status)) {
        confirmation = await issueBookingDocument(conn, {
          reservation: updated,
          documentType: 'booking_confirmation',
          userId: req.user.id,
          propertyId: req.user.property_id
        });
      }
      return { updated, before, confirmation };
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'UPDATE_RESERVATION',
      entityType: 'reservation',
      entityId: reservation.id,
      beforeValue: {
        check_in_date: result.before.check_in_date,
        check_out_date: result.before.check_out_date,
        rate_per_night: result.before.rate_per_night,
        total_amount: result.before.total_amount,
        assigned_room_id: result.before.assigned_room_id
      },
      afterValue: {
        check_in_date: result.updated.check_in_date,
        check_out_date: result.updated.check_out_date,
        rate_per_night: result.updated.rate_per_night,
        total_amount: result.updated.total_amount,
        assigned_room_id: result.updated.assigned_room_id
      },
      details: { difference, confirm_change: Boolean(req.body.confirm_change) },
      req
    });

    res.json({
      success: true,
      message: difference === 0 ? 'Reservation updated' : 'Reservation updated and revised confirmation issued',
      reservation: result.updated,
      price_difference: difference,
      confirmation_document: result.confirmation
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// Confirmation conditions
// ---------------------------------------------------------------
router.post('/:id/confirm', authenticateToken, requireRoles(...BOOKING_ROLES), async (req, res) => {
  try {
    const reservation = await db.get('SELECT * FROM reservations WHERE id = ?', [req.params.id]);
    if (!reservation) return res.status(404).json({ success: false, error: 'Reservation not found' });
    if (reservation.status === 'cancelled') {
      return res.status(400).json({ success: false, error: 'Reinstate the booking before confirming it' });
    }
    if (reservation.status === 'confirmed' || reservation.status === 'checked_in') {
      return res.status(400).json({ success: false, error: 'Reservation is already confirmed' });
    }

    const shortfall = round2(Number(reservation.advance_required || 0) - Number(reservation.deposit_paid || 0));
    if (shortfall > 0.004 && !(req.body.override && APPROVER_ROLES.includes(req.user.role))) {
      return res.status(400).json({
        success: false,
        error: `Required advance shortfall of ₹${shortfall}. Record the advance or obtain authorised approval.`,
        advance_required: reservation.advance_required,
        advance_received: reservation.deposit_paid,
        shortfall
      });
    }

    const result = await db.transaction(async (conn) => {
      await conn.run(
        `UPDATE reservations
         SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP, confirmed_by = ?,
             updated_at = CURRENT_TIMESTAMP, version = version + 1
         WHERE id = ?`,
        [req.user.id, reservation.id]
      );
      const updated = await conn.get('SELECT * FROM reservations WHERE id = ?', [reservation.id]);
      const confirmation = await issueBookingDocument(conn, {
        reservation: updated,
        documentType: 'booking_confirmation',
        userId: req.user.id,
        propertyId: req.user.property_id
      });
      return { updated, confirmation };
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'CONFIRM_RESERVATION',
      entityType: 'reservation',
      entityId: reservation.id,
      details: { override: Boolean(req.body.override), document: result.confirmation.document_number },
      req
    });

    res.json({
      success: true,
      message: 'Reservation confirmed',
      reservation: result.updated,
      confirmation_document: result.confirmation
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// Advances, refunds and ledger
// ---------------------------------------------------------------
router.get('/:id/advances', authenticateToken, async (req, res) => {
  try {
    const ctx = await getBookingContext(db, req.params.id);
    if (!ctx) return res.status(404).json({ success: false, error: 'Reservation not found' });
    const receipts = await db.all(
      `SELECT id, document_type, document_number, total_amount, delivery_status, created_at
       FROM booking_documents
       WHERE reservation_id = ? AND document_type IN ('advance_receipt','payment_receipt','credit_note')
       ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json({
      success: true,
      advances: ctx.payments.filter(p => p.payment_type === 'advance_deposit'),
      refunds: ctx.refunds,
      receipts,
      totals: ctx.totals
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/:id/advances', authenticateToken, requireRoles(...BOOKING_ROLES), async (req, res) => {
  try {
    const { amount, payment_method, transaction_ref, notes } = req.body;
    const reservation = await db.get('SELECT * FROM reservations WHERE id = ?', [req.params.id]);
    if (!reservation) return res.status(404).json({ success: false, error: 'Reservation not found' });
    if (['cancelled', 'checked_out', 'no_show'].includes(reservation.status)) {
      return res.status(400).json({ success: false, error: `Cannot accept an advance for a ${reservation.status} booking` });
    }
    const ctx = await getBookingContext(db, reservation.id);
    if (round2(amount) > ctx.totals.balance_due + 0.004 && !APPROVER_ROLES.includes(req.user.role)) {
      return res.status(400).json({
        success: false,
        error: `Advance exceeds the outstanding booking balance of ₹${ctx.totals.balance_due}`
      });
    }

    const result = await db.transaction(async (conn) => {
      const receipt = await recordPayment(conn, {
        propertyId: req.user.property_id,
        reservationId: reservation.id,
        amount: Number(amount),
        paymentMethod: payment_method,
        paymentType: 'advance_deposit',
        cashierId: req.user.id,
        transactionRef: transaction_ref || null,
        notes: notes || 'Booking advance',
        idempotencyKey: idempotencyKey(req, req.body),
        device: req.headers['user-agent'] || null,
        receiptType: 'advance_receipt',
        receiptPayload: {
          document_label: 'ADVANCE PAYMENT RECEIPT',
          is_tax_invoice: false,
          disclaimer: 'This document acknowledges money received. It is not a tax invoice.',
          booking_reference: reservation.booking_reference,
          guest_name: ctx.reservation.guest_name,
          property_name: ctx.reservation.property_name,
          amount: round2(amount),
          payment_method,
          transaction_ref: transaction_ref || null,
          received_at: new Date().toISOString()
        }
      });
      const updated = await conn.get('SELECT * FROM reservations WHERE id = ?', [reservation.id]);
      return { receipt, updated };
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'RECORD_BOOKING_ADVANCE',
      entityType: 'reservation',
      entityId: reservation.id,
      details: { amount: round2(amount), payment_method, duplicate: result.receipt.duplicate },
      req
    });

    res.json({
      success: true,
      duplicate: result.receipt.duplicate,
      message: result.receipt.duplicate
        ? 'This payment was already recorded; the original receipt is unchanged.'
        : 'Advance recorded successfully',
      receipt: result.receipt.payment,
      reservation: result.updated
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/:id/refunds', authenticateToken, requireRoles(...APPROVER_ROLES), async (req, res) => {
  try {
    const reservation = await db.get('SELECT * FROM reservations WHERE id = ?', [req.params.id]);
    if (!reservation) return res.status(404).json({ success: false, error: 'Reservation not found' });

    const refund = await db.transaction(async (conn) => {
      return refundReservation(conn, {
        reservation,
        amount: req.body.amount,
        method: req.body.refund_method || req.body.payment_method,
        reason: req.body.reason,
        transactionRef: req.body.transaction_ref,
        userId: req.user.id,
        propertyId: req.user.property_id
      });
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'REFUND_BOOKING_ADVANCE',
      entityType: 'reservation',
      entityId: reservation.id,
      details: refund,
      req
    });

    res.json({ success: true, message: 'Refund recorded', refund });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// Cancel / reinstate
// ---------------------------------------------------------------
router.post('/:id/cancel', authenticateToken, requireRoles(...BOOKING_ROLES), async (req, res) => {
  try {
    const { reason, refund_amount } = req.body;
    if (!reason) return res.status(400).json({ success: false, error: 'Cancellation reason is required' });

    const reservation = await db.get('SELECT * FROM reservations WHERE id = ?', [req.params.id]);
    if (!reservation) return res.status(404).json({ success: false, error: 'Reservation not found' });
    if (reservation.status === 'cancelled') {
      return res.status(400).json({ success: false, error: 'Reservation is already cancelled' });
    }
    if (reservation.status === 'checked_in') {
      return res.status(400).json({ success: false, error: 'Check the guest out before cancelling the booking' });
    }
    if (refund_amount && !APPROVER_ROLES.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Only an administrator or general manager can refund an advance' });
    }

    const result = await db.transaction(async (conn) => {
      await conn.run(
        `UPDATE reservations
         SET status = 'cancelled', cancellation_reason = ?, cancelled_at = CURRENT_TIMESTAMP,
             cancelled_by = ?, updated_at = CURRENT_TIMESTAMP, version = version + 1
         WHERE id = ?`,
        [reason, req.user.id, reservation.id]
      );
      let refund = null;
      if (round2(refund_amount) > 0) {
        refund = await refundReservation(conn, {
          reservation,
          amount: Number(refund_amount),
          method: req.body.refund_method,
          reason,
          transactionRef: req.body.transaction_ref,
          userId: req.user.id,
          propertyId: req.user.property_id
        });
      }
      const updated = await conn.get('SELECT * FROM reservations WHERE id = ?', [reservation.id]);
      return { updated, refund };
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'CANCEL_RESERVATION',
      entityType: 'reservation',
      entityId: reservation.id,
      details: { reason, refund: result.refund, previous_status: reservation.status },
      req
    });

    res.json({
      success: true,
      message: 'Reservation cancelled',
      reservation: result.updated,
      refund: result.refund
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/:id/reinstate', authenticateToken, requireRoles(...BOOKING_ROLES), async (req, res) => {
  try {
    const reservation = await db.get('SELECT * FROM reservations WHERE id = ?', [req.params.id]);
    if (!reservation) return res.status(404).json({ success: false, error: 'Reservation not found' });
    if (!['cancelled', 'no_show'].includes(reservation.status)) {
      return res.status(400).json({ success: false, error: 'Only a cancelled or no-show booking can be reinstated' });
    }
    if (reservation.assigned_room_id) {
      const conflict = await roomConflict(
        db, reservation.assigned_room_id, reservation.check_in_date, reservation.check_out_date, reservation.id
      );
      if (conflict) return res.status(409).json({ success: false, error: conflict, conflict: true });
    }

    const advance = Number(reservation.deposit_paid || 0);
    const required = Number(reservation.advance_required || 0);
    const newStatus = required > 0 && advance + 0.004 < required ? 'awaiting_advance' : 'confirmed';

    await db.run(
      `UPDATE reservations
       SET status = ?, cancellation_reason = NULL, cancelled_at = NULL, cancelled_by = NULL,
           updated_at = CURRENT_TIMESTAMP, version = version + 1,
           confirmed_at = CASE WHEN ? = 'confirmed' THEN CURRENT_TIMESTAMP ELSE confirmed_at END,
           confirmed_by = CASE WHEN ? = 'confirmed' THEN ? ELSE confirmed_by END
       WHERE id = ?`,
      [newStatus, newStatus, newStatus, req.user.id, reservation.id]
    );

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'REINSTATE_RESERVATION',
      entityType: 'reservation',
      entityId: reservation.id,
      details: { previous_status: reservation.status, new_status: newStatus },
      req
    });

    const updated = await db.get('SELECT * FROM reservations WHERE id = ?', [reservation.id]);
    res.json({ success: true, message: 'Reservation reinstated', reservation: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// Booking documents (quotation / confirmation) and delivery
// ---------------------------------------------------------------
router.post('/:id/documents', authenticateToken, requireRoles(...BOOKING_ROLES), async (req, res) => {
  try {
    const type = req.body.document_type;
    if (!['booking_quotation', 'booking_confirmation', 'proforma'].includes(type)) {
      return res.status(400).json({ success: false, error: 'Unsupported document type' });
    }
    const reservation = await db.get('SELECT * FROM reservations WHERE id = ?', [req.params.id]);
    if (!reservation) return res.status(404).json({ success: false, error: 'Reservation not found' });

    const doc = await db.transaction(async (conn) => {
      return issueBookingDocument(conn, {
        reservation,
        documentType: type,
        userId: req.user.id,
        propertyId: req.user.property_id
      });
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'ISSUE_BOOKING_DOCUMENT',
      entityType: 'reservation',
      entityId: reservation.id,
      details: { document_type: type, document_number: doc.document_number, version: doc.version },
      req
    });

    res.json({ success: true, document: { ...doc, payload: JSON.parse(doc.payload || '{}') } });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/:id/documents/:docId', authenticateToken, requireRoles(...BOOKING_ROLES), async (req, res) => {
  try {
    const doc = await db.get(
      'SELECT * FROM booking_documents WHERE id = ? AND reservation_id = ?',
      [req.params.docId, req.params.id]
    );
    if (!doc) return res.status(404).json({ success: false, error: 'Document not found' });
    res.json({ success: true, document: { ...doc, payload: JSON.parse(doc.payload || '{}') } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/:id/documents/:docId/send', authenticateToken, requireRoles(...BOOKING_ROLES), async (req, res) => {
  try {
    const doc = await db.get(
      'SELECT * FROM booking_documents WHERE id = ? AND reservation_id = ?',
      [req.params.docId, req.params.id]
    );
    if (!doc) return res.status(404).json({ success: false, error: 'Document not found' });
    if (doc.document_type === 'booking_confirmation') {
      const reservation = await db.get('SELECT status FROM reservations WHERE id = ?', [req.params.id]);
      if (!reservation || !['confirmed', 'checked_in', 'checked_out'].includes(reservation.status)) {
        return res.status(400).json({ success: false, error: 'Confirmation cannot be sent until the booking is confirmed.' });
      }
    }

    const payload = JSON.parse(doc.payload || '{}');
    const to = req.body.email || (payload.guest ? payload.guest.email : null);
    let delivery;
    try {
      delivery = await sendDocumentEmail({
        to,
        subject: `${payload.document_label || 'Booking document'} - ${payload.booking ? payload.booking.reference : ''}`,
        text: `${payload.document_label || 'Booking document'}\n${payload.booking ? payload.booking.reference : ''}`,
        html: `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap">${JSON.stringify(payload, null, 2)}</pre>`
      });
    } catch (mailErr) {
      delivery = { sent: false, reason: mailErr.message };
    }

    const note = delivery.sent ? 'Sent by email' : delivery.reason;
    await db.run(
      `UPDATE booking_documents
       SET delivery_status = ?, delivery_note = ?, sent_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE sent_at END
       WHERE id = ?`,
      [delivery.sent ? 'sent' : 'not_sent', note, delivery.sent ? 1 : 0, doc.id]
    );

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'SEND_BOOKING_DOCUMENT',
      entityType: 'reservation',
      entityId: req.params.id,
      details: { document: doc.document_number, sent: delivery.sent, reason: delivery.reason || null },
      req
    });

    res.json({
      success: true,
      sent: delivery.sent,
      delivery_status: delivery.sent ? 'sent' : 'not_sent',
      message: delivery.sent ? 'Document sent successfully' : `Document not sent: ${delivery.reason}`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// Printable booking bill + WhatsApp share
// ---------------------------------------------------------------
router.get('/:id/bill/pdf', authenticateToken, requireRoles(...BOOKING_ROLES), async (req, res) => {
  try {
    const ctx = await getBookingContext(db, req.params.id);
    if (!ctx) return res.status(404).json({ success: false, error: 'Reservation not found' });
    const invoice = buildBookingBillInvoice(ctx);
    await sendInvoicePdf(res, invoice, `booking-bill-${ctx.reservation.booking_reference}.pdf`);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:id/whatsapp', authenticateToken, requireRoles(...BOOKING_ROLES), async (req, res) => {
  try {
    const ctx = await getBookingContext(db, req.params.id);
    if (!ctx) return res.status(404).json({ success: false, error: 'Reservation not found' });
    const r = ctx.reservation;
    const phone = normalizePhone(req.query.phone || r.guest_phone, r.phone_country_code || '91');
    if (!phone) {
      return res.status(400).json({
        success: false,
        error: 'A valid guest phone number with country code is required to send a WhatsApp bill.'
      });
    }

    const lines = [
      `*${r.property_name}*`,
      `Booking Bill - ${r.booking_reference}`,
      `Guest: ${r.guest_name}`,
      `Check-in: ${r.check_in_date}`,
      `Check-out: ${r.check_out_date} (${ctx.nights} night(s))`,
      `Room: ${r.room_type_name}${r.room_number ? ` #${r.room_number}` : ''}`,
      `Booking total: ${formatMoney(ctx.totals.total_amount)}`,
      `Advance received: ${formatMoney(ctx.totals.net_advance)}`,
      `Balance due: ${formatMoney(ctx.totals.balance_due)}`
    ];
    if (r.upi_id) lines.push(`Pay by UPI: ${r.upi_id}`);
    if (r.property_phone) lines.push(`Hotel contact: ${r.property_phone}`);
    lines.push('', 'Your PDF booking bill is attached. Please contact us for any clarification.');

    const message = lines.join('\n');
    res.json({ success: true, phone, message, url: whatsappUrl(phone, message) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// Extend a not-yet-arrived booking
// ---------------------------------------------------------------
router.post('/:id/extend', authenticateToken, requireRoles(...BOOKING_ROLES), async (req, res) => {
  try {
    const nights = Number(req.body.nights);
    if (!Number.isInteger(nights) || nights < 1 || nights > 365) {
      return res.status(400).json({ success: false, error: 'Extension must be a whole number of nights between 1 and 365' });
    }

    const reservation = await db.get('SELECT * FROM reservations WHERE id = ?', [req.params.id]);
    if (!reservation) return res.status(404).json({ success: false, error: 'Reservation not found' });
    if (['cancelled', 'checked_out', 'no_show'].includes(reservation.status)) {
      return res.status(400).json({ success: false, error: `Cannot extend a ${reservation.status.replace(/_/g, ' ')} booking` });
    }
    if (reservation.status === 'checked_in') {
      return res.status(400).json({ success: false, error: 'Use the in-house stay extension for a checked-in guest' });
    }

    const checkIn = reservation.check_in_date;
    const oldCheckOut = reservation.check_out_date;
    const newCheckOut = shiftDate(oldCheckOut, nights);
    const rate = Number(reservation.rate_per_night);
    const pricing = await priceStay(db, reservation.room_type_id, rate, checkIn, newCheckOut);

    if (reservation.assigned_room_id) {
      const conflict = await roomConflict(db, reservation.assigned_room_id, checkIn, newCheckOut, reservation.id);
      if (conflict) return res.status(409).json({ success: false, error: conflict, conflict: true });
    }

    const oldTotal = Number(reservation.total_amount) || 0;
    const difference = round2(pricing.total - oldTotal);
    const advanceRequired = Number(reservation.advance_required || 0) > 0
      ? round2(pricing.total * (Number(reservation.advance_required) / Math.max(1, oldTotal)))
      : 0;

    const result = await db.transaction(async (conn) => {
      await conn.run(
        `UPDATE reservations
         SET check_out_date = ?, total_amount = ?, advance_required = ?,
             updated_at = CURRENT_TIMESTAMP, version = version + 1
         WHERE id = ?`,
        [newCheckOut, pricing.total, advanceRequired, reservation.id]
      );
      const updated = await conn.get('SELECT * FROM reservations WHERE id = ?', [reservation.id]);
      let confirmation = null;
      if (['confirmed', 'partially_paid', 'fully_prepaid'].includes(updated.status)) {
        confirmation = await issueBookingDocument(conn, {
          reservation: updated,
          documentType: 'booking_confirmation',
          userId: req.user.id,
          propertyId: req.user.property_id
        });
      }
      return { updated, confirmation };
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'EXTEND_RESERVATION',
      entityType: 'reservation',
      entityId: reservation.id,
      beforeValue: { check_out_date: oldCheckOut, total_amount: oldTotal },
      afterValue: { check_out_date: newCheckOut, total_amount: pricing.total },
      details: { nights, difference, document: result.confirmation ? result.confirmation.document_number : null },
      req
    });

    res.json({
      success: true,
      message: `Booking extended by ${nights} night(s) to ${newCheckOut}`,
      reservation: result.updated,
      previous_check_out: oldCheckOut,
      new_check_out: newCheckOut,
      price_difference: difference,
      confirmation_document: result.confirmation
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
