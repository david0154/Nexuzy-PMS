const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const { authenticateToken, requireRoles } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');

const MANAGER_ROLES = ['admin', 'general_manager'];
const OPERATIONAL_STATUSES = ['available', 'occupied', 'out_of_order', 'out_of_service', 'blocked'];
const HOUSEKEEPING_STATUSES = ['clean', 'dirty', 'cleaning', 'inspected', 'dnd'];
const MAINTENANCE_STATUSES = ['ok', 'reported', 'under_repair'];

function numberOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// GET /api/v1/room-types
router.get('/types', authenticateToken, async (req, res) => {
  try {
    const roomTypes = await db.all(
      `SELECT rt.*, (SELECT COUNT(*) FROM rooms r WHERE r.room_type_id = rt.id) AS room_count
       FROM room_types rt WHERE rt.property_id = ?
       ORDER BY rt.base_rate ASC, rt.name ASC`,
      [req.user.property_id]
    );
    res.json({ success: true, roomTypes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/room-types
router.post('/types', authenticateToken, requireRoles(...MANAGER_ROLES), async (req, res) => {
  try {
    const { name, code, base_rate, max_occupancy, extra_adult_rate, tax_rate, hsn_sac, amenities, description } = req.body;
    if (!String(name || '').trim()) return res.status(400).json({ success: false, error: 'Room type name is required' });
    if (!String(code || '').trim()) return res.status(400).json({ success: false, error: 'Room type code is required' });
    if (!Number.isFinite(Number(base_rate)) || Number(base_rate) < 0) {
      return res.status(400).json({ success: false, error: 'Base rate must be zero or greater' });
    }
    if (!Number.isFinite(Number(tax_rate ?? 12)) || Number(tax_rate ?? 12) < 0 || Number(tax_rate ?? 12) > 28) {
      return res.status(400).json({ success: false, error: 'GST rate must be between 0 and 28' });
    }

    const duplicate = await db.get(
      `SELECT id FROM room_types WHERE property_id = ?
       AND (name = ? COLLATE NOCASE OR code = ? COLLATE NOCASE)`,
      [req.user.property_id, String(name).trim(), String(code).trim()]
    );
    if (duplicate) return res.status(409).json({ success: false, error: 'A room type with this name or code already exists' });

    const id = uuidv4();
    await db.run(
      `INSERT INTO room_types (id, property_id, name, code, base_rate, max_occupancy, extra_adult_rate, tax_rate, hsn_sac, amenities, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, req.user.property_id, String(name).trim(), String(code).trim().toUpperCase(),
        Number(base_rate), numberOrDefault(max_occupancy, 2), numberOrDefault(extra_adult_rate, 500),
        numberOrDefault(tax_rate, 12), hsn_sac || '996311', amenities || null, description || null
      ]
    );
    await logAudit({
      propertyId: req.user.property_id, userId: req.user.id, action: 'CREATE_ROOM_TYPE',
      entityType: 'room_type', entityId: id, details: { name, code, base_rate }, req
    });
    res.status(201).json({ success: true, message: 'Room type created', id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/v1/room-types/:id
router.patch('/types/:id', authenticateToken, requireRoles(...MANAGER_ROLES), async (req, res) => {
  try {
    const roomType = await db.get('SELECT * FROM room_types WHERE id = ? AND property_id = ?', [req.params.id, req.user.property_id]);
    if (!roomType) return res.status(404).json({ success: false, error: 'Room type not found' });

    const name = req.body.name !== undefined ? String(req.body.name).trim() : roomType.name;
    const code = req.body.code !== undefined ? String(req.body.code).trim().toUpperCase() : roomType.code;
    if (!name || !code) return res.status(400).json({ success: false, error: 'Room type name and code are required' });
    const baseRate = req.body.base_rate !== undefined ? Number(req.body.base_rate) : Number(roomType.base_rate);
    if (!Number.isFinite(baseRate) || baseRate < 0) {
      return res.status(400).json({ success: false, error: 'Base rate must be zero or greater' });
    }
    const taxRate = req.body.tax_rate !== undefined ? Number(req.body.tax_rate) : Number(roomType.tax_rate);
    if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 28) {
      return res.status(400).json({ success: false, error: 'GST rate must be between 0 and 28' });
    }
    const duplicate = await db.get(
      `SELECT id FROM room_types WHERE property_id = ? AND id != ?
       AND (name = ? COLLATE NOCASE OR code = ? COLLATE NOCASE)`,
      [req.user.property_id, roomType.id, name, code]
    );
    if (duplicate) return res.status(409).json({ success: false, error: 'A room type with this name or code already exists' });

    await db.run(
      `UPDATE room_types SET name = ?, code = ?, base_rate = ?, max_occupancy = ?,
         extra_adult_rate = ?, tax_rate = ?, hsn_sac = ?, amenities = ?, description = ?
       WHERE id = ?`,
      [
        name, code, baseRate,
        req.body.max_occupancy !== undefined ? numberOrDefault(req.body.max_occupancy, roomType.max_occupancy) : roomType.max_occupancy,
        req.body.extra_adult_rate !== undefined ? numberOrDefault(req.body.extra_adult_rate, roomType.extra_adult_rate) : roomType.extra_adult_rate,
        taxRate,
        req.body.hsn_sac !== undefined ? req.body.hsn_sac : roomType.hsn_sac,
        req.body.amenities !== undefined ? req.body.amenities : roomType.amenities,
        req.body.description !== undefined ? req.body.description : roomType.description,
        roomType.id
      ]
    );
    await logAudit({
      propertyId: req.user.property_id, userId: req.user.id, action: 'UPDATE_ROOM_TYPE',
      entityType: 'room_type', entityId: roomType.id,
      beforeValue: { name: roomType.name, code: roomType.code, base_rate: roomType.base_rate, tax_rate: roomType.tax_rate },
      afterValue: { name, code, base_rate: baseRate, tax_rate: taxRate }, req
    });
    res.json({ success: true, message: 'Room type updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/v1/room-types/:id — only when no rooms or bookings reference it
router.delete('/types/:id', authenticateToken, requireRoles(...MANAGER_ROLES), async (req, res) => {
  try {
    const roomType = await db.get('SELECT * FROM room_types WHERE id = ? AND property_id = ?', [req.params.id, req.user.property_id]);
    if (!roomType) return res.status(404).json({ success: false, error: 'Room type not found' });
    const rooms = await db.get('SELECT COUNT(*) AS count FROM rooms WHERE room_type_id = ?', [roomType.id]);
    if (Number(rooms.count) > 0) {
      return res.status(409).json({ success: false, error: 'Move or delete the rooms using this type first' });
    }
    const reservations = await db.get('SELECT COUNT(*) AS count FROM reservations WHERE room_type_id = ?', [roomType.id]);
    const groups = await db.get('SELECT COUNT(*) AS count FROM group_room_reservations WHERE room_type_id = ?', [roomType.id]);
    if (Number(reservations.count) + Number(groups.count) > 0) {
      return res.status(409).json({ success: false, error: 'This room type is referenced by bookings and cannot be deleted' });
    }
    await db.run('DELETE FROM room_types WHERE id = ?', [roomType.id]);
    await logAudit({
      propertyId: req.user.property_id, userId: req.user.id, action: 'DELETE_ROOM_TYPE',
      entityType: 'room_type', entityId: roomType.id, beforeValue: roomType, req
    });
    res.json({ success: true, message: 'Room type deleted' });
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
       ORDER BY r.room_number ASC`,
      [req.user.property_id]
    );
    res.json({ success: true, rooms });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/rooms
router.post('/', authenticateToken, requireRoles(...MANAGER_ROLES), async (req, res) => {
  try {
    const { room_number, room_type_id, floor, building, features } = req.body;
    if (!String(room_number || '').trim()) return res.status(400).json({ success: false, error: 'Room number is required' });
    if (!room_type_id) return res.status(400).json({ success: false, error: 'Room type is required' });

    const roomType = await db.get('SELECT * FROM room_types WHERE id = ? AND property_id = ?', [room_type_id, req.user.property_id]);
    if (!roomType) return res.status(400).json({ success: false, error: 'Room type not found' });
    const duplicate = await db.get(
      'SELECT id FROM rooms WHERE property_id = ? AND room_number = ? COLLATE NOCASE',
      [req.user.property_id, String(room_number).trim()]
    );
    if (duplicate) return res.status(409).json({ success: false, error: `Room ${room_number} already exists` });

    const id = uuidv4();
    await db.run(
      `INSERT INTO rooms (id, property_id, room_number, room_type_id, floor, building, operational_status, housekeeping_status, features)
       VALUES (?, ?, ?, ?, ?, ?, 'available', 'clean', ?)`,
      [id, req.user.property_id, String(room_number).trim(), roomType.id, floor || 'Floor 1', building || 'Main Wing', features || null]
    );
    await logAudit({
      propertyId: req.user.property_id, userId: req.user.id, action: 'CREATE_ROOM',
      entityType: 'room', entityId: id, details: { room_number, room_type: roomType.name, floor }, req
    });
    res.status(201).json({ success: true, message: 'Room created', id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/v1/rooms/:id/status
router.patch('/:id/status', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { operational_status, housekeeping_status, maintenance_status } = req.body;
    const room = await db.get('SELECT * FROM rooms WHERE id = ? AND property_id = ?', [id, req.user.property_id]);
    if (!room) return res.status(404).json({ success: false, error: 'Room not found' });
    if (operational_status && !OPERATIONAL_STATUSES.includes(operational_status)) {
      return res.status(400).json({ success: false, error: 'Invalid operational status' });
    }
    if (housekeeping_status && !HOUSEKEEPING_STATUSES.includes(housekeeping_status)) {
      return res.status(400).json({ success: false, error: 'Invalid housekeeping status' });
    }
    if (maintenance_status && !MAINTENANCE_STATUSES.includes(maintenance_status)) {
      return res.status(400).json({ success: false, error: 'Invalid maintenance status' });
    }

    await db.run(
      `UPDATE rooms
       SET operational_status = COALESCE(?, operational_status),
           housekeeping_status = COALESCE(?, housekeeping_status),
           maintenance_status = COALESCE(?, maintenance_status)
       WHERE id = ?`,
      [operational_status, housekeeping_status, maintenance_status, id]
    );

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'UPDATE_ROOM_STATUS',
      entityType: 'room',
      entityId: id,
      beforeValue: {
        operational_status: room.operational_status,
        housekeeping_status: room.housekeeping_status,
        maintenance_status: room.maintenance_status
      },
      details: req.body,
      req
    });

    const updated = await db.get('SELECT * FROM rooms WHERE id = ?', [id]);
    res.json({ success: true, room: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/v1/rooms/:id — room number, type, floor and features
router.patch('/:id', authenticateToken, requireRoles(...MANAGER_ROLES), async (req, res) => {
  try {
    const room = await db.get('SELECT * FROM rooms WHERE id = ? AND property_id = ?', [req.params.id, req.user.property_id]);
    if (!room) return res.status(404).json({ success: false, error: 'Room not found' });

    const roomNumber = req.body.room_number !== undefined ? String(req.body.room_number).trim() : room.room_number;
    if (!roomNumber) return res.status(400).json({ success: false, error: 'Room number is required' });
    const roomTypeId = req.body.room_type_id || room.room_type_id;
    const roomType = await db.get('SELECT * FROM room_types WHERE id = ? AND property_id = ?', [roomTypeId, req.user.property_id]);
    if (!roomType) return res.status(400).json({ success: false, error: 'Room type not found' });
    const duplicate = await db.get(
      'SELECT id FROM rooms WHERE property_id = ? AND room_number = ? COLLATE NOCASE AND id != ?',
      [req.user.property_id, roomNumber, room.id]
    );
    if (duplicate) return res.status(409).json({ success: false, error: `Room ${roomNumber} already exists` });

    await db.run(
      `UPDATE rooms SET room_number = ?, room_type_id = ?, floor = ?, building = ?, features = ? WHERE id = ?`,
      [
        roomNumber, roomType.id,
        req.body.floor !== undefined ? req.body.floor : room.floor,
        req.body.building !== undefined ? req.body.building : room.building,
        req.body.features !== undefined ? req.body.features : room.features,
        room.id
      ]
    );
    await logAudit({
      propertyId: req.user.property_id, userId: req.user.id, action: 'UPDATE_ROOM',
      entityType: 'room', entityId: room.id,
      beforeValue: { room_number: room.room_number, room_type_id: room.room_type_id, floor: room.floor },
      afterValue: { room_number: roomNumber, room_type_id: roomType.id, floor: req.body.floor ?? room.floor }, req
    });
    res.json({ success: true, message: 'Room updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/v1/rooms/:id — preserves all historical records
router.delete('/:id', authenticateToken, requireRoles(...MANAGER_ROLES), async (req, res) => {
  try {
    const room = await db.get('SELECT * FROM rooms WHERE id = ? AND property_id = ?', [req.params.id, req.user.property_id]);
    if (!room) return res.status(404).json({ success: false, error: 'Room not found' });

    const checks = [
      ['stays', 'SELECT COUNT(*) AS count FROM stays WHERE room_id = ?'],
      ['reservations', 'SELECT COUNT(*) AS count FROM reservations WHERE assigned_room_id = ?'],
      ['group bookings', 'SELECT COUNT(*) AS count FROM group_room_reservations WHERE assigned_room_id = ?'],
      ['restaurant orders', 'SELECT COUNT(*) AS count FROM restaurant_orders WHERE room_id = ?']
    ];
    for (const [label, sql] of checks) {
      const row = await db.get(sql, [room.id]);
      if (Number(row.count) > 0) {
        return res.status(409).json({
          success: false,
          error: `Room ${room.room_number} is referenced by ${label}. Keep it for history or mark it out of service instead.`
        });
      }
    }

    await db.run('DELETE FROM rooms WHERE id = ?', [room.id]);
    await logAudit({
      propertyId: req.user.property_id, userId: req.user.id, action: 'DELETE_ROOM',
      entityType: 'room', entityId: room.id, beforeValue: room, req
    });
    res.json({ success: true, message: 'Room deleted' });
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

    // Query rooms that are sellable and have no overlapping active stay or booking.
    // Blocked, out-of-service and out-of-order rooms are never offered for sale.
    let query = `
      SELECT r.*, rt.name as room_type_name, rt.base_rate, rt.tax_rate
      FROM rooms r
      JOIN room_types rt ON r.room_type_id = rt.id
      WHERE r.property_id = ?
        AND r.operational_status NOT IN ('out_of_order', 'out_of_service', 'blocked')
        AND r.id NOT IN (
          -- Stays overlapping
          SELECT s.room_id FROM stays s
          WHERE s.status IN ('occupied', 'extended')
            AND date(s.check_in_time) < date(?)
            AND date(s.expected_check_out) > date(?)
        )
        AND r.id NOT IN (
          -- Reservations holding the room, including unpaid/tentative holds
          SELECT res.assigned_room_id FROM reservations res
          WHERE res.assigned_room_id IS NOT NULL
            AND res.status IN ('tentative', 'awaiting_advance', 'confirmed', 'partially_paid', 'fully_prepaid', 'checked_in')
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

    const params = [req.user.property_id, check_out, check_in, check_out, check_in, check_out, check_in];

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
