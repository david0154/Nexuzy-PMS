// Room allocation, availability and recommendation API.
// All operations are scoped to the signed-in user's property.

const express = require('express');
const db = require('../../config/database');
const { authenticateToken, requireRoles } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');
const {
  listRoomAvailability,
  recommendRooms,
  assignReservationRoom,
  unassignReservationRoom,
  transferStayRoom,
  allocationDashboard,
  availabilityTimeline
} = require('../../services/allocation');

const router = express.Router();
const ALLOCATION_ROLES = ['admin', 'general_manager', 'front_desk', 'cashier'];
const TRANSFER_ROLES = ['admin', 'general_manager', 'front_desk'];

function sendError(res, err) {
  res.status(err.statusCode || 500).json({ success: false, error: err.message });
}

function searchOptions(query) {
  return {
    check_in: query.check_in,
    check_out: query.check_out,
    room_type_id: query.room_type_id,
    adults: Number(query.adults || 0),
    children: Number(query.children || 0),
    guests: Number(query.guests || 0),
    bed_type: query.bed_type,
    ac_type: query.ac_type,
    floor: query.floor,
    building: query.building,
    accessible: query.accessible === '1' || query.accessible === 'true',
    smoking: query.smoking,
    amenities: query.amenities,
    min_rate: Number(query.min_rate || 0),
    max_rate: Number(query.max_rate || 0),
    status: query.status,
    immediate: query.immediate === '1' || query.immediate === 'true'
  };
}

