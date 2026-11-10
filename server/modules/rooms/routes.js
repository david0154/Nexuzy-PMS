const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const { authenticateToken, requireRoles } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');

// GET /api/v1/room-types
router.get('/types', authenticateToken, async (req, res) => {
  try {
    const roomTypes = await db.all('SELECT * FROM room_types WHERE property_id = ? ORDER BY base_rate ASC', [req.user.property_id]);
    res.json({ success: true, roomTypes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/room-types
router.post('/types', authenticateToken, requireRoles('admin', 'general_manager'), async (req, res) => {
  try {
    const { name, code, base_rate, max_occupancy, extra_adult_rate, tax_rate, hsn_sac, amenities, description } = req.body;
    const id = uuidv4();
    await db.run(
      `INSERT INTO room_types (id, property_id, name, code, base_rate, max_occupancy, extra_adult_rate, tax_rate, hsn_sac, amenities, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.user.property_id, name, code, base_rate, max_occupancy || 2, extra_adult_rate || 500, tax_rate || 12.0, hsn_sac || '996311', amenities, description]
    );
    res.json({ success: true, message: 'Room type created', id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/rooms
router.get('/', authenticateToken, async (req, res) => {
  try {
    const rooms = await db.all(
      `SELECT r.*, rt.name as room_type_name, rt.code as room_type_code, rt.base_rate, rt.tax_rate,
              s.id as active_stay_id, s.stay_number, g.first_name || ' ' || COALESCE(g.last_name, '') as current_guest_name
       FROM rooms r
       JOIN room_types rt ON r.room_type_id = rt.id
       LEFT JOIN stays s ON s.room_id = r.id AND s.status = 'occupied'
       LEFT JOIN guests g ON s.primary_guest_id = g.id
       WHERE r.property_id = ?
       ORDER BY r.room_number ASC`
      [req.user.property_id]
    );
    res.json({ success: true, rooms });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/rooms
router.post('/', authenticateToken, requireRoles('admin', 'general_manager'), async (req, res) => {
  try {
    const { room_number, room_type_id, floor, building, features } = req.body;
    const id = uuidv4();
    await db.run(
      `INSERT INTO rooms (id, property_id, room_number, room_type_id, floor, building, operational_status, housekeeping_status, features)
       VALUES (?, ?, ?, ?, ?, ?, 'available', 'clean', ?)`,
      [id, req.user.property_id, room_number, room_type_id, floor, building || 'Main Wing', features]
    );
    res.json({ success: true, message: 'Room created', id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/v1/rooms/:id — edit room master data without changing historical bookings.
router.patch('/:id', authenticateToken, requireRoles('admin', 'general_manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const current = await db.get('SELECT * FROM rooms WHERE id = ? AND property_id = ?', [id, req.user.property_id]);
    if (!current) return res.status(404).json({ success: false, error: 'Room not found' });
    const { room_number, room_type_id, floor, building, features, rate_override } = req.body;
    if (room_number !== undefined && !String(room_number).trim()) {
      return res.status(400).json({ success: false, error: 'Room number cannot be empty' });
    }
    if (rate_override !== undefined && rate_override !== null && (!Number.isFinite(Number(rate_override)) || Number(rate_override) < 0)) {
      return res.status(400).json({ success: false, error: 'Rate override must be a non-negative number' });
    }
    if (room_type_id !== undefined) {
      const type = await db.get('SELECT id FROM room_types WHERE id = ? AND property_id = ?', [room_type_id, req.user.property_id]);
      if (!type) return res.status(400).json({ success: false, error: 'Room type does not belong to this property' });
    }
    await db.run(
      `UPDATE rooms SET room_number = ?, room_type_id = ?, floor = ?, building = ?, features = ?, rate_override = ?
       WHERE id = ? AND property_id = ?`,
      [room_number === undefined ? current.room_number : String(room_number).trim(),
       room_type_id === undefined ? current.room_type_id : room_type_id,
       floor === undefined ? current.floor : floor,
       building === undefined ? current.building : building,
       features === undefined ? current.features : features,
       rate_override === undefined ? current.rate_override : rate_override, id, req.user.property_id]
    );
    const updated = await db.get('SELECT * FROM rooms WHERE id = ? AND property_id = ?', [id, req.user.property_id]);
    await logAudit({ propertyId: req.user.property_id, userId: req.user.id, action: 'UPDATE_ROOM', entityType: 'room', entityId: id, details: { before: current, after: updated }, req });
    res.json({ success: true, room: updated });
  } catch (err) {
    res.status(err.code === 'SQLITE_CONSTRAINT' ? 409 : 500).json({ success: false, error: err.code === 'SQLITE_CONSTRAINT' ? 'Room number already exists in this property' : err.message });
  }
});

// GET /api/v1/rooms/:id/history — status change audit history.
router.get('/:id/history', authenticateToken, async (req, res) => {
  try {
    const room = await db.get('SELECT id FROM rooms WHERE id = ? AND property_id = ?', [req.params.id, req.user.property_id]);
    if (!room) return res.status(404).json({ success: false, error: 'Room not found' });
    const history = await db.all('SELECT * FROM room_status_history WHERE room_id = ? ORDER BY changed_at DESC', [req.params.id]);
    res.json({ success: true, history });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/v1/rooms/:id/status
router.patch('/:id/status', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { operational_status, housekeeping_status, maintenance_status, reason } = req.body;
    const allowedOperational = ['available', 'occupied', 'out_of_order', 'out_of_service', 'blocked'];
    const allowedHousekeeping = ['clean', 'dirty', 'cleaning', 'inspected', 'dnd'];
    const allowedMaintenance = ['ok', 'reported', 'under_repair'];
    if (operational_status !== undefined && !allowedOperational.includes(operational_status)) {
      return res.status(400).json({ success: false, error: 'Invalid operational status' });
    }
    if (housekeeping_status !== undefined && !allowedHousekeeping.includes(housekeeping_status)) {
      return res.status(400).json({ success: false, error: 'Invalid housekeeping status' });
    }
    if (maintenance_status !== undefined && !allowedMaintenance.includes(maintenance_status)) {
      return res.status(400).json({ success: false, error: 'Invalid maintenance status' });
    }
    if (operational_status === 'blocked' && (!reason || !String(reason).trim())) {
      return res.status(400).json({ success: false, error: 'A reason is required when blocking a room' });
    }
    const before = await db.get('SELECT * FROM rooms WHERE id = ? AND property_id = ?', [id, req.user.property_id]);
    if (!before) return res.status(404).json({ success: false, error: 'Room not found' });
    if (before.operational_status === 'occupied' && operational_status && operational_status !== 'occupied') {
      const activeStay = await db.get("SELECT id FROM stays WHERE room_id = ? AND status = 'occupied'", [id]);
      if (activeStay) return res.status(409).json({ success: false, error: 'Cannot change operational status while an active guest stay occupies this room' });
    }
    await db.transaction(async () => {
      await db.run(
        `UPDATE rooms SET operational_status = COALESCE(?, operational_status),
         housekeeping_status = COALESCE(?, housekeeping_status),
         maintenance_status = COALESCE(?, maintenance_status) WHERE id = ? AND property_id = ?`,
        [operational_status, housekeeping_status, maintenance_status, id, req.user.property_id]
      );
      await db.run(
        `INSERT INTO room_status_history (id, property_id, room_id, old_operational_status, new_operational_status,
         old_housekeeping_status, new_housekeeping_status, old_maintenance_status, new_maintenance_status, reason, changed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), req.user.property_id, id, before.operational_status, operational_status || before.operational_status,
         before.housekeeping_status, housekeeping_status || before.housekeeping_status,
         before.maintenance_status, maintenance_status || before.maintenance_status, reason || null, req.user.id]
      );
    });
    await logAudit({ propertyId: req.user.property_id, userId: req.user.id, action: 'UPDATE_ROOM_STATUS', entityType: 'room', entityId: id, details: { before, changes: req.body }, req });
    const updated = await db.get('SELECT * FROM rooms WHERE id = ? AND property_id = ?', [id, req.user.property_id]);
    res.json({ success: true, room: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/rooms/availability
// Checks commercial availability between check_in and check_out dates
router.get('/availability', authenticateToken, async (req, res) => {
  try {
    const { check_in, check_out, room_type_id } = req.query;
    if (!check_in || !check_out) {
      return res.status(400).json({ success: false, error: 'check_in and check_out dates are required' });
    }

    // Query rooms that are NOT currently out_of_order and have NO overlapping active stay or confirmed reservation
    let query = `
      SELECT r.*, rt.name as room_type_name, rt.base_rate, rt.tax_rate
      FROM rooms r
      JOIN room_types rt ON r.room_type_id = rt.id
      WHERE r.operational_status != 'out_of_order'
        AND r.id NOT IN (
          -- Stays overlapping
          SELECT s.room_id FROM stays s
          WHERE s.status = 'occupied'
            AND date(s.check_in_time) < date(?)
            AND date(s.expected_check_out) > date(?)
        )
        AND r.id NOT IN (
          -- Reservations overlapping
          SELECT res.assigned_room_id FROM reservations res
          WHERE res.assigned_room_id IS NOT NULL
            AND res.status = 'confirmed'
            AND date(res.check_in_date) < date(?)
            AND date(res.check_out_date) > date(?)
        )
        AND r.id NOT IN (
          -- Group rooms overlapping
          SELECT gr.assigned_room_id FROM group_room_reservations gr
          WHERE gr.assigned_room_id IS NOT NULL
            AND gr.status IN ('reserved', 'checked_in')
            AND date(gr.planned_check_in) < date(?)
            AND date(gr.planned_check_out) > date(?)
        )
    `;

    const params = [check_out, check_in, check_out, check_in, check_out, check_in];

    if (room_type_id) {
      query += ' AND r.room_type_id = ?';
      params.push(room_type_id);
    }

    query += ' ORDER BY r.room_number ASC';

    const availableRooms = await db.all(query, params);

    res.json({
      success: true,
      check_in,
      check_out,
      total_available: availableRooms.length,
      rooms: availableRooms
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
