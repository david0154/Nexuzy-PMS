const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const { authenticateToken, requireRoles } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');
const {
  newQrToken,
  guestBaseUrl,
  guestPortalInfo,
  guestUrl,
  qrPngBuffer,
  streamPosterPdf,
  resolveLogoPath
} = require('../../services/roomqr');

const VIEW_ROLES = ['admin', 'general_manager', 'front_desk', 'reception'];
const MANAGE_ROLES = ['admin', 'general_manager'];

async function loadProperty(propertyId) {
  return db.get('SELECT * FROM properties WHERE id = ?', [propertyId]);
}

async function roomsWithQr(propertyId, roomIds = null) {
  const params = [propertyId];
  let filter = '';
  if (roomIds && roomIds.length) {
    filter = ` AND r.id IN (${roomIds.map(() => '?').join(',')})`;
    params.push(...roomIds);
  }
  return db.all(
    `SELECT r.id AS room_id, r.room_number, r.floor, r.building, r.operational_status,
            r.housekeeping_status,
            q.id AS qr_id, q.qr_token, q.is_active, q.generated_at, q.rotated_at
     FROM rooms r
     LEFT JOIN room_qr_codes q ON q.room_id = r.id AND q.property_id = r.property_id
     WHERE r.property_id = ?${filter}
     ORDER BY CAST(r.room_number AS INTEGER) ASC, r.room_number ASC`,
    params
  );
}

async function decorate(property, rooms, baseUrl = null) {
  const base = baseUrl !== null ? baseUrl : await guestBaseUrl(property);
  return rooms.map(room => ({
    ...room,
    qr_status: room.qr_token ? (room.is_active ? 'active' : 'disabled') : 'not_generated',
    portal_url: room.qr_token && base ? guestUrl(base, room.qr_token) : null,
    portal_base_url: base
  }));
}