// GET /api/v1/allocation/availability
router.get('/availability', authenticateToken, requireRoles(...ALLOCATION_ROLES), async (req, res) => {
  try {
    const result = await listRoomAvailability(db, req.user.property_id, searchOptions(req.query));
    res.json({ success: true, ...result });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/v1/allocation/recommend — ranks matching rooms with reasons.
router.post('/recommend', authenticateToken, requireRoles(...ALLOCATION_ROLES), async (req, res) => {
  try {
    const body = req.body || {};
    let options = { ...searchOptions(body), ...body };

    if (body.reservation_id) {
      const reservation = await db.get(
        'SELECT * FROM reservations WHERE id = ? AND property_id = ?',
        [body.reservation_id, req.user.property_id]
      );
      if (!reservation) return res.status(404).json({ success: false, error: 'Reservation not found for this property' });
      options = {
        ...options,
        check_in: reservation.check_in_date,
        check_out: reservation.check_out_date,
        room_type_id: reservation.room_type_id,
        adults: reservation.adult_count,
        children: reservation.child_count,
        bed_preference: reservation.bed_preference,
        ac_preference: reservation.ac_preference,
        floor_preference: reservation.floor_preference,
        accessibility_required: Boolean(Number(reservation.accessibility_required)),
        smoking_preference: reservation.smoking_preference,
        amenities_preference: reservation.amenities_preference,
        immediate: String(reservation.check_in_date).slice(0, 10) <= new Date().toISOString().slice(0, 10)
      };
    }

    const result = await recommendRooms(db, req.user.property_id, options);
    res.json({ success: true, ...result });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/v1/allocation/dashboard
router.get('/dashboard', authenticateToken, requireRoles(...ALLOCATION_ROLES), async (req, res) => {
  try {
    const dashboard = await allocationDashboard(db, req.user.property_id, searchOptions(req.query));
    res.json({ success: true, ...dashboard });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/v1/allocation/timeline?from=&days=
router.get('/timeline', authenticateToken, requireRoles(...ALLOCATION_ROLES), async (req, res) => {
  try {
    const timeline = await availabilityTimeline(db, req.user.property_id, {
      from: req.query.from,
      days: req.query.days
    });
    res.json({ success: true, ...timeline });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/v1/allocation/unassigned
router.get('/unassigned', authenticateToken, requireRoles(...ALLOCATION_ROLES), async (req, res) => {
  try {
    const reservations = await db.all(
      `SELECT res.*, g.first_name || ' ' || COALESCE(g.last_name, '') AS guest_name,
              g.phone AS guest_phone, rt.name AS room_type_name
       FROM reservations res
       JOIN guests g ON res.guest_id = g.id
       JOIN room_types rt ON res.room_type_id = rt.id
       WHERE res.property_id = ? AND res.assigned_room_id IS NULL
         AND res.status IN ('tentative', 'awaiting_advance', 'confirmed', 'partially_paid', 'fully_prepaid')
       ORDER BY date(res.check_in_date) ASC, res.created_at ASC`,
      [req.user.property_id]
    );
    res.json({ success: true, reservations });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/v1/allocation/history?reservation_id=&stay_id=&room_id=
router.get('/history', authenticateToken, requireRoles(...ALLOCATION_ROLES), async (req, res) => {
  try {
    const where = ['ra.property_id = ?'];
    const params = [req.user.property_id];
    if (req.query.reservation_id) { where.push('ra.reservation_id = ?'); params.push(req.query.reservation_id); }
    if (req.query.stay_id) { where.push('ra.stay_id = ?'); params.push(req.query.stay_id); }
    if (req.query.room_id) { where.push('ra.room_id = ?'); params.push(req.query.room_id); }
    const allocations = await db.all(
      `SELECT ra.*, r.room_number, prev.room_number AS previous_room_number,
              res.booking_reference, s.stay_number,
              g.first_name || ' ' || COALESCE(g.last_name, '') AS guest_name,
              u.full_name AS assigned_by_name, ru.full_name AS released_by_name
       FROM room_allocations ra
       JOIN rooms r ON ra.room_id = r.id
       LEFT JOIN rooms prev ON ra.previous_room_id = prev.id
       LEFT JOIN reservations res ON ra.reservation_id = res.id
       LEFT JOIN stays s ON ra.stay_id = s.id
       LEFT JOIN guests g ON ra.guest_id = g.id
       LEFT JOIN users u ON ra.assigned_by = u.id
       LEFT JOIN users ru ON ra.released_by = ru.id
       WHERE ${where.join(' AND ')}
       ORDER BY ra.assigned_at DESC LIMIT 300`,
      params
    );
    res.json({ success: true, allocations });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/v1/allocation/assign
router.post('/assign', authenticateToken, requireRoles(...ALLOCATION_ROLES), async (req, res) => {
  try {
    const { reservation_id, room_id, mode = 'manual', reason = null, override = false } = req.body || {};
    if (!reservation_id) return res.status(400).json({ success: false, error: 'reservation_id is required' });

    const result = await db.transaction(async (conn) => {
      const property = await conn.get('SELECT * FROM properties WHERE id = ?', [req.user.property_id]);
      return assignReservationRoom(conn, {
        propertyId: req.user.property_id,
        reservationId: reservation_id,
        roomId: room_id || null,
        userId: req.user.id,
        reason,
        mode,
        override: Boolean(override),
        property
      });
    });

    if (result.requires_confirmation) {
      return res.json({
        success: true,
        requires_confirmation: true,
        message: 'A matching room is recommended. Confirm it or choose another room.',
        recommendation: result.recommendation
      });
    }

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: result.previous_room_id ? 'ROOM_REASSIGNED' : 'ROOM_ASSIGNED',
      entityType: 'reservation',
      entityId: reservation_id,
      details: {
        room_id: result.room.id,
        room_number: result.room.room_number,
        previous_room_id: result.previous_room_id,
        mode,
        override: Boolean(override),
        reason,
        recommendation: result.recommendation ? result.recommendation.recommendation : null
      },
      req
    });

    res.json({
      success: true,
      message: `Room ${result.room.room_number} assigned`,
      room: result.room,
      reservation: result.reservation,
      recommendation: result.recommendation,
      previous_room_id: result.previous_room_id
    });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/v1/allocation/unassign
router.post('/unassign', authenticateToken, requireRoles(...ALLOCATION_ROLES), async (req, res) => {
  try {
    const { reservation_id, reason } = req.body || {};
    if (!reservation_id) return res.status(400).json({ success: false, error: 'reservation_id is required' });

    const result = await db.transaction(async (conn) => unassignReservationRoom(conn, {
      propertyId: req.user.property_id,
      reservationId: reservation_id,
      userId: req.user.id,
      reason
    }));

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'ROOM_UNASSIGNED',
      entityType: 'reservation',
      entityId: reservation_id,
      details: { previous_room_id: result.previous_room_id, reason },
      req
    });
    res.json({
      success: true,
      message: 'Room allocation released. The reservation is now unassigned.',
      reservation_id,
      previous_room_id: result.previous_room_id
    });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/v1/allocation/transfer — in-house room change with history.
router.post('/transfer', authenticateToken, requireRoles(...TRANSFER_ROLES), async (req, res) => {
  try {
    const { stay_id, new_room_id, reason } = req.body || {};
    if (!stay_id || !new_room_id) {
      return res.status(400).json({ success: false, error: 'stay_id and new_room_id are required' });
    }
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ success: false, error: 'A reason is required for a room transfer' });
    }

    const result = await db.transaction(async (conn) => {
      const property = await conn.get('SELECT * FROM properties WHERE id = ?', [req.user.property_id]);
      return transferStayRoom(conn, {
        propertyId: req.user.property_id,
        stayId: stay_id,
        newRoomId: new_room_id,
        userId: req.user.id,
        reason: String(reason).trim(),
        property
      });
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'ROOM_TRANSFER',
      entityType: 'stay',
      entityId: stay_id,
      details: {
        from_room_id: result.previous_room_id,
        from_room: result.previous_room_number,
        to_room_id: result.room.id,
        to_room: result.room.room_number,
        reason
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
    sendError(res, err);
  }
});

module.exports = router;
