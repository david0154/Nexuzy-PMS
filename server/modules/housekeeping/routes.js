const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const { authenticateToken } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');

// GET /api/v1/housekeeping/tasks
router.get('/tasks', authenticateToken, async (req, res) => {
  try {
    const tasks = await db.all(
      `SELECT ht.*, r.room_number, r.floor, r.building, rt.name as room_type_name,
              u.full_name as assigned_to_name
       FROM housekeeping_tasks ht
       JOIN rooms r ON ht.room_id = r.id
       JOIN room_types rt ON r.room_type_id = rt.id
       LEFT JOIN users u ON ht.assigned_to = u.id
       WHERE ht.property_id = ? AND r.property_id = ?
         AND ht.status NOT IN ('inspected', 'ready')
       ORDER BY CASE ht.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END, ht.created_at ASC`,
      [req.user.property_id, req.user.property_id]
    );
    res.json({ success: true, tasks });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/housekeeping/tasks
router.post('/tasks', authenticateToken, async (req, res) => {
  try {
    const { room_id, task_type = 'daily_cleaning', priority = 'normal', assigned_to, notes } = req.body;
    const room = await db.get('SELECT id FROM rooms WHERE id = ? AND property_id = ?', [room_id, req.user.property_id]);
    if (!room) return res.status(404).json({ success: false, error: 'Room not found for this property' });
    if (assigned_to) {
      const staff = await db.get('SELECT id FROM users WHERE id = ? AND (property_id = ? OR property_id IS NULL) AND is_active = 1', [assigned_to, req.user.property_id]);
      if (!staff) return res.status(400).json({ success: false, error: 'Assigned staff member is not active in this property' });
    }
    const id = uuidv4();
    await db.run(
      `INSERT INTO housekeeping_tasks (id, property_id, room_id, task_type, status, priority, assigned_to, notes)
       VALUES (?, ?, ?, ?, 'dirty', ?, ?, ?)`,
      [id, req.user.property_id, room_id, task_type, priority, assigned_to || null, notes || null]
    );
    res.json({ success: true, message: 'Housekeeping task created', id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/v1/housekeeping/tasks/:id
router.patch('/tasks/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes, assigned_to } = req.body;

    const task = await db.get('SELECT * FROM housekeeping_tasks WHERE id = ? AND property_id = ?', [id, req.user.property_id]);
    if (!task) return res.status(404).json({ success: false, error: 'Task not found for this property' });

    await db.transaction(async () => {
      await db.run(
        `UPDATE housekeeping_tasks 
         SET status = COALESCE(?, status),
             notes = COALESCE(?, notes),
             assigned_to = COALESCE(?, assigned_to),
             completed_at = CASE WHEN ? IN ('inspected', 'ready', 'cleaned') THEN CURRENT_TIMESTAMP ELSE completed_at END
         WHERE id = ?`,
        [status, notes, assigned_to, status, id]
      );

      // Synchronize Room Housekeeping status (Section 9)
      if (status) {
        let roomHkStatus = 'dirty';
        if (status === 'cleaning') roomHkStatus = 'cleaning';
        else if (status === 'cleaned') roomHkStatus = 'cleaned';
        else if (status === 'inspected' || status === 'ready') roomHkStatus = 'inspected';

        await db.run(
          'UPDATE rooms SET housekeeping_status = ? WHERE id = ? AND property_id = ?',
          [roomHkStatus, task.room_id, req.user.property_id]
        );
      }
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'UPDATE_HOUSEKEEPING_TASK',
      entityType: 'housekeeping_task',
      entityId: id,
      details: { status },
      req
    });

    res.json({ success: true, message: 'Housekeeping task updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/housekeeping/board — live room-cleaning board for this property
router.get('/board', authenticateToken, async (req, res) => {
  try {
    const rooms = await db.all(
      `SELECT r.id, r.room_number, r.floor, r.building, r.operational_status,
              r.housekeeping_status, r.maintenance_status,
              rt.name AS room_type_name,
              s.stay_number, g.first_name || ' ' || COALESCE(g.last_name, '') AS guest_name
       FROM rooms r
       JOIN room_types rt ON r.room_type_id = rt.id
       LEFT JOIN stays s ON s.room_id = r.id AND s.status = 'occupied'
       LEFT JOIN guests g ON s.primary_guest_id = g.id
       WHERE r.property_id = ?
       ORDER BY CAST(r.room_number AS INTEGER) ASC, r.room_number ASC`,
      [req.user.property_id]
    );
    const tasks = await db.all(
      `SELECT ht.*, r.room_number, u.full_name AS assigned_to_name
       FROM housekeeping_tasks ht
       JOIN rooms r ON ht.room_id = r.id
       LEFT JOIN users u ON ht.assigned_to = u.id
       WHERE ht.property_id = ? AND ht.status NOT IN ('inspected', 'ready')
       ORDER BY ht.created_at ASC`,
      [req.user.property_id]
    );
    const requests = await db.all(
      `SELECT gr.*, r.room_number FROM guest_requests gr
       JOIN rooms r ON gr.room_id = r.id
       WHERE gr.property_id = ? AND gr.status IN ('pending','accepted','in_progress')
       ORDER BY gr.created_at ASC`,
      [req.user.property_id]
    );

    const board = {
      dirty: rooms.filter(r => r.housekeeping_status === 'dirty'),
      cleaning: rooms.filter(r => r.housekeeping_status === 'cleaning'),
      clean: rooms.filter(r => ['clean', 'inspected'].includes(r.housekeeping_status)),
      inspection_required: rooms.filter(r => r.housekeeping_status === 'cleaned'),
      blocked: rooms.filter(r => ['out_of_order', 'out_of_service', 'blocked'].includes(r.operational_status)),
      maintenance: rooms.filter(r => ['reported', 'under_repair'].includes(r.maintenance_status))
    };

    res.json({ success: true, rooms, tasks, guest_requests: requests, board });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
