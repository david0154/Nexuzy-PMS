const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const { authenticateToken, requireRoles } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');
const { round2, recalcFolio } = require('../../services/billing');

function dateOnly(value) {
  return String(value || '').slice(0, 10);
}

function nightsBetween(from, to) {
  const start = Date.parse(`${dateOnly(from)}T00:00:00Z`);
  const end = Date.parse(`${dateOnly(to)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 1;
  return Math.max(1, Math.round((end - start) / 86400000));
}

// GET /api/v1/night-audit/status
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const property = await db.get('SELECT * FROM properties WHERE id = ?', [req.user.property_id]);
    const currentDate = property.business_date;

    // Check if night audit already ran for this date
    const existingRun = await db.get(
      'SELECT * FROM night_audit_logs WHERE property_id = ? AND business_date = ? AND status = "success"',
      [req.user.property_id, currentDate]
    );

    // Occupied rooms, with the nights already billed so the operator can see
    // exactly what this audit run will post.
    const occupiedStays = await db.all(
      `SELECT s.*, r.room_number, rt.name as room_type_name, rt.tax_rate, f.id as folio_id,
              g.first_name || ' ' || COALESCE(g.last_name, '') AS guest_name
       FROM stays s
       JOIN rooms r ON s.room_id = r.id
       JOIN room_types rt ON r.room_type_id = rt.id
       JOIN folios f ON f.stay_id = s.id
       LEFT JOIN guests g ON s.primary_guest_id = g.id
       WHERE s.status = 'occupied' AND s.property_id = ?`,
      [req.user.property_id]
    );
    const eligibleStays = [];
    for (const stay of occupiedStays) {
      const posted = await db.get(
        `SELECT COALESCE(SUM(quantity), 0) AS nights FROM folio_entries
         WHERE folio_id = ? AND department = 'room_rent' AND total_amount > 0`,
        [stay.folio_id]
      );
      const bookedNights = nightsBetween(stay.check_in_time, stay.expected_check_out);
      const postedNights = Number(posted.nights) || 0;
      let willCharge = true;
      let reason = 'Room rent for tonight';
      if (dateOnly(stay.check_in_time) > currentDate) {
        willCharge = false;
        reason = 'Guest arrives after the business date';
      } else if (dateOnly(stay.expected_check_out) <= currentDate) {
        willCharge = false;
        reason = 'Departure date reached; no further rent';
      } else if (postedNights >= bookedNights) {
        willCharge = false;
        reason = `All ${bookedNights} booked night(s) already billed`;
      }
      eligibleStays.push({
        ...stay,
        booked_nights: bookedNights,
        posted_nights: postedNights,
        will_charge: willCharge,
        reason
      });
    }

    // Open cashier shifts
    const openShifts = await db.all(
      "SELECT s.*, u.full_name FROM cashier_shifts s JOIN users u ON s.user_id = u.id WHERE s.status = 'open' AND s.property_id = ?",
      [req.user.property_id]
    );

    // Pending arrivals
    const pendingArrivals = await db.all(
      "SELECT * FROM reservations WHERE check_in_date <= ? AND status = 'confirmed' AND property_id = ?",
      [currentDate, req.user.property_id]
    );

    // Recent night audits
    const auditHistory = await db.all(
      'SELECT * FROM night_audit_logs WHERE property_id = ? ORDER BY created_at DESC LIMIT 10',
      [req.user.property_id]
    );

    res.json({
      success: true,
      current_business_date: currentDate,
      already_run_today: !!existingRun,
      occupied_rooms_count: occupiedStays.length,
      eligible_stays: eligibleStays,
      open_shifts_count: openShifts.length,
      open_shifts: openShifts,
      pending_arrivals_count: pendingArrivals.length,
      audit_history: auditHistory
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/night-audit/run (Executes Night Audit & Advances Business Date)
router.post('/run', authenticateToken, requireRoles('admin', 'general_manager', 'front_desk'), async (req, res) => {
  try {
    const property = await db.get('SELECT * FROM properties WHERE id = ?', [req.user.property_id]);
    const currentBizDate = req.body.business_date || property.business_date;

    // Idempotency check: prevent duplicate rent posting on the same business date
    const existing = await db.get(
      'SELECT id FROM night_audit_logs WHERE property_id = ? AND business_date = ? AND status = "success"',
      [req.user.property_id, currentBizDate]
    );

    if (existing) {
      return res.status(400).json({
        success: false,
        error: `Night audit has already been run for business date ${currentBizDate}. Advance date before running again.`
      });
    }

    // Next business date
    const dateObj = new Date(currentBizDate);
    dateObj.setDate(dateObj.getDate() + 1);
    const nextBizDate = dateObj.toISOString().slice(0, 10);

    let roomsCharged = 0;
    let totalRoomRevenue = 0;
    let totalTax = 0;

    const auditLogId = uuidv4();

    await db.transaction(async (conn) => {
      // 1. Find all active occupied stays for this property only.
      const occupiedStays = await conn.all(
        `SELECT s.id as stay_id, s.nightly_rate, s.check_in_time, s.expected_check_out,
                s.room_id, r.room_number, rt.tax_rate, f.id as folio_id
         FROM stays s
         JOIN rooms r ON s.room_id = r.id
         JOIN room_types rt ON r.room_type_id = rt.id
         JOIN folios f ON f.stay_id = s.id
         WHERE s.status = 'occupied' AND s.property_id = ? AND f.property_id = ?`,
        [req.user.property_id, req.user.property_id]
      );

      // 2. Post one night of rent per stay, never more than the booked nights.
      // The audit used to post another full night on every run, so a repeated
      // audit (or an audit after checkout had already posted the nights) stacked
      // duplicate rent on the folio.
      for (const st of occupiedStays) {
        const checkInDate = dateOnly(st.check_in_time);
        const checkOutDate = dateOnly(st.expected_check_out);
        if (!checkInDate || !checkOutDate) continue;
        if (checkInDate > currentBizDate) continue; // not in house yet
        if (checkOutDate <= currentBizDate) continue; // departed on/before this date

        const bookedNights = nightsBetween(checkInDate, checkOutDate);
        const posted = await conn.get(
          `SELECT COALESCE(SUM(quantity), 0) AS nights FROM folio_entries
           WHERE folio_id = ? AND department = 'room_rent' AND total_amount > 0`,
          [st.folio_id]
        );
        if ((Number(posted.nights) || 0) >= bookedNights) continue;

        // One charge per calendar night: skip if rent for this business date is
        // already on the folio (check-in night, or a previous run).
        const already = await conn.get(
          `SELECT id FROM folio_entries
           WHERE folio_id = ? AND department = 'room_rent' AND date = ? AND total_amount > 0
           LIMIT 1`,
          [st.folio_id, currentBizDate]
        );
        if (already) continue;

        const rate = Number(st.nightly_rate);
        const taxRate = Number(st.tax_rate) || 12.0;
        const taxAmt = round2(rate * (taxRate / 100));
        const total = round2(rate + taxAmt);

        await conn.run(
          `INSERT INTO folio_entries
           (id, folio_id, date, department, description, quantity, unit_price, tax_rate, tax_amount, total_amount, created_by, idempotency_key)
           VALUES (?, ?, ?, 'room_rent', ?, 1, ?, ?, ?, ?, ?, ?)`,
          [
            uuidv4(), st.folio_id, currentBizDate,
            `Night Audit Room Rent - Room ${st.room_number}`, rate, taxRate, taxAmt, total,
            req.user.id, `night-audit:${st.stay_id}:${currentBizDate}`
          ]
        );

        await recalcFolio(conn, st.folio_id);
        roomsCharged++;
        totalRoomRevenue = round2(totalRoomRevenue + rate);
        totalTax = round2(totalTax + taxAmt);
      }

      // 3. Advance property business date
      await conn.run('UPDATE properties SET business_date = ? WHERE id = ?', [nextBizDate, req.user.property_id]);

      // 4. Record night audit record
      await conn.run(
        `INSERT INTO night_audit_logs
         (id, property_id, business_date, new_business_date, rooms_charged, total_room_revenue, total_tax, run_by, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'success')`,
        [auditLogId, req.user.property_id, currentBizDate, nextBizDate, roomsCharged, totalRoomRevenue, totalTax, req.user.full_name]
      );
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'RUN_NIGHT_AUDIT',
      entityType: 'night_audit',
      entityId: auditLogId,
      details: { fromDate: currentBizDate, toDate: nextBizDate, roomsCharged, totalRoomRevenue },
      req
    });

    res.json({
      success: true,
      message: `Night audit completed successfully. Business date advanced to ${nextBizDate}.`,
      summary: {
        previous_business_date: currentBizDate,
        new_business_date: nextBizDate,
        rooms_charged: roomsCharged,
        room_revenue_posted: totalRoomRevenue,
        taxes_posted: totalTax,
        total_posted: totalRoomRevenue + totalTax
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
