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
       ORDER BY CASE ht.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END, ht.created_at ASC`
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

    const task = await db.get('SELECT * FROM housekeeping_tasks WHERE id = ?', [id]);
    if (!task) return res.status(404).json({ success: false, error: 'Task not found' });

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

        await db.run('UPDATE rooms SET housekeeping_status = ? WHERE id = ?', [roomHkStatus, task.room_id]);
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

module.exports = router;
