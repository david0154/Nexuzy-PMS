const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const { authenticateToken } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');

// Helper to re-evaluate and update group master status
async function refreshGroupStatus(groupId) {
  const rooms = await db.all('SELECT status FROM group_room_reservations WHERE group_id = ?', [groupId]);
  if (!rooms.length) return 'confirmed';

  const statuses = rooms.map(r => r.status);
  const total = statuses.length;
  const checkedInCount = statuses.filter(s => s === 'checked_in').length;
  const checkedOutCount = statuses.filter(s => s === 'checked_out').length;
  const cancelledCount = statuses.filter(s => s === 'cancelled' || s === 'no_show').length;

  let newStatus = 'confirmed';

  if (checkedInCount > 0 && (checkedInCount + checkedOutCount + cancelledCount < total)) {
    newStatus = 'partially_checked_in';
  } else if (checkedInCount > 0 && checkedOutCount > 0) {
    newStatus = 'partially_checked_out';
  } else if (checkedInCount + cancelledCount === total && checkedInCount > 0) {
    newStatus = 'fully_checked_in';
  } else if (checkedOutCount + cancelledCount === total && checkedOutCount > 0) {
    newStatus = 'completed';
  } else if (checkedOutCount > 0 && (checkedInCount > 0 || statuses.includes('reserved'))) {
    newStatus = 'partially_checked_out';
  } else if (cancelledCount === total) {
    newStatus = 'cancelled';
  }

  await db.run('UPDATE group_reservations SET status = ? WHERE id = ?', [newStatus, groupId]);
  return newStatus;
}

