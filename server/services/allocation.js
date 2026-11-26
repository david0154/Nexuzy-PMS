// Room availability, recommendation, assignment and transfer.
//
// Every function is property-scoped and every assignment re-checks overlap
// inside the caller's SQLite transaction. A room is never taken from a browser
// request on trust: the server resolves the room, dates and conflicts again.

const { v4: uuidv4 } = require('uuid');

const ACTIVE_RESERVATION_STATUSES = [
  'tentative', 'awaiting_advance', 'confirmed', 'partially_paid', 'fully_prepaid', 'checked_in'
];
const ACTIVE_STAY_STATUSES = ['occupied', 'extended'];
const ACTIVE_GROUP_STATUSES = ['reserved', 'checked_in'];
const BLOCKING_ROOM_STATUSES = ['occupied', 'out_of_order', 'out_of_service', 'blocked'];

function dateOnly(value) {
  return String(value || '').slice(0, 10);
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateOnly(value));
}

function isoDay(offset = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function listValue(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  const text = String(value).trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(v => String(v).trim()).filter(Boolean);
    } catch (err) { /* fall back to comma-separated */ }
  }
  return text.split(',').map(v => v.trim()).filter(Boolean);
}

function normalized(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function overlapsSql(alias, fromField, toField) {
  return `date(${alias}.${fromField}) < date(?) AND date(${alias}.${toField}) > date(?)`;
}

async function propertySettings(conn, propertyId) {
  const property = await conn.get('SELECT * FROM properties WHERE id = ?', [propertyId]);
  return property || {};
}

async function blockingMaintenance(conn, propertyId) {
  const rows = await conn.all(
    `SELECT room_id, title, priority FROM maintenance_tickets
     WHERE property_id = ? AND blocks_room = 1
       AND status IN ('open', 'in_progress', 'waiting_parts')`,
    [propertyId]
  );
  return new Map(rows.map(row => [row.room_id, row]));
}

/**
 * Returns every room with date-aware availability, current status, conflicts
 * and the information needed to rank it for a guest.
 */
async function listRoomAvailability(conn, propertyId, options = {}) {
  const checkIn = validDate(options.check_in) ? dateOnly(options.check_in) : isoDay(0);
  const checkOut = validDate(options.check_out) ? dateOnly(options.check_out) : isoDay(1);
  if (checkOut <= checkIn) throw Object.assign(new Error('Check-out must be after check-in'), { statusCode: 400 });

  const immediate = options.immediate === true;
  const property = await propertySettings(conn, propertyId);
  const rooms = await conn.all(
    `SELECT r.*, rt.name AS room_type_name, rt.code AS room_type_code,
            rt.base_rate, rt.tax_rate, rt.max_occupancy AS room_type_capacity,
            rt.extra_adult_rate, rt.amenities AS type_amenities
     FROM rooms r
     JOIN room_types rt ON r.room_type_id = rt.id
     WHERE r.property_id = ?
     ORDER BY r.room_number ASC`,
    [propertyId]
  );

  const stayOverlaps = await conn.all(
    `SELECT s.room_id, s.id AS stay_id, s.stay_number, s.status,
            date(s.check_in_time) AS from_date, date(s.expected_check_out) AS to_date
     FROM stays s
     WHERE s.property_id = ? AND s.status IN (${ACTIVE_STAY_STATUSES.map(() => '?').join(',')})
       AND ${overlapsSql('s', 'check_in_time', 'expected_check_out')}`,
    [propertyId, ...ACTIVE_STAY_STATUSES, checkOut, checkIn]
  );
  const reservationOverlaps = await conn.all(
    `SELECT res.id AS reservation_id, res.booking_reference, res.assigned_room_id AS room_id,
            res.status, res.check_in_date AS from_date, res.check_out_date AS to_date,
            g.first_name || ' ' || COALESCE(g.last_name, '') AS guest_name
     FROM reservations res JOIN guests g ON res.guest_id = g.id
     WHERE res.property_id = ? AND res.assigned_room_id IS NOT NULL
       AND res.status IN (${ACTIVE_RESERVATION_STATUSES.map(() => '?').join(',')})
       AND ${overlapsSql('res', 'check_in_date', 'check_out_date')}`,
    [propertyId, ...ACTIVE_RESERVATION_STATUSES, checkOut, checkIn]
  );
  const groupOverlaps = await conn.all(
    `SELECT gr.assigned_room_id AS room_id, gr.id, gr.guest_name,
            date(gr.planned_check_in) AS from_date, date(gr.planned_check_out) AS to_date
     FROM group_room_reservations gr
     JOIN group_reservations g ON gr.group_id = g.id
     WHERE g.property_id = ? AND gr.assigned_room_id IS NOT NULL
       AND gr.status IN (${ACTIVE_GROUP_STATUSES.map(() => '?').join(',')})
       AND ${overlapsSql('gr', 'planned_check_in', 'planned_check_out')}`,
    [propertyId, ...ACTIVE_GROUP_STATUSES, checkOut, checkIn]
  );
  const todayStays = await conn.all(
    `SELECT s.room_id, s.stay_number, date(s.check_in_time) AS from_date,
            date(s.expected_check_out) AS to_date
     FROM stays s
     WHERE s.property_id = ? AND s.status IN ('occupied', 'extended')
       AND date(s.expected_check_out) >= date('now')`,
    [propertyId]
  );
  const currentReservations = await conn.all(
    `SELECT res.assigned_room_id AS room_id, res.booking_reference
     FROM reservations res
     WHERE res.property_id = ? AND res.assigned_room_id IS NOT NULL
       AND res.status IN (${ACTIVE_RESERVATION_STATUSES.map(() => '?').join(',')})
       AND date(res.check_in_date) <= date('now') AND date(res.check_out_date) > date('now')`,
    [propertyId, ...ACTIVE_RESERVATION_STATUSES]
  );
  const maintenance = await blockingMaintenance(conn, propertyId);

  const byRoom = (rows) => {
    const map = new Map();
    for (const row of rows) {
      if (!row.room_id) continue;
      if (!map.has(row.room_id)) map.set(row.room_id, []);
      map.get(row.room_id).push(row);
    }
    return map;
  };
  const staysByRoom = byRoom(stayOverlaps);
  const resByRoom = byRoom(reservationOverlaps);
  const groupsByRoom = byRoom(groupOverlaps);
  const todayStayByRoom = byRoom(todayStays);
  const currentResByRoom = byRoom(currentReservations);

  const guests = Math.max(0, Number(options.guests || options.adults || 0) + Number(options.children || 0));
  const filters = {
    room_type_id: options.room_type_id || null,
    bed_type: normalized(options.bed_type || options.bed_preference),
    ac_type: normalized(options.ac_type || options.ac_preference),
    floor: options.floor || options.floor_preference || null,
    building: options.building || null,
    accessible: options.accessible === true || options.accessibility_required === true,
    smoking: normalized(options.smoking || options.smoking_preference),
    amenities: listValue(options.amenities || options.amenities_preference).map(normalized),
    min_rate: Number(options.min_rate || 0),
    max_rate: Number(options.max_rate || 0),
    status: options.status ? normalized(options.status) : null
  };

  const result = [];
  for (const room of rooms) {
    const capacity = Number(room.max_occupancy || room.room_type_capacity || 0);
    const rate = Number(room.rate_override || room.base_rate || 0);
    const roomStays = staysByRoom.get(room.id) || [];
    const roomReservations = resByRoom.get(room.id) || [];
    const roomGroups = groupsByRoom.get(room.id) || [];
    const block = maintenance.get(room.id);
    const currentStay = (todayStayByRoom.get(room.id) || [])[0] || null;
    const currentReservation = (currentResByRoom.get(room.id) || [])[0] || null;

    const reasonsBlocked = [];
    if (BLOCKING_ROOM_STATUSES.includes(room.operational_status)) {
      reasonsBlocked.push(`Room is ${String(room.operational_status).replace(/_/g, ' ')}`);
    }
    if (room.maintenance_status === 'under_repair') reasonsBlocked.push('Room is under repair');
    if (block) reasonsBlocked.push(`Blocking maintenance: ${block.title}`);
    if (roomStays.length) reasonsBlocked.push(`Occupied by stay ${roomStays[0].stay_number} for these dates`);
    if (roomReservations.length) reasonsBlocked.push(`Reserved by ${roomReservations[0].booking_reference}`);
    if (roomGroups.length) reasonsBlocked.push(`Held by group booking${roomGroups[0].guest_name ? ` (${roomGroups[0].guest_name})` : ''}`);

    const ready = ['clean', 'inspected'].includes(room.housekeeping_status);
    const cleaning = ['dirty', 'cleaning', 'cleaned'].includes(room.housekeeping_status);
    if (immediate && !ready) {
      reasonsBlocked.push(
        room.housekeeping_status === 'dirty'
          ? 'Room has not been cleaned after the last checkout'
          : 'Room is awaiting housekeeping inspection'
      );
    }

    let filterReason = null;
    if (filters.room_type_id && room.room_type_id !== filters.room_type_id) filterReason = 'Different room type';
    if (guests > 0 && capacity < guests) filterReason = `Sleeps ${capacity}; ${guests} guests requested`;
    if (filters.bed_type && filters.bed_type !== 'any' && normalized(room.bed_type) !== filters.bed_type) filterReason = 'Bed configuration does not match';
    if (filters.ac_type && filters.ac_type !== 'any' && normalized(room.ac_type) !== filters.ac_type) filterReason = 'AC preference does not match';
    if (filters.floor && String(room.floor || '') !== String(filters.floor)) filterReason = 'Different floor';
    if (filters.building && String(room.building || '') !== String(filters.building)) filterReason = 'Different building';
    if (filters.accessible && !Number(room.accessible)) filterReason = 'Not an accessible room';
    if (filters.smoking && filters.smoking !== 'any') {
      const isSmoking = Boolean(Number(room.smoking_allowed));
      if ((filters.smoking === 'smoking') !== isSmoking) filterReason = 'Smoking preference does not match';
    }
    if (filters.min_rate && rate < filters.min_rate) filterReason = 'Rate below selected range';
    if (filters.max_rate && rate > filters.max_rate) filterReason = 'Rate above selected range';
    const roomAmenities = listValue(room.features).concat(listValue(room.type_amenities)).map(normalized);
    if (filters.amenities.some(a => !roomAmenities.some(x => x.includes(a) || a.includes(x)))) {
      filterReason = 'Missing a requested facility';
    }

    const derivedStatus = reasonsBlocked.length
      ? (room.operational_status === 'blocked' ? 'blocked'
        : room.operational_status === 'out_of_order' || room.operational_status === 'out_of_service' || room.maintenance_status === 'under_repair'
          ? 'maintenance'
          : cleaning ? 'cleaning' : roomReservations.length || roomGroups.length ? 'reserved' : 'occupied')
      : cleaning ? 'cleaning' : currentStay ? 'occupied' : currentReservation ? 'reserved' : 'available';

    if (filters.status && filters.status !== 'all' && filters.status !== derivedStatus) continue;

    const available = reasonsBlocked.length === 0 && !filterReason;
    result.push({
      ...room,
      rate,
      capacity,
      amenities: listValue(room.features).concat(listValue(room.type_amenities)),
      bed_type: room.bed_type || 'queen',
      ac_type: room.ac_type || 'ac',
      accessible: Boolean(Number(room.accessible)),
      smoking_allowed: Boolean(Number(room.smoking_allowed)),
      available,
      available_for_dates: available,
      status: derivedStatus,
      housekeeping_status: room.housekeeping_status || 'clean',
      maintenance_status: room.maintenance_status || 'ok',
      current_stay: currentStay,
      current_reservation: currentReservation,
      conflicts: {
        stays: roomStays,
        reservations: roomReservations,
        groups: roomGroups
      },
      unavailable_reason: [...reasonsBlocked, filterReason].filter(Boolean).join('; ') || null,
      availability_from: checkIn,
      availability_to: checkOut
    });
  }

  return {
    check_in: checkIn,
    check_out: checkOut,
    immediate,
    total: result.length,
    available: result.filter(room => room.available).length,
    rooms: result
  };
}

function scoreRoom(room, preferences = {}) {
  let score = 40;
  const reasons = [];
  const guests = Number(preferences.guests || 0);
  const capacity = Number(room.capacity || 0);

  if (preferences.room_type_id && room.room_type_id === preferences.room_type_id) {
    score += 30;
    reasons.push(`exact ${room.room_type_name} match`);
  } else if (preferences.room_type_id) {
    score += 5;
    reasons.push('alternative room type');
  }
  if (guests > 0 && capacity >= guests) {
    score += 20 - Math.min(8, Math.max(0, capacity - guests));
    reasons.push(`sleeps ${guests}${capacity > guests ? ` (capacity ${capacity})` : ''}`);
  }
  const bedPref = normalized(preferences.bed_preference);
  if (bedPref && bedPref !== 'any' && normalized(room.bed_type) === bedPref) {
    score += 15;
    reasons.push(`${String(room.bed_type).replace(/_/g, ' ')} bed`);
  }
  const acPref = normalized(preferences.ac_preference);
  if (acPref && acPref !== 'any' && normalized(room.ac_type) === acPref) {
    score += 10;
    reasons.push(room.ac_type === 'non_ac' ? 'non-AC as requested' : 'AC as requested');
  }
  const floorPref = normalized(preferences.floor_preference);
  if (floorPref && normalized(room.floor) === floorPref) {
    score += 8;
    reasons.push(`${room.floor} preference`);
  }
  if ((preferences.accessibility_required === true) && Number(room.accessible)) {
    score += 20;
    reasons.push('accessible room');
  }
  const smokingPref = normalized(preferences.smoking_preference);
  if (smokingPref && smokingPref !== 'any' &&
      ((smokingPref === 'smoking') === Boolean(Number(room.smoking_allowed)))) {
    score += 8;
    reasons.push(smokingPref === 'smoking' ? 'smoking room' : 'non-smoking room');
  }
  const wanted = listValue(preferences.amenities_preference).map(normalized);
  const availableAmenities = listValue(room.amenities).map(normalized);
  const matched = wanted.filter(a => availableAmenities.some(x => x.includes(a) || a.includes(x)));
  if (matched.length) {
    score += matched.length * 4;
    reasons.push(`${matched.join(', ')} available`);
  }
  if (['clean', 'inspected'].includes(room.housekeeping_status)) {
    score += 8;
    reasons.push('housekeeping ready');
  }
  if (preferences.max_rate && Number(room.rate) <= Number(preferences.max_rate)) score += 4;
  if (room.available) score += 10;

  return {
    score,
    reasons: reasons.length
      ? reasons
      : ['available for the full stay', 'housekeeping ready']
  };
}

function recommendationSentence(room, scored, checkIn, checkOut) {
  const features = [
    room.room_type_name,
    room.bed_type ? `${String(room.bed_type).replace(/_/g, ' ')} bed` : null,
    room.capacity ? `sleeps ${room.capacity}` : null,
    `₹${Number(room.rate).toLocaleString('en-IN')}/night`
  ].filter(Boolean);
  return `Room ${room.room_number} recommended — ${features.join(', ')}. ${scored.reasons.join(', ')}. Available ${checkIn} to ${checkOut}.`;
}

async function recommendRooms(conn, propertyId, options = {}) {
  const availability = await listRoomAvailability(conn, propertyId, options);
  const preferences = {
    ...options,
    guests: Number(options.guests || 0) || (Number(options.adults || 0) + Number(options.children || 0))
  };
  const ranked = availability.rooms
    .filter(room => room.available)
    .map(room => {
      const scored = scoreRoom(room, preferences);
      return {
        ...room,
        score: scored.score,
        match_reasons: scored.reasons,
        recommendation: recommendationSentence(room, scored, availability.check_in, availability.check_out)
      };
    })
    .sort((a, b) => b.score - a.score || String(a.room_number).localeCompare(String(b.room_number), undefined, { numeric: true }));

  return {
    check_in: availability.check_in,
    check_out: availability.check_out,
    matches: ranked.length,
    rooms: ranked.slice(0, Number(options.limit || 10)),
    best: ranked[0] || null,
    searched_rooms: availability.total
  };
}

async function findConflicts(conn, { propertyId, roomId, checkIn, checkOut, excludeReservationId = null, excludeStayId = null }) {
  const conflicts = [];
  const stay = await conn.get(
    `SELECT s.id, s.stay_number, date(s.check_in_time) AS from_date, date(s.expected_check_out) AS to_date
     FROM stays s
     WHERE s.property_id = ? AND s.room_id = ?
       AND s.status IN (${ACTIVE_STAY_STATUSES.map(() => '?').join(',')})
       AND (? IS NULL OR s.id != ?)
       AND ${overlapsSql('s', 'check_in_time', 'expected_check_out')}
     LIMIT 1`,
    [propertyId, roomId, ...ACTIVE_STAY_STATUSES, excludeStayId, excludeStayId, checkOut, checkIn]
  );
  if (stay) conflicts.push(`occupied by stay ${stay.stay_number} from ${stay.from_date} to ${stay.to_date}`);

  const reservation = await conn.get(
    `SELECT res.id, res.booking_reference, res.check_in_date, res.check_out_date
     FROM reservations res
     WHERE res.property_id = ? AND res.assigned_room_id = ?
       AND res.status IN (${ACTIVE_RESERVATION_STATUSES.map(() => '?').join(',')})
       AND (? IS NULL OR res.id != ?)
       AND ${overlapsSql('res', 'check_in_date', 'check_out_date')}
     LIMIT 1`,
    [propertyId, roomId, ...ACTIVE_RESERVATION_STATUSES, excludeReservationId, excludeReservationId, checkOut, checkIn]
  );
  if (reservation) conflicts.push(`reserved by ${reservation.booking_reference} from ${reservation.check_in_date} to ${reservation.check_out_date}`);

  const group = await conn.get(
    `SELECT gr.id, gr.guest_name, gr.planned_check_in, gr.planned_check_out
     FROM group_room_reservations gr JOIN group_reservations g ON gr.group_id = g.id
     WHERE g.property_id = ? AND gr.assigned_room_id = ?
       AND gr.status IN (${ACTIVE_GROUP_STATUSES.map(() => '?').join(',')})
       AND ${overlapsSql('gr', 'planned_check_in', 'planned_check_out')}
     LIMIT 1`,
    [propertyId, roomId, ...ACTIVE_GROUP_STATUSES, checkOut, checkIn]
  );
  if (group) conflicts.push(`held by a group booking from ${group.planned_check_in} to ${group.planned_check_out}`);
  return conflicts;
}

/**
 * Validates a room for assignment. Call inside a transaction immediately before
 * writing the allocation so two reception devices cannot both pass a stale check.
 */
async function assertRoomAssignable(conn, {
  propertyId, roomId, checkIn, checkOut, excludeReservationId = null, excludeStayId = null,
  immediate = false, requireReady = true
}) {
  if (!validDate(checkIn) || !validDate(checkOut) || dateOnly(checkOut) <= dateOnly(checkIn)) {
    throw Object.assign(new Error('Valid check-in and check-out dates are required'), { statusCode: 400 });
  }
  const room = await conn.get(
    `SELECT r.*, rt.name AS room_type_name, rt.max_occupancy AS room_type_capacity
     FROM rooms r JOIN room_types rt ON r.room_type_id = rt.id
     WHERE r.id = ? AND r.property_id = ?`,
    [roomId, propertyId]
  );
  if (!room) throw Object.assign(new Error('Room not found for this property'), { statusCode: 404 });
  if (BLOCKING_ROOM_STATUSES.includes(room.operational_status)) {
    throw Object.assign(new Error(`Room ${room.room_number} is ${String(room.operational_status).replace(/_/g, ' ')} and cannot be assigned`), { statusCode: 409 });
  }
  if (room.maintenance_status === 'under_repair') {
    throw Object.assign(new Error(`Room ${room.room_number} is under repair and cannot be assigned`), { statusCode: 409 });
  }
  const block = await conn.get(
    `SELECT title FROM maintenance_tickets
     WHERE property_id = ? AND room_id = ? AND blocks_room = 1
       AND status IN ('open', 'in_progress', 'waiting_parts') LIMIT 1`,
    [propertyId, roomId]
  );
  if (block) {
    throw Object.assign(new Error(`Room ${room.room_number} has an unresolved maintenance issue: ${block.title}`), { statusCode: 409 });
  }
  if (immediate && room.operational_status === 'occupied') {
    throw Object.assign(new Error(`Room ${room.room_number} is currently occupied`), { statusCode: 409 });
  }
  if (immediate && requireReady && !['clean', 'inspected'].includes(room.housekeeping_status)) {
    throw Object.assign(new Error(`Room ${room.room_number} is not ready: housekeeping status is ${String(room.housekeeping_status).replace(/_/g, ' ')}`), { statusCode: 409 });
  }
  const conflicts = await findConflicts(conn, {
    propertyId, roomId, checkIn: dateOnly(checkIn), checkOut: dateOnly(checkOut),
    excludeReservationId, excludeStayId
  });
  if (conflicts.length) {
    throw Object.assign(new Error(`Double booking prevented for Room ${room.room_number}: ${conflicts.join('; ')}`), { statusCode: 409 });
  }
  return room;
}

async function closeActiveAllocation(conn, { propertyId, reservationId = null, stayId = null, userId = null, status = 'released', reason = null }) {
  const clauses = ['property_id = ?', "allocation_status IN ('assigned', 'checked_in')"];
  const params = [propertyId];
  if (reservationId) { clauses.push('reservation_id = ?'); params.push(reservationId); }
  if (stayId) { clauses.push('stay_id = ?'); params.push(stayId); }
  if (!reservationId && !stayId) return 0;
  const rows = await conn.all(`SELECT * FROM room_allocations WHERE ${clauses.join(' AND ')}`, params);
  for (const row of rows) {
    await conn.run(
      `UPDATE room_allocations
       SET allocation_status = ?, released_at = CURRENT_TIMESTAMP, released_by = ?, release_reason = ?
       WHERE id = ?`,
      [status, userId, reason, row.id]
    );
  }
  return rows.length;
}

async function markAllocationCheckedIn(conn, { propertyId, reservationId, stayId, userId = null }) {
  const row = await conn.get(
    `SELECT id FROM room_allocations
     WHERE property_id = ? AND reservation_id = ? AND allocation_status = 'assigned'
     ORDER BY assigned_at DESC LIMIT 1`,
    [propertyId, reservationId]
  );
  if (!row) return false;
  await conn.run(
    `UPDATE room_allocations
     SET allocation_status = 'checked_in', stay_id = ?, assigned_by = COALESCE(assigned_by, ?)
     WHERE id = ?`,
    [stayId, userId, row.id]
  );
  return true;
}

async function insertAllocation(conn, {
  propertyId, reservationId = null, stayId = null, roomId, guestId = null,
  previousRoomId = null, status = 'assigned', userId = null, reason = null
}) {
  const id = uuidv4();
  await conn.run(
    `INSERT INTO room_allocations
     (id, property_id, reservation_id, stay_id, room_id, guest_id, previous_room_id,
      allocation_status, assigned_at, assigned_by, allocation_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)`,
    [id, propertyId, reservationId, stayId, roomId, guestId, previousRoomId, status, userId, reason]
  );
  return id;
}

async function assignReservationRoom(conn, {
  propertyId, reservationId, roomId = null, userId = null, reason = null,
  mode = 'manual', override = false, property = null
}) {
  const reservation = await conn.get(
    'SELECT * FROM reservations WHERE id = ? AND property_id = ?',
    [reservationId, propertyId]
  );
  if (!reservation) throw Object.assign(new Error('Reservation not found for this property'), { statusCode: 404 });
  if (['checked_out', 'cancelled', 'no_show'].includes(reservation.status)) {
    throw Object.assign(new Error(`Cannot assign a room to a ${reservation.status} reservation`), { statusCode: 409 });
  }

  let chosenRoom = roomId;
  let recommendation = null;
  if (!chosenRoom) {
    const recommended = await recommendRooms(conn, propertyId, {
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
      immediate: dateOnly(reservation.check_in_date) <= isoDay(0),
      limit: 1
    });
    recommendation = recommended.best;
    if (!recommendation) {
      throw Object.assign(new Error('No suitable room is available for this reservation and its guest requirements'), { statusCode: 409 });
    }
    if (mode === 'manual' && !override) {
      return { requires_confirmation: true, recommendation, reservation };
    }
    chosenRoom = recommendation.id;
  }

  const settings = property || await propertySettings(conn, propertyId);
  const room = await assertRoomAssignable(conn, {
    propertyId,
    roomId: chosenRoom,
    checkIn: reservation.check_in_date,
    checkOut: reservation.check_out_date,
    excludeReservationId: reservation.id,
    immediate: dateOnly(reservation.check_in_date) <= isoDay(0) && reservation.status === 'checked_in',
    requireReady: Boolean(Number(settings.require_inspected_for_checkin ?? 1))
  });

  const previousRoomId = reservation.assigned_room_id || null;
  await closeActiveAllocation(conn, {
    propertyId, reservationId, userId,
    status: previousRoomId && previousRoomId !== chosenRoom ? 'released' : 'released',
    reason: previousRoomId && previousRoomId !== chosenRoom ? 'Reassigned before check-in' : 'Reassignment'
  });

  await conn.run(
    `UPDATE reservations
     SET assigned_room_id = ?, assignment_mode = ?, assignment_reason = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND property_id = ?`,
    [chosenRoom, mode, reason || recommendation && recommendation.recommendation || null, reservation.id, propertyId]
  );

  await insertAllocation(conn, {
    propertyId,
    reservationId: reservation.id,
    roomId: chosenRoom,
    guestId: reservation.guest_id,
    previousRoomId,
    status: reservation.status === 'checked_in' ? 'checked_in' : 'assigned',
    userId,
    reason: reason || recommendation && recommendation.recommendation || 'Room assigned'
  });

  return {
    room,
    recommendation,
    previous_room_id: previousRoomId,
    reservation: await conn.get('SELECT * FROM reservations WHERE id = ?', [reservation.id])
  };
}

async function unassignReservationRoom(conn, { propertyId, reservationId, userId = null, reason = null }) {
  const reservation = await conn.get(
    'SELECT * FROM reservations WHERE id = ? AND property_id = ?',
    [reservationId, propertyId]
  );
  if (!reservation) throw Object.assign(new Error('Reservation not found for this property'), { statusCode: 404 });
  if (reservation.status === 'checked_in') {
    throw Object.assign(new Error('An in-house guest must be moved with the room transfer workflow, not unassigned'), { statusCode: 409 });
  }
  if (reservation.status === 'checked_out') {
    throw Object.assign(new Error('Checked-out reservations cannot be unassigned'), { statusCode: 409 });
  }
  await closeActiveAllocation(conn, {
    propertyId, reservationId, userId, status: 'released',
    reason: reason || 'Unassigned before check-in'
  });
  await conn.run(
    `UPDATE reservations SET assigned_room_id = NULL, assignment_reason = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND property_id = ?`,
    [reason || 'Room unassigned', reservation.id, propertyId]
  );
  return { previous_room_id: reservation.assigned_room_id };
}

async function transferStayRoom(conn, {
  propertyId, stayId, newRoomId, userId = null, reason = null, property = null
}) {
  if (!reason) throw Object.assign(new Error('A reason is required for a room transfer'), { statusCode: 400 });
  const stay = await conn.get(
    `SELECT s.*, r.room_number AS old_room_number
     FROM stays s JOIN rooms r ON s.room_id = r.id
     WHERE s.id = ? AND s.property_id = ?`,
    [stayId, propertyId]
  );
  if (!stay) throw Object.assign(new Error('Stay not found for this property'), { statusCode: 404 });
  if (stay.status !== 'occupied') throw Object.assign(new Error('Only an active occupied stay can be transferred'), { statusCode: 409 });
  if (stay.room_id === newRoomId) throw Object.assign(new Error('The guest is already in this room'), { statusCode: 400 });

  const settings = property || await propertySettings(conn, propertyId);
  const room = await assertRoomAssignable(conn, {
    propertyId,
    roomId: newRoomId,
    checkIn: dateOnly(stay.check_in_time),
    checkOut: stay.expected_check_out,
    excludeReservationId: stay.reservation_id,
    excludeStayId: stay.id,
    immediate: true,
    requireReady: Boolean(Number(settings.require_inspected_for_checkin ?? 1))
  });

  await closeActiveAllocation(conn, {
    propertyId, stayId: stay.id, reservationId: stay.reservation_id, userId,
    status: 'transferred', reason
  });

  await conn.run(
    "UPDATE stays SET room_id = ?, status = 'occupied' WHERE id = ? AND property_id = ?",
    [newRoomId, stay.id, propertyId]
  );
  if (stay.reservation_id) {
    await conn.run(
      'UPDATE reservations SET assigned_room_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND property_id = ?',
      [newRoomId, stay.reservation_id, propertyId]
    );
  }
  // Revoke the session opened from the old room. The guest scans the new
  // room's permanent QR to start a fresh session; room QR identity never moves.
  await conn.run(
    "UPDATE guest_sessions SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, revoked_by = ? WHERE stay_id = ? AND property_id = ? AND status = 'active'",
    [userId || null, stay.id, propertyId]
  );

  await conn.run(
    "UPDATE rooms SET operational_status = 'available', housekeeping_status = 'dirty' WHERE id = ? AND property_id = ?",
    [stay.room_id, propertyId]
  );
  await conn.run(
    "UPDATE rooms SET operational_status = 'occupied' WHERE id = ? AND property_id = ?",
    [newRoomId, propertyId]
  );
  await conn.run(
    `INSERT INTO housekeeping_tasks (id, property_id, room_id, task_type, status, priority, notes)
     VALUES (?, ?, ?, 'room_transfer_cleaning', 'dirty', 'high', ?)`,
    [uuidv4(), propertyId, stay.room_id, `Room change: guest moved from ${stay.old_room_number} to ${room.room_number}`]
  );

  await insertAllocation(conn, {
    propertyId,
    reservationId: stay.reservation_id,
    stayId: stay.id,
    roomId: newRoomId,
    guestId: stay.primary_guest_id,
    previousRoomId: stay.room_id,
    status: 'checked_in',
    userId,
    reason
  });

  return { stay, room, previous_room_id: stay.room_id, previous_room_number: stay.old_room_number };
}

async function releaseStayAllocation(conn, { propertyId, stayId, reservationId = null, userId = null, reason = 'Checked out' }) {
  return closeActiveAllocation(conn, {
    propertyId, stayId, reservationId, userId, status: 'released', reason
  });
}

async function allocationDashboard(conn, propertyId, options = {}) {
  const checkIn = validDate(options.check_in) ? dateOnly(options.check_in) : isoDay(0);
  const checkOut = validDate(options.check_out) ? dateOnly(options.check_out) : isoDay(1);
  const availability = await listRoomAvailability(conn, propertyId, { ...options, check_in: checkIn, check_out: checkOut });
  const rooms = availability.rooms;

  const arrivals = await conn.get(
    `SELECT COUNT(*) AS count FROM reservations
     WHERE property_id = ? AND date(check_in_date) = date(?)
       AND status IN ('confirmed', 'partially_paid', 'fully_prepaid', 'awaiting_advance')`,
    [propertyId, checkIn]
  );
  const departures = await conn.get(
    `SELECT COUNT(*) AS count FROM stays
     WHERE property_id = ? AND status IN ('occupied', 'extended') AND date(expected_check_out) = date(?)`,
    [propertyId, checkOut]
  );
  const unassigned = await conn.get(
    `SELECT COUNT(*) AS count FROM reservations
     WHERE property_id = ? AND assigned_room_id IS NULL
       AND status IN ('tentative', 'awaiting_advance', 'confirmed', 'partially_paid', 'fully_prepaid')`,
    [propertyId]
  );
  const pendingRequests = await conn.get(
    "SELECT COUNT(*) AS count FROM guest_requests WHERE property_id = ? AND status IN ('pending', 'accepted', 'in_progress')",
    [propertyId]
  );
  const recent = await conn.all(
    `SELECT ra.*, r.room_number, res.booking_reference,
            g.first_name || ' ' || COALESCE(g.last_name, '') AS guest_name,
            u.full_name AS assigned_by_name
     FROM room_allocations ra
     JOIN rooms r ON ra.room_id = r.id
     LEFT JOIN reservations res ON ra.reservation_id = res.id
     LEFT JOIN guests g ON ra.guest_id = g.id
     LEFT JOIN users u ON ra.assigned_by = u.id
     WHERE ra.property_id = ?
     ORDER BY ra.assigned_at DESC LIMIT 12`,
    [propertyId]
  );

  return {
    check_in: checkIn,
    check_out: checkOut,
    counts: {
      total: rooms.length,
      available: rooms.filter(r => r.available).length,
      available_now: rooms.filter(r => r.available && r.housekeeping_status === 'clean').length,
      occupied: rooms.filter(r => r.status === 'occupied').length,
      reserved: rooms.filter(r => r.status === 'reserved').length,
      cleaning: rooms.filter(r => ['dirty', 'cleaning', 'cleaned'].includes(r.housekeeping_status)).length,
      inspected: rooms.filter(r => r.housekeeping_status === 'inspected').length,
      maintenance: rooms.filter(r => r.status === 'maintenance').length,
      blocked: rooms.filter(r => r.status === 'blocked').length,
      checkout_pending: rooms.filter(r => r.current_stay && dateOnly(r.current_stay.to_date) === isoDay(0)).length,
      unassigned_reservations: Number(unassigned.count || 0),
      arrivals: Number(arrivals.count || 0),
      departures: Number(departures.count || 0),
      guest_requests: Number(pendingRequests.count || 0)
    },
    recent_activity: recent
  };
}

async function availabilityTimeline(conn, propertyId, options = {}) {
  const start = validDate(options.from) ? dateOnly(options.from) : isoDay(0);
  const days = Math.min(31, Math.max(1, Number(options.days || 7)));
  const dates = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  const end = dates[dates.length - 1];
  const rooms = await conn.all(
    `SELECT r.id, r.room_number, r.floor, r.building, r.operational_status, r.housekeeping_status,
            r.maintenance_status, rt.name AS room_type_name
     FROM rooms r JOIN room_types rt ON r.room_type_id = rt.id
     WHERE r.property_id = ? ORDER BY r.room_number ASC`,
    [propertyId]
  );
  const stays = await conn.all(
    `SELECT s.room_id, s.id, s.stay_number, date(s.check_in_time) AS from_date,
            date(s.expected_check_out) AS to_date
     FROM stays s WHERE s.property_id = ? AND s.status IN ('occupied', 'extended')
       AND date(s.check_in_time) <= date(?) AND date(s.expected_check_out) >= date(?)`,
    [propertyId, end, start]
  );
  const reservations = await conn.all(
    `SELECT res.assigned_room_id AS room_id, res.booking_reference, res.check_in_date AS from_date,
            res.check_out_date AS to_date
     FROM reservations res WHERE res.property_id = ? AND res.assigned_room_id IS NOT NULL
       AND res.status IN (${ACTIVE_RESERVATION_STATUSES.map(() => '?').join(',')})
       AND date(res.check_in_date) <= date(?) AND date(res.check_out_date) >= date(?)`,
    [propertyId, ...ACTIVE_RESERVATION_STATUSES, end, start]
  );
  const groups = await conn.all(
    `SELECT gr.assigned_room_id AS room_id, gr.guest_name, gr.planned_check_in AS from_date,
            gr.planned_check_out AS to_date
     FROM group_room_reservations gr JOIN group_reservations g ON gr.group_id = g.id
     WHERE g.property_id = ? AND gr.assigned_room_id IS NOT NULL
       AND gr.status IN ('reserved', 'checked_in')
       AND date(gr.planned_check_in) <= date(?) AND date(gr.planned_check_out) >= date(?)`,
    [propertyId, end, start]
  );
  const maintenance = await blockingMaintenance(conn, propertyId);
  const occupancy = (row, day) => {
    if (!row) return false;
    return dateOnly(row.from_date) <= day && dateOnly(row.to_date) > day;
  };

  return {
    from: start,
    days,
    dates,
    rooms: rooms.map(room => ({
      ...room,
      cells: dates.map(day => {
        const stay = stays.find(s => s.room_id === room.id && occupancy(s, day));
        if (stay) {
          return { date: day, status: 'occupied', label: 'Occupied', reference: stay.stay_number };
        }
        // The departure day is not an occupied night, but marking it as
        // checkout keeps the stay's real length visible.
        const departing = stays.find(s => s.room_id === room.id && dateOnly(s.to_date) === day);
        if (departing) {
          return { date: day, status: 'checkout_pending', label: 'Checkout', reference: departing.stay_number };
        }
        // A stale 'occupied' room flag only describes today's live state. It must
        // never paint future days as blocked: an out-of-order room, an active
        // maintenance block or a real block status is what blocks a date.
        if (room.operational_status === 'occupied' && day === isoDay(0)) {
          return { date: day, status: 'occupied', label: 'Occupied' };
        }
        if (['out_of_order', 'out_of_service', 'blocked'].includes(room.operational_status) ||
            room.maintenance_status === 'under_repair' || maintenance.has(room.id)) {
          return { date: day, status: 'maintenance', label: 'Blocked' };
        }
        const reservation = reservations.find(r => r.room_id === room.id && occupancy(r, day));
        if (reservation) return { date: day, status: 'reserved', label: 'Reserved', reference: reservation.booking_reference };
        const group = groups.find(r => r.room_id === room.id && occupancy(r, day));
        if (group) return { date: day, status: 'reserved', label: 'Group', reference: group.guest_name };
        if (day === isoDay(0) && ['dirty', 'cleaning', 'cleaned'].includes(room.housekeeping_status)) {
          return { date: day, status: 'cleaning', label: room.housekeeping_status === 'cleaned' ? 'Inspect' : 'Cleaning' };
        }
        return { date: day, status: 'available', label: 'Available' };
      })
    }))
  };
}

module.exports = {
  ACTIVE_RESERVATION_STATUSES,
  isoDay,
  validDate,
  dateOnly,
  listRoomAvailability,
  recommendRooms,
  assertRoomAssignable,
  findConflicts,
  assignReservationRoom,
  unassignReservationRoom,
  transferStayRoom,
  releaseStayAllocation,
  insertAllocation,
  markAllocationCheckedIn,
  closeActiveAllocation,
  allocationDashboard,
  availabilityTimeline
};
