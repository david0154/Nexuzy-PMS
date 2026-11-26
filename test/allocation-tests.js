// Nexuzy PMS — room allocation, availability, transfer and QR session tests.
// Runs against an isolated database so it never touches hotel data.

const path = require('path');
process.env.NODE_ENV = 'test';
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'test-allocation.db');

const assert = require('assert');
const http = require('http');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const app = require('../server/app');
const db = require('../server/config/database');
const runSeed = require('../server/db/seed');

let server;
let baseUrl;
let adminToken = '';
let betaToken = '';

function request(method, urlPath, body = null, bearer = adminToken) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const headers = { 'Content-Type': 'application/json' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (err) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function login(username, password) {
  const res = await request('POST', '/api/v1/auth/login', { username, password }, '');
  assert.strictEqual(res.status, 200, `Login for ${username} failed: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

function day(offset) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

async function ensureBetaProperty() {
  const propId = 'prop-allocation-beta';
  await db.run(
    `INSERT INTO properties (id, name, code, city, state, business_date, default_room_tax_rate, default_restaurant_tax_rate, room_assignment_mode)
     VALUES (?, 'Beta Allocation Hotel', 'BETA-ALLOC', 'Pune', 'Maharashtra', ?, 12, 5, 'auto')`,
    [propId, day(0)]
  );
  await db.run(
    `INSERT INTO users (id, property_id, username, password_hash, full_name, role)
     VALUES (?, ?, 'betaalloc', ?, 'Beta Allocation Admin', 'admin')`,
    [uuidv4(), propId, await bcrypt.hash('beta123', 10)]
  );
  await db.run(
    `INSERT INTO room_types (id, property_id, name, code, base_rate, max_occupancy, tax_rate)
     VALUES ('rt-beta-alloc', ?, 'Beta Standard', 'BALLOC', 1500, 3, 12)`,
    [propId]
  );
  await db.run(
    `INSERT INTO rooms (id, property_id, room_number, room_type_id, floor, building, operational_status, housekeeping_status)
     VALUES ('beta-alloc-room', ?, 'B-201', 'rt-beta-alloc', '2', 'Beta Wing', 'available', 'clean')`,
    [propId]
  );
}

async function createReservation({ checkIn, checkOut, roomTypeId, adults = 1, children = 0, roomId = null, autoAssign = false, rate = 2500 }) {
  return request('POST', '/api/v1/reservations', {
    guest_data: { first_name: 'Alloc', last_name: `Guest${Date.now()}`, phone: `9${String(Date.now()).slice(-9)}` },
    check_in_date: checkIn,
    check_out_date: checkOut,
    room_type_id: roomTypeId,
    assigned_room_id: roomId,
    auto_assign: autoAssign,
    adult_count: adults,
    child_count: children,
    rate_per_night: rate
  });
}

async function main() {
  console.log('========================================================');
  console.log('  Nexuzy PMS — Room Allocation & Availability Tests     ');
  console.log('========================================================\n');

  await runSeed({ force: true });
  await ensureBetaProperty();

  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  adminToken = await login('admin', 'admin123');
  betaToken = await login('betaalloc', 'beta123');

  try {
    const standardType = await db.get("SELECT id FROM room_types WHERE property_id = 'prop-nexuzy-01' AND id = 'rt-std-deluxe'");
    assert.ok(standardType, 'Seeded standard room type is required');

    // 14. Date-aware availability across different ranges.
    const futureIn = '2031-01-05';
    const futureOut = '2031-01-07';
    const futureAvailable = await request('GET', `/api/v1/allocation/availability?check_in=${futureIn}&check_out=${futureOut}&status=available`);
    assert.strictEqual(futureAvailable.status, 200);
    assert.ok(futureAvailable.body.available > 0, 'Future dates must have sellable rooms');
    const activeDates = await request('GET', `/api/v1/allocation/availability?check_in=${day(0)}&check_out=${day(1)}&status=all`);
    const room101 = activeDates.body.rooms.find(room => room.room_number === '101');
    assert.ok(room101 && room101.available === false, 'Occupied room 101 must never be available');
    const room103Future = futureAvailable.body.rooms.find(room => room.room_number === '103');
    assert.ok(room103Future, 'Room 103 must be available for a future range with no reservations');
    const seededRange = await request('GET', '/api/v1/allocation/availability?check_in=2026-11-11&check_out=2026-11-12&status=all');
    const room103Seeded = seededRange.body.rooms.find(room => room.room_number === '103');
    assert.ok(room103Seeded && room103Seeded.available === true, 'Room 103 is free on a date when only rooms 101/201-203 are occupied');
    console.log('✔ 14. Availability is date-aware across different ranges');

    // 1. Auto-assign the best matching available room.
    await db.run("UPDATE properties SET room_assignment_mode = 'auto', auto_assign_on_booking = 1 WHERE id = 'prop-nexuzy-01'");
    const autoRes = await createReservation({ checkIn: futureIn, checkOut: futureOut, roomTypeId: standardType.id, adults: 1, children: 1, autoAssign: true });
    assert.strictEqual(autoRes.status, 200, `Auto reservation failed: ${JSON.stringify(autoRes.body)}`);
    assert.ok(autoRes.body.assignedRoom, 'Auto mode must return an assigned room');
    const autoReservationId = autoRes.body.reservationId;
    const autoRow = await db.get('SELECT * FROM reservations WHERE id = ?', [autoReservationId]);
    assert.ok(autoRow.assigned_room_id, 'Auto mode must persist the room on the reservation');
    const autoAllocations = await request('GET', `/api/v1/allocation/history?reservation_id=${autoReservationId}`);
    assert.ok(autoAllocations.body.allocations.length >= 1, 'Auto assignment must be recorded in allocation history');
    console.log('✔ 1. Auto mode assigns the best matching room and records history');

    // 2. No suitable room is rejected rather than overbooked.
    const maintenanceRoom = await db.get("SELECT id FROM rooms WHERE property_id = 'prop-nexuzy-01' AND room_number = '302'");
    const noRoomRes = await createReservation({ checkIn: '2031-03-03', checkOut: '2031-03-04', roomTypeId: standardType.id, autoAssign: false });
    const blockedAssign = await request('POST', '/api/v1/allocation/assign', {
      reservation_id: noRoomRes.body.reservationId,
      room_id: maintenanceRoom.id,
      mode: 'manual'
    });
    assert.strictEqual(blockedAssign.status, 409, 'Assigning a room under maintenance must fail');
    const emptyRecommend = await request('POST', '/api/v1/allocation/recommend', {
      reservation_id: noRoomRes.body.reservationId,
      guests: 99
    });
    assert.strictEqual(emptyRecommend.status, 200);
    assert.strictEqual(emptyRecommend.body.rooms.length, 0, 'No room can fit 99 guests');
    console.log('✔ 2. Assignment is blocked when no suitable room exists');

    // 3. Existing reservation overlap is rejected at creation.
    const overlapping = await createReservation({
      checkIn: futureIn, checkOut: futureOut, roomTypeId: standardType.id,
      roomId: autoRow.assigned_room_id, rate: 2500
    });
    assert.ok([400, 409].includes(overlapping.status), 'Overlapping same-room reservation must be rejected');
    console.log('✔ 3. Overlapping reservations are rejected');

    // 7. Reassign an unarrived reservation to another room, and 6. unassign it.
    const recommend = await request('POST', '/api/v1/allocation/recommend', { reservation_id: autoReservationId });
    assert.strictEqual(recommend.status, 200);
    assert.ok(recommend.body.rooms.length >= 1);
    const alternative = recommend.body.rooms.find(room => room.id !== autoRow.assigned_room_id);
    assert.ok(alternative, 'A second suitable room is required for the reassignment test');
    const reassigned = await request('POST', '/api/v1/allocation/assign', {
      reservation_id: autoReservationId, room_id: alternative.id, mode: 'manual', override: true, reason: 'Test reassignment'
    });
    assert.strictEqual(reassigned.status, 200, JSON.stringify(reassigned.body));
    assert.strictEqual(reassigned.body.previous_room_id, autoRow.assigned_room_id);
    const afterReassign = await db.get('SELECT assigned_room_id FROM reservations WHERE id = ?', [autoReservationId]);
    assert.strictEqual(afterReassign.assigned_room_id, alternative.id);
    console.log('✔ 7. A reservation can be reassigned to another available room');

    const unassigned = await request('POST', '/api/v1/allocation/unassign', {
      reservation_id: autoReservationId, reason: 'Test unassign'
    });
    assert.strictEqual(unassigned.status, 200);
    const afterUnassign = await db.get('SELECT assigned_room_id, status FROM reservations WHERE id = ?', [autoReservationId]);
    assert.strictEqual(afterUnassign.assigned_room_id, null);
    assert.strictEqual(afterUnassign.status, 'confirmed', 'Unassigning must not cancel the reservation');
    console.log('✔ 6. Unassigning before arrival keeps the reservation active and frees the room');

    // 4. Concurrent assignment of the same room: exactly one winner.
    const concurrentRoom = await db.get("SELECT id FROM rooms WHERE property_id = 'prop-nexuzy-01' AND room_number = '104'");
    const firstConcurrent = await createReservation({ checkIn: '2031-02-02', checkOut: '2031-02-04', roomTypeId: standardType.id });
    const secondConcurrent = await createReservation({ checkIn: '2031-02-02', checkOut: '2031-02-04', roomTypeId: standardType.id });
    const [assignA, assignB] = await Promise.all([
      request('POST', '/api/v1/allocation/assign', { reservation_id: firstConcurrent.body.reservationId, room_id: concurrentRoom.id, mode: 'manual' }),
      request('POST', '/api/v1/allocation/assign', { reservation_id: secondConcurrent.body.reservationId, room_id: concurrentRoom.id, mode: 'manual' })
    ]);
    const statuses = [assignA.status, assignB.status].sort();
    assert.deepStrictEqual(statuses, [200, 409], `Concurrent assignment must have one winner: ${JSON.stringify([assignA.body, assignB.body])}`);
    const concurrentCount = await db.get(
      "SELECT COUNT(*) AS count FROM room_allocations WHERE room_id = ? AND allocation_status IN ('assigned','checked_in')",
      [concurrentRoom.id]
    );
    assert.strictEqual(Number(concurrentCount.count), 1, 'Only one active allocation may exist for a room');
    console.log('✔ 4. Two concurrent assignments cannot take the same room');

    // 5. Check-in when no room was assigned (Scenario B).
    await db.run("UPDATE properties SET room_assignment_mode = 'auto', auto_assign_on_checkin = 1 WHERE id = 'prop-nexuzy-01'");
    const checkInRes = await createReservation({ checkIn: day(0), checkOut: day(1), roomTypeId: standardType.id, adults: 1, autoAssign: false });
    assert.strictEqual(checkInRes.status, 200, JSON.stringify(checkInRes.body));
    const checkIn = await request('POST', '/api/v1/stays/check-in-reservation', { reservation_id: checkInRes.body.reservationId, auto_assign: true });
    assert.strictEqual(checkIn.status, 200, `Check-in without a room failed: ${JSON.stringify(checkIn.body)}`);
    const checkedInStayId = checkIn.body.stay_id || checkIn.body.stayId;
    assert.ok(checkedInStayId, 'Check-in must return the stay id');
    const checkedInStay = await db.get('SELECT * FROM stays WHERE id = ?', [checkedInStayId]);
    const checkedInReservation = await db.get('SELECT * FROM reservations WHERE id = ?', [checkInRes.body.reservationId]);
    assert.strictEqual(checkedInReservation.assigned_room_id, checkedInStay.room_id, 'Check-in must persist the assigned room');
    assert.strictEqual(checkedInStay.status, 'occupied');
    console.log('✔ 5. Check-in recommends and assigns a room when none was set');

    // 11. Guest QR session exists for the checked-in room.
    await request('PATCH', '/api/v1/settings/property', {
      lan_guest_url: `http://127.0.0.1:${server.address().port}`,
      guest_portal_enabled: true,
      room_qr_enabled: true,
      guest_order_enabled: true,
      guest_bill_enabled: true
    });
    await request('POST', '/api/v1/room-qr/generate-all', {});
    const roomQr = await db.get('SELECT * FROM room_qr_codes WHERE room_id = ?', [checkedInStay.room_id]);
    assert.ok(roomQr && roomQr.qr_token, 'Permanent room QR token must exist');
    const guestResolve = await request('POST', '/api/v1/guest-room/resolve', { qr_token: roomQr.qr_token }, '');
    assert.strictEqual(guestResolve.status, 200, JSON.stringify(guestResolve.body));
    const oldGuestSession = guestResolve.body.session_token;
    assert.ok(oldGuestSession);

    // 8. Transfer during an active stay; old QR session becomes inactive.
    await db.run("UPDATE properties SET require_inspected_for_checkin = 0 WHERE id = 'prop-nexuzy-01'");
    const transferCandidates = await request('GET', `/api/v1/allocation/availability?check_in=${day(0)}&check_out=${day(1)}&status=available&immediate=1`);
    const newRoom = transferCandidates.body.rooms.find(room => room.id !== checkedInStay.room_id && room.operational_status === 'available');
    assert.ok(newRoom, 'A ready room is required for the transfer test');
    const transfer = await request('POST', '/api/v1/allocation/transfer', {
      stay_id: checkedInStayId, new_room_id: newRoom.id, reason: 'Allocation integration test'
    });
    assert.strictEqual(transfer.status, 200, JSON.stringify(transfer.body));
    const transferredStay = await db.get('SELECT * FROM stays WHERE id = ?', [checkedInStayId]);
    assert.strictEqual(transferredStay.room_id, newRoom.id);
    const oldRoom = await db.get('SELECT * FROM rooms WHERE id = ?', [checkedInStay.room_id]);
    assert.strictEqual(oldRoom.housekeeping_status, 'dirty', 'Old room must go to housekeeping');
    const oldSessionAfterTransfer = await request('GET', '/api/v1/guest-room/bill', null, '', { 'X-Guest-Session': oldGuestSession });
    const sessionRows = await db.all('SELECT id, stay_id, status FROM guest_sessions WHERE stay_id = ?', [checkedInStayId]);
    assert.ok([401, 403].includes(oldSessionAfterTransfer.status), `Old room QR session must be inactive after transfer (${oldSessionAfterTransfer.status}): ${JSON.stringify(sessionRows)}`);
    console.log('✔ 8. In-house transfer moves the guest and sends the old room to housekeeping');
    console.log('✔ 11a. The old guest QR session is revoked after a transfer');

    // 13. Every allocation action is in history and audit logs.
    const transferHistory = await request('GET', `/api/v1/allocation/history?stay_id=${checkedInStayId}`);
    assert.ok(transferHistory.body.allocations.length >= 2, 'Transfer must leave the old and new allocations');
    const auditRows = await db.all(
      "SELECT action FROM audit_logs WHERE entity_id = ? AND action IN ('ROOM_TRANSFER','ROOM_ASSIGNED')",
      [checkedInStayId]
    );
    assert.ok(auditRows.length >= 1, 'Room transfer must be audited');
    console.log('✔ 13. Room changes are retained in allocation history and audit logs');

    // 9. Checkout releases allocation and 10. the room stays unavailable until cleaned.
    const checkout = await request('POST', `/api/v1/stays/${checkedInStayId}/check-out`, { allow_override: true, refund_acknowledged: true });
    assert.strictEqual(checkout.status, 200, JSON.stringify(checkout.body));
    const activeAfterCheckout = await db.get(
      "SELECT COUNT(*) AS count FROM room_allocations WHERE stay_id = ? AND allocation_status = 'active'",
      [checkedInStayId]
    );
    assert.strictEqual(Number(activeAfterCheckout.count), 0, 'Checkout must release the active allocation');
    const dirtyAvailability = await request('GET', `/api/v1/allocation/availability?check_in=${day(0)}&check_out=${day(1)}&status=all&immediate=1`);
    const dirtyRoom = dirtyAvailability.body.rooms.find(room => room.id === newRoom.id);
    assert.ok(dirtyRoom && dirtyRoom.available === false, 'A dirty room must not be sellable immediately');
    await db.run("UPDATE rooms SET housekeeping_status = 'clean' WHERE id = ?", [newRoom.id]);
    const cleanedAvailability = await request('GET', `/api/v1/allocation/availability?check_in=${day(0)}&check_out=${day(1)}&status=all&immediate=1`);
    const cleanedRoom = cleanedAvailability.body.rooms.find(room => room.id === newRoom.id);
    assert.ok(cleanedRoom && cleanedRoom.available === true, 'The room becomes available after cleaning');
    const oldSessionAfterCheckout = await request('GET', '/api/v1/guest-room/bill', null, '', { 'X-Guest-Session': oldGuestSession });
    assert.ok([401, 403].includes(oldSessionAfterCheckout.status), 'Checkout must revoke the guest QR session');
    console.log('✔ 9. Checkout releases the room allocation');
    console.log('✔ 10. The room stays unavailable until housekeeping marks it clean');
    console.log('✔ 11b. The guest QR session is inactive after checkout');

    // 12. Another property can neither see nor assign this reservation.
    const crossPropertyAssign = await request('POST', '/api/v1/allocation/assign', {
      reservation_id: checkInRes.body.reservationId, room_id: 'beta-alloc-room', mode: 'manual'
    }, betaToken);
    assert.strictEqual(crossPropertyAssign.status, 404, 'A foreign property must not assign this reservation');
    const betaAvailability = await request('GET', '/api/v1/allocation/availability?check_in=2031-01-05&check_out=2031-01-07', null, betaToken);
    assert.ok(betaAvailability.body.rooms.every(room => room.id === 'beta-alloc-room'), 'Availability must be property-scoped');
    console.log('✔ 12. Rooms and reservations are isolated by property');

    console.log('\n========================================================');
    console.log('  ALL ROOM ALLOCATION & AVAILABILITY TESTS PASSED       ');
    console.log('========================================================');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

main()
  .then(async () => { await db.close(); process.exit(0); })
  .catch(async (err) => {
    console.error('\n✘ TEST FAILURE:', err.message);
    console.error(err.stack);
    try { await db.close(); } catch (closeErr) { /* ignore */ }
    process.exit(1);
  });