// GET /api/v1/groups
router.get('/', authenticateToken, async (req, res) => {
  try {
    const groups = await db.all(
      `SELECT g.*, 
              COUNT(gr.id) as room_count,
              SUM(CASE WHEN gr.status = 'checked_in' THEN 1 ELSE 0 END) as checked_in_count,
              SUM(CASE WHEN gr.status = 'checked_out' THEN 1 ELSE 0 END) as checked_out_count,
              SUM(CASE WHEN gr.status = 'reserved' THEN 1 ELSE 0 END) as reserved_count,
              f.balance as master_folio_balance
       FROM group_reservations g
       LEFT JOIN group_room_reservations gr ON gr.group_id = g.id
       LEFT JOIN folios f ON f.id = g.master_folio_id
       GROUP BY g.id
       ORDER BY g.planned_start_date DESC`
    );
    res.json({ success: true, groups });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/groups/:id
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const group = await db.get('SELECT * FROM group_reservations WHERE id = ?', [id]);
    if (!group) {
      return res.status(404).json({ success: false, error: 'Group reservation not found' });
    }

    const rooms = await db.all(
      `SELECT gr.*, 
              rt.name as room_type_name, rt.base_rate,
              r.room_number,
              s.id as stay_id, s.stay_number,
              f.id as folio_id, f.folio_number, f.total_charges, f.total_payments, f.balance
       FROM group_room_reservations gr
       JOIN room_types rt ON gr.room_type_id = rt.id
       LEFT JOIN rooms r ON gr.assigned_room_id = r.id
       LEFT JOIN stays s ON gr.stay_id = s.id
       LEFT JOIN folios f ON f.stay_id = s.id
       WHERE gr.group_id = ?
       ORDER BY r.room_number ASC, gr.planned_check_in ASC`,
      [id]
    );

    const masterFolio = group.master_folio_id 
      ? await db.get('SELECT * FROM folios WHERE id = ?', [group.master_folio_id])
      : null;

    res.json({ success: true, group, rooms, masterFolio });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/groups (Create Master Group + Room Slots)
router.post('/', authenticateToken, async (req, res) => {
  try {
    const {
      group_name, contact_name, contact_phone, contact_email,
      booking_source, planned_start_date, planned_end_date,
      rooms, deposit_amount, notes
    } = req.body;

    if (!group_name || !contact_name || !contact_phone || !planned_start_date || !planned_end_date || !rooms || !rooms.length) {
      return res.status(400).json({ success: false, error: 'Missing required group details or rooms' });
    }

    const groupId = uuidv4();
    const groupNo = `GRP-${Date.now().toString().slice(-6)}`;
    const masterFolioId = uuidv4();
    const masterFolioNo = `FOL-GRP-${Date.now().toString().slice(-4)}`;
    const deposit = Number(deposit_amount) || 0;

    await db.transaction(async () => {
      // 1. Create Master Folio
      await db.run(
        `INSERT INTO folios (id, folio_number, property_id, group_reservation_id, folio_type, status, total_charges, total_payments, balance)
         VALUES (?, ?, ?, ?, 'group_master', 'open', 0, ?, ?)`,
        [masterFolioId, masterFolioNo, req.user.property_id, groupId, deposit, -deposit]
      );

      // 2. Create Master Group Record
      await db.run(
        `INSERT INTO group_reservations 
         (id, group_booking_number, property_id, group_name, contact_name, contact_phone, contact_email, booking_source, planned_start_date, planned_end_date, total_rooms, status, notes, master_folio_id, deposit_amount, deposit_allocated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, 0)`,
        [groupId, groupNo, req.user.property_id, group_name, contact_name, contact_phone, contact_email || null, booking_source || 'direct', planned_start_date, planned_end_date, rooms.length, notes || null, masterFolioId, deposit]
      );

      // Record deposit payment if provided
      if (deposit > 0) {
        const payId = uuidv4();
        const recNo = `REC-GRP-${Date.now().toString().slice(-6)}`;
        await db.run(
          `INSERT INTO payments (id, receipt_number, property_id, folio_id, group_id, amount, payment_method, payment_type, cashier_id, notes)
           VALUES (?, ?, ?, ?, ?, ?, 'bank_transfer', 'advance_deposit', ?, 'Group advance deposit')`,
          [payId, recNo, req.user.property_id, masterFolioId, groupId, deposit, req.user.id]
        );
      }

      // 3. Create individual Room Reservation records under the master
      for (const r of rooms) {
        const grId = uuidv4();
        await db.run(
          `INSERT INTO group_room_reservations 
           (id, group_id, room_type_id, assigned_room_id, guest_name, planned_check_in, planned_check_out, nightly_rate, status, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?)`,
          [
            grId,
            groupId,
            r.room_type_id,
            r.assigned_room_id || null,
            r.guest_name || contact_name,
            r.planned_check_in || planned_start_date,
            r.planned_check_out || planned_end_date,
            r.nightly_rate,
            r.notes || null
          ]
        );
      }
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'CREATE_GROUP_RESERVATION',
      entityType: 'group_reservation',
      entityId: groupId,
      details: { groupNo, group_name, roomCount: rooms.length },
      req
    });

    res.json({
      success: true,
      message: 'Group reservation created successfully',
      groupId,
      groupBookingNumber: groupNo
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/groups/:id/check-in-selected (Section 7.2 Staggered Check-In)
router.post('/:id/check-in-selected', authenticateToken, async (req, res) => {
  try {
    const { id: groupId } = req.params;
    const { room_reservation_ids } = req.body; // Array of group_room_reservations IDs

    if (!room_reservation_ids || !Array.isArray(room_reservation_ids) || !room_reservation_ids.length) {
      return res.status(400).json({ success: false, error: 'Array of room_reservation_ids is required' });
    }

    const checkInTime = new Date().toISOString().replace('T', ' ').substring(0, 19);

    const checkedInRooms = await db.transaction(async () => {
      const results = [];

      for (const grId of room_reservation_ids) {
        const gr = await db.get(
          `SELECT gr.*, r.room_number, rt.tax_rate 
           FROM group_room_reservations gr
           JOIN room_types rt ON gr.room_type_id = rt.id
           LEFT JOIN rooms r ON gr.assigned_room_id = r.id
           WHERE gr.id = ? AND gr.group_id = ?`,
          [grId, groupId]
        );

        if (!gr) {
          throw new Error(`Group room record ${grId} not found`);
        }
        if (gr.status !== 'reserved') {
          throw new Error(`Room ${gr.room_number || gr.id} is already in status: ${gr.status}`);
        }
        if (!gr.assigned_room_id) {
          throw new Error(`Room not assigned for guest ${gr.guest_name}. Please assign a physical room before check-in.`);
        }

        // Verify room is available / not occupied
        const currentRoom = await db.get('SELECT * FROM rooms WHERE id = ?', [gr.assigned_room_id]);
        if (currentRoom.operational_status === 'occupied') {
          throw new Error(`Room ${currentRoom.room_number} is currently occupied.`);
        }
        if (currentRoom.operational_status === 'out_of_order') {
          throw new Error(`Room ${currentRoom.room_number} is Out of Order.`);
        }

        // Create or find guest
        let guestId = gr.guest_id;
        if (!guestId) {
          guestId = uuidv4();
          await db.run(
            `INSERT INTO guests (id, property_id, first_name, phone)
             VALUES (?, ?, ?, '0000000000')`,
            [guestId, req.user.property_id, gr.guest_name || 'Group Guest']
          );
        }

        // 1. Create Stay record
        const stayId = uuidv4();
        const stayNo = `STY-${Date.now().toString().slice(-6)}-${gr.room_number}`;
        await db.run(
          `INSERT INTO stays 
           (id, stay_number, property_id, group_room_reservation_id, room_id, primary_guest_id, check_in_time, expected_check_out, status, nightly_rate)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'occupied', ?)`,
          [stayId, stayNo, req.user.property_id, grId, gr.assigned_room_id, guestId, checkInTime, gr.planned_check_out, gr.nightly_rate]
        );

        // 2. Create Stay Room Folio
        const folioId = uuidv4();
        const folioNo = `FOL-${gr.room_number}-${Date.now().toString().slice(-4)}`;
        const taxRate = gr.tax_rate || 12.0;
        const taxAmt = Math.round(gr.nightly_rate * (taxRate / 100));
        const totalNightCharge = gr.nightly_rate + taxAmt;

        await db.run(
          `INSERT INTO folios (id, folio_number, property_id, stay_id, folio_type, status, total_charges, total_payments, balance)
           VALUES (?, ?, ?, ?, 'room', 'open', ?, 0, ?)`,
          [folioId, folioNo, req.user.property_id, stayId, totalNightCharge, totalNightCharge]
        );

        // 3. Post first night room charge to stay folio
        await db.run(
          `INSERT INTO folio_entries (id, folio_id, date, department, description, quantity, unit_price, tax_rate, tax_amount, total_amount, created_by)
           VALUES (?, ?, date('now'), 'room_rent', 'Night 1 Room Rent', 1, ?, ?, ?, ?, ?)`,
          [uuidv4(), folioId, gr.nightly_rate, taxRate, taxAmt, totalNightCharge, req.user.id]
        );

        // 4. Update group_room_reservation record
        await db.run(
          `UPDATE group_room_reservations 
           SET status = 'checked_in', actual_check_in = ?, stay_id = ?, guest_id = ?
           WHERE id = ?`,
          [checkInTime, stayId, guestId, grId]
        );

        // 5. Update room operational status to occupied
        await db.run(
          `UPDATE rooms SET operational_status = 'occupied' WHERE id = ?`,
          [gr.assigned_room_id]
        );

        results.push({
          group_room_id: grId,
          room_number: gr.room_number,
          guest_name: gr.guest_name,
          stay_number: stayNo,
          stay_id: stayId
        });
      }

      return results;
    });

    // Refresh master group status
    const newMasterStatus = await refreshGroupStatus(groupId);

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'GROUP_STAGGERED_CHECK_IN',
      entityType: 'group_reservation',
      entityId: groupId,
      details: { checkedInRooms, newMasterStatus },
      req
    });

    res.json({
      success: true,
      message: `Successfully checked in ${checkedInRooms.length} room(s)`,
      checkedInRooms,
      groupStatus: newMasterStatus
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/v1/groups/:id/check-out-selected (Section 7.3 Staggered Check-Out)
router.post('/:id/check-out-selected', authenticateToken, async (req, res) => {
  try {
    const { id: groupId } = req.params;
    const { room_reservation_ids, transfer_balance_to_master = false } = req.body;

    if (!room_reservation_ids || !Array.isArray(room_reservation_ids) || !room_reservation_ids.length) {
      return res.status(400).json({ success: false, error: 'Array of room_reservation_ids is required' });
    }

    const checkOutTime = new Date().toISOString().replace('T', ' ').substring(0, 19);

    const group = await db.get('SELECT * FROM group_reservations WHERE id = ?', [groupId]);

    const checkedOutRooms = await db.transaction(async () => {
      const results = [];

      for (const grId of room_reservation_ids) {
        const gr = await db.get(
          `SELECT gr.*, r.room_number, s.id as stay_id, f.id as folio_id, f.balance
           FROM group_room_reservations gr
           JOIN rooms r ON gr.assigned_room_id = r.id
           JOIN stays s ON gr.stay_id = s.id
           LEFT JOIN folios f ON f.stay_id = s.id
           WHERE gr.id = ? AND gr.group_id = ?`,
          [grId, groupId]
        );

        if (!gr || gr.status !== 'checked_in') {
          throw new Error(`Room ${gr ? gr.room_number : grId} is not in checked-in status`);
        }

        // If folio has outstanding balance and user requested transfer to master folio:
        if (gr.balance > 0 && transfer_balance_to_master && group.master_folio_id) {
          // Transfer to master folio
          await db.run(
            `INSERT INTO folio_entries (id, folio_id, date, department, description, quantity, unit_price, tax_rate, tax_amount, total_amount, created_by)
             VALUES (?, ?, date('now'), 'other', ?, 1, ?, 0, 0, ?, ?)`,
            [uuidv4(), group.master_folio_id, `Transferred charges from Room ${gr.room_number}`, gr.balance, gr.balance, req.user.id]
          );

          // Credit room folio
          await db.run(
            `INSERT INTO folio_entries (id, folio_id, date, department, description, quantity, unit_price, tax_rate, tax_amount, total_amount, created_by, is_transferred, transferred_to_folio_id)
             VALUES (?, ?, date('now'), 'discount', ?, 1, ?, 0, 0, ?, ?, 1, ?)`,
            [uuidv4(), gr.folio_id, `Transferred to Group Master Folio`, -gr.balance, -gr.balance, req.user.id, group.master_folio_id]
          );

          // Update master folio balance
          await db.run(
            `UPDATE folios SET total_charges = total_charges + ?, balance = balance + ? WHERE id = ?`,
            [gr.balance, gr.balance, group.master_folio_id]
          );

          // Set room folio balance to 0 and settled
          await db.run(
            `UPDATE folios SET balance = 0, status = 'settled' WHERE id = ?`,
            [gr.folio_id]
          );
        } else if (gr.balance > 0 && !transfer_balance_to_master) {
          throw new Error(`Room ${gr.room_number} has an unpaid balance of ₹${gr.balance}. Settle payment or select 'Transfer to Master Folio'.`);
        }

        // 1. Update stay status
        await db.run(
          `UPDATE stays SET status = 'checked_out', actual_check_out_time = ? WHERE id = ?`,
          [checkOutTime, gr.stay_id]
        );

        // 2. Update group room status
        await db.run(
          `UPDATE group_room_reservations SET status = 'checked_out', actual_check_out = ? WHERE id = ?`,
          [checkOutTime, grId]
        );

        // 3. Release room to housekeeping (vacant dirty as per Core Principle 5.4)
        await db.run(
          `UPDATE rooms SET operational_status = 'available', housekeeping_status = 'dirty' WHERE id = ?`,
          [gr.assigned_room_id]
        );

        // 4. Automatically create housekeeping task (PRD Section 9)
        await db.run(
          `INSERT INTO housekeeping_tasks (id, property_id, room_id, task_type, status, priority, notes)
           VALUES (?, ?, ?, 'checkout_cleaning', 'dirty', 'high', ?)`,
          [uuidv4(), req.user.property_id, gr.assigned_room_id, `Automatic checkout cleaning for Room ${gr.room_number}`]
        );

        results.push({ room_number: gr.room_number, group_room_id: grId });
      }

      return results;
    });

    const newMasterStatus = await refreshGroupStatus(groupId);

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'GROUP_STAGGERED_CHECK_OUT',
      entityType: 'group_reservation',
      entityId: groupId,
      details: { checkedOutRooms, newMasterStatus },
      req
    });

    res.json({
      success: true,
      message: `Successfully checked out ${checkedOutRooms.length} room(s). Housekeeping tasks generated.`,
      checkedOutRooms,
      groupStatus: newMasterStatus
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/v1/groups/:id/rooms/:roomReservationId/cancel
router.post('/:id/rooms/:roomReservationId/cancel', authenticateToken, async (req, res) => {
  try {
    const { id: groupId, roomReservationId } = req.params;
    const { reason } = req.body;

    const gr = await db.get('SELECT * FROM group_room_reservations WHERE id = ? AND group_id = ?', [roomReservationId, groupId]);
    if (!gr) {
      return res.status(404).json({ success: false, error: 'Group room reservation not found' });
    }
    if (gr.status === 'checked_in') {
      return res.status(400).json({ success: false, error: 'Cannot cancel a room that is currently checked in' });
    }

    await db.run("UPDATE group_room_reservations SET status = 'cancelled' WHERE id = ?", [roomReservationId]);
    const newMasterStatus = await refreshGroupStatus(groupId);

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'CANCEL_GROUP_ROOM',
      entityType: 'group_room_reservation',
      entityId: roomReservationId,
      details: { reason, newMasterStatus },
      req
    });

    res.json({ success: true, message: 'Room cancelled within group', groupStatus: newMasterStatus });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