// GET /api/v1/room-qr
router.get('/', authenticateToken, requireRoles(...VIEW_ROLES), async (req, res) => {
  try {
    const property = await loadProperty(req.user.property_id);
    if (!property) return res.status(404).json({ success: false, error: 'Property not found' });
    const rooms = await roomsWithQr(req.user.property_id);
    const portal = await guestPortalInfo(property);
    const decorated = await decorate(property, rooms, portal.base_url);
    res.json({
      success: true,
      room_qr_enabled: Number(property.room_qr_enabled) === 1,
      portal_base_url: portal.base_url,
      configured_portal_base_url: portal.configured,
      portal_warning: portal.warning,
      rooms: decorated.map(({ qr_token, ...rest }) => rest),
      summary: {
        total: decorated.length,
        generated: decorated.filter(r => r.qr_token).length,
        active: decorated.filter(r => r.qr_status === 'active').length,
        disabled: decorated.filter(r => r.qr_status === 'disabled').length,
        not_generated: decorated.filter(r => r.qr_status === 'not_generated').length
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/room-qr/:roomId
router.get('/:roomId', authenticateToken, requireRoles(...VIEW_ROLES), async (req, res) => {
  try {
    const property = await loadProperty(req.user.property_id);
    const [room] = await roomsWithQr(req.user.property_id, [req.params.roomId]);
    if (!room) return res.status(404).json({ success: false, error: 'Room not found' });
    const [decorated] = await decorate(property, [room]);
    const { qr_token, ...safe } = decorated;
    res.json({ success: true, qr: safe });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

async function generateForRooms(req, res, roomIds) {
  const property = await loadProperty(req.user.property_id);
  if (!property) return res.status(404).json({ success: false, error: 'Property not found' });
  if (Number(property.room_qr_enabled) !== 1) {
    return res.status(409).json({ success: false, error: 'Room QR is disabled for this property. Enable it in Settings first.' });
  }

  const base = await guestBaseUrl(property);
  if (!base) {
    return res.status(409).json({
      success: false,
      error: 'No private LAN guest address is available. Enable Local Network or set the guest portal LAN address in Settings before generating QR codes.'
    });
  }

  const rooms = await roomsWithQr(req.user.property_id, roomIds);
  if (!rooms.length) return res.status(404).json({ success: false, error: 'No matching rooms found' });

  const created = [];
  const skipped = [];
  await db.transaction(async (conn) => {
    for (const room of rooms) {
      if (room.qr_token) { skipped.push(room.room_number); continue; }
      const token = newQrToken();
      const id = uuidv4();
      await conn.run(
        `INSERT INTO room_qr_codes (id, property_id, room_id, qr_token, is_active, created_by)
         VALUES (?, ?, ?, ?, 1, ?)`,
        [id, req.user.property_id, room.room_id, token, req.user.id]
      );
      created.push({ room_id: room.room_id, room_number: room.room_number, portal_url: guestUrl(base, token) });
    }
  });

  await logAudit({
    propertyId: req.user.property_id,
    userId: req.user.id,
    action: 'GENERATE_ROOM_QR',
    entityType: 'room_qr',
    details: { created: created.map(r => r.room_number), skipped, portal_base_url: base },
    req
  });

  res.json({
    success: true,
    message: `${created.length} room QR code(s) generated${skipped.length ? `; ${skipped.length} already existed` : ''}.`,
    created,
    skipped
  });
}

// POST /api/v1/room-qr/generate
router.post('/generate', authenticateToken, requireRoles(...MANAGE_ROLES), async (req, res) => {
  try {
    const raw = req.body.room_ids || (req.body.room_id ? [req.body.room_id] : []);
    const roomIds = (Array.isArray(raw) ? raw : []).map(String).filter(Boolean);
    if (!roomIds.length) return res.status(400).json({ success: false, error: 'Select at least one room' });
    await generateForRooms(req, res, roomIds);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/room-qr/generate-all
router.post('/generate-all', authenticateToken, requireRoles(...MANAGE_ROLES), async (req, res) => {
  try {
    const missing = await roomsWithQr(req.user.property_id);
    await generateForRooms(req, res, missing.map(r => r.room_id));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/v1/room-qr/:roomId — enable or disable guest access
router.patch('/:roomId', authenticateToken, requireRoles(...MANAGE_ROLES), async (req, res) => {
  try {
    const qr = await db.get(
      'SELECT * FROM room_qr_codes WHERE room_id = ? AND property_id = ?',
      [req.params.roomId, req.user.property_id]
    );
    if (!qr) return res.status(404).json({ success: false, error: 'This room has no QR code yet' });
    const isActive = req.body.is_active ? 1 : 0;
    await db.transaction(async (conn) => {
      await conn.run('UPDATE room_qr_codes SET is_active = ? WHERE id = ?', [isActive, qr.id]);
      if (!isActive) {
        // Disabling a QR also ends any guest sessions opened from it.
        await conn.run(
          "UPDATE guest_sessions SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, revoked_by = ? WHERE property_id = ? AND room_id = ? AND status = 'active'",
          [req.user.id, req.user.property_id, qr.room_id]
        );
      }
    });
    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: isActive ? 'ENABLE_ROOM_QR' : 'DISABLE_ROOM_QR',
      entityType: 'room_qr',
      entityId: qr.id,
      beforeValue: { is_active: qr.is_active },
      afterValue: { is_active: isActive },
      req
    });
    res.json({ success: true, message: isActive ? 'Guest QR access enabled' : 'Guest QR access disabled', is_active: isActive });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/room-qr/:roomId/regenerate — replaces the printed QR permanently
router.post('/:roomId/regenerate', authenticateToken, requireRoles(...MANAGE_ROLES), async (req, res) => {
  try {
    const property = await loadProperty(req.user.property_id);
    const qr = await db.get(
      `SELECT q.*, r.room_number FROM room_qr_codes q
       JOIN rooms r ON q.room_id = r.id
       WHERE q.room_id = ? AND q.property_id = ?`,
      [req.params.roomId, req.user.property_id]
    );
    if (!qr) return res.status(404).json({ success: false, error: 'Generate a QR for this room first' });

    const base = await guestBaseUrl(property);
    if (!base) return res.status(409).json({ success: false, error: 'No LAN guest address is configured' });

    const token = newQrToken();
    await db.transaction(async (conn) => {
      await conn.run(
        `UPDATE room_qr_codes
         SET qr_token = ?, is_active = 1, generated_at = CURRENT_TIMESTAMP, rotated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [token, qr.id]
      );
      // Printed old posters must stop working immediately.
      await conn.run(
        "UPDATE guest_sessions SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP WHERE property_id = ? AND room_id = ? AND status = 'active'",
        [req.user.property_id, qr.room_id]
      );
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'REGENERATE_ROOM_QR',
      entityType: 'room_qr',
      entityId: qr.id,
      details: { room_number: qr.room_number },
      req
    });

    res.json({
      success: true,
      message: `QR regenerated for Room ${qr.room_number}. Replace the printed poster.`,
      portal_url: guestUrl(base, token),
      is_active: 1
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

async function posterRows(propertyId, roomIds) {
  const rooms = await roomsWithQr(propertyId, roomIds);
  return rooms.filter(r => r.qr_token);
}

// GET /api/v1/room-qr/:roomId/poster?format=png|pdf
router.get('/:roomId/poster', authenticateToken, requireRoles(...VIEW_ROLES), async (req, res) => {
  try {
    const property = await loadProperty(req.user.property_id);
    const [room] = await posterRows(req.user.property_id, [req.params.roomId]);
    if (!room) return res.status(404).json({ success: false, error: 'This room has no QR code yet' });

    const format = String(req.query.format || 'pdf').toLowerCase();
    if (format === 'png') {
      const base = await guestBaseUrl(property);
      if (!base) return res.status(409).json({ success: false, error: 'No LAN guest address is configured' });
      const buffer = await qrPngBuffer(guestUrl(base, room.qr_token), 1400);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Disposition', `attachment; filename="room-${room.room_number}-qr.png"`);
      return res.send(buffer);
    }

    const base = await guestBaseUrl(property);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="room-${room.room_number}-qr-poster.pdf"`);
    await streamPosterPdf(res, property, [{ ...room, portal_base_url: base }]);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/room-qr/posters/pdf — printable batch of A4 posters
router.post('/posters/pdf', authenticateToken, requireRoles(...VIEW_ROLES), async (req, res) => {
  try {
    const property = await loadProperty(req.user.property_id);
    const requested = Array.isArray(req.body.room_ids) ? req.body.room_ids.map(String) : null;
    const rooms = await posterRows(req.user.property_id, requested && requested.length ? requested : null);
    if (!rooms.length) return res.status(404).json({ success: false, error: 'No generated room QR codes to print' });

    const base = await guestBaseUrl(property);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="nexuzy-room-qr-posters.pdf"');
    await streamPosterPdf(res, property, rooms.map(room => ({ ...room, portal_base_url: base })));

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'DOWNLOAD_ROOM_QR_POSTERS',
      entityType: 'room_qr',
      details: { rooms: rooms.map(r => r.room_number) },
      req
    });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
