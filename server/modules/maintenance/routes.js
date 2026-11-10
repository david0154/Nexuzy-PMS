const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const { authenticateToken } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');

// GET /api/v1/maintenance/tickets
router.get('/tickets', authenticateToken, async (req, res) => {
  try {
    const tickets = await db.all(
      `SELECT mt.*, r.room_number, r.floor, r.building,
              u.full_name as assigned_to_name
       FROM maintenance_tickets mt
       LEFT JOIN rooms r ON mt.room_id = r.id
       LEFT JOIN users u ON mt.assigned_to = u.id
       ORDER BY CASE mt.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, mt.created_at DESC`
    );
    res.json({ success: true, tickets });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/maintenance/tickets
router.post('/tickets', authenticateToken, async (req, res) => {
  try {
    const { room_id, title, description, category, priority = 'medium', blocks_room = 0, assigned_to } = req.body;
    if (!title) return res.status(400).json({ success: false, error: 'Ticket title is required' });

    const id = uuidv4();

    await db.transaction(async () => {
      await db.run(
        `INSERT INTO maintenance_tickets (id, property_id, room_id, title, description, category, priority, status, blocks_room, reported_by, assigned_to)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
        [id, req.user.property_id, room_id || null, title, description || null, category || 'general', priority, blocks_room ? 1 : 0, req.user.id, assigned_to || null]
      );

      // If blocks_room is set, mark room out_of_order
      if (room_id && blocks_room) {
        await db.run("UPDATE rooms SET operational_status = 'out_of_order', maintenance_status = 'under_repair' WHERE id = ?", [room_id]);
      }
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'CREATE_MAINTENANCE_TICKET',
      entityType: 'maintenance_ticket',
      entityId: id,
      details: { title, room_id, blocks_room },
      req
    });

    res.json({ success: true, message: 'Maintenance ticket created', id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/v1/maintenance/tickets/:id
router.patch('/tickets/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, resolution_notes } = req.body;

    const ticket = await db.get('SELECT * FROM maintenance_tickets WHERE id = ?', [id]);
    if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });

    await db.transaction(async () => {
      await db.run(
        `UPDATE maintenance_tickets 
         SET status = ?, 
             resolved_at = CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP ELSE resolved_at END
         WHERE id = ?`,
        [status, status, id]
      );

      // If ticket resolved and room was blocked, restore room to available & clean/dirty
      if (ticket.room_id && status === 'completed') {
        await db.run("UPDATE rooms SET operational_status = 'available', maintenance_status = 'ok' WHERE id = ?", [ticket.room_id]);
      }
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'UPDATE_MAINTENANCE_TICKET',
      entityType: 'maintenance_ticket',
      entityId: id,
      details: { status, resolution_notes },
      req
    });

    res.json({ success: true, message: `Maintenance ticket updated to ${status}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
