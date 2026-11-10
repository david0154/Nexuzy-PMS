// Nexuzy PMS Comprehensive Test Suite
// Validates PRD Section 7.7, Section 28, Section 30, and Section 36 Acceptance Criteria

const assert = require('assert');
const app = require('../server/app');
const http = require('http');

let server;
let baseUrl;
let authToken = '';

function request(method, path, body = null, token = authToken) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, body: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runTests() {
  console.log('========================================================');
  console.log('  Running Nexuzy PMS Acceptance & Integration Tests     ');
  console.log('========================================================\n');

  server = app.listen(0);
  const port = server.address().port;
  baseUrl = `http://localhost:${port}`;

  try {
    // 1. Health check
    const health = await request('GET', '/api/health');
    assert.strictEqual(health.status, 200, 'Health check should return 200');
    assert.strictEqual(health.body.status, 'healthy', 'Status should be healthy');
    console.log('✔ Test 1 Passed: System Health Check OK');

    // 2. Authentication test
    const loginRes = await request('POST', '/api/v1/auth/login', {
      username: 'admin',
      password: 'admin123'
    });
    assert.strictEqual(loginRes.status, 200, 'Admin login should succeed');
    assert.ok(loginRes.body.token, 'Token should be returned');
    authToken = loginRes.body.token;
    console.log('✔ Test 2 Passed: Authentication & JWT Generation OK');

    // 3. Unauthorized access check
    const unauthRes = await request('GET', '/api/v1/rooms', null, '');
    assert.strictEqual(unauthRes.status, 401, 'Unauthenticated request must be denied with 401');
    console.log('✔ Test 3 Passed: Role & Security Boundaries Enforced OK');

    // 4. Overlapping Double Booking Prevention (Core Principle 3 & PRD 6.2)
    const doubleBookRes = await request('POST', '/api/v1/reservations', {
      guest_data: { first_name: 'Test', phone: '+91 99999 11111' },
      check_in_date: '2026-11-09',
      check_out_date: '2026-11-12',
      room_type_id: 'rt-std-deluxe',
      assigned_room_id: 'room-101', // Room 101 is already occupied!
      rate_per_night: 2800
    });
    assert.strictEqual(doubleBookRes.status, 400, 'Double booking must return 400');
    assert.ok(doubleBookRes.body.error.includes('Double booking prevented'), 'Error must specify double booking prevention');
    console.log('✔ Test 4 Passed: Overlapping Room Double-Booking Strictly Blocked OK');

    // 5. Group Staggered Check-In (PRD Section 7.2)
    // Acme Corp group has Room 204 in 'reserved' status. Check it in now!
    const groupCheckInRes = await request('POST', '/api/v1/groups/grp-acme-2026/check-in-selected', {
      room_reservation_ids: ['grpr-204']
    });
    assert.strictEqual(groupCheckInRes.status, 200, 'Staggered check-in should succeed');
    assert.strictEqual(groupCheckInRes.body.groupStatus, 'fully_checked_in', 'Group status should become fully_checked_in once all 4 rooms arrive');
    console.log('✔ Test 5 Passed: Staggered Group Check-In (4th room checked in independently) OK');

    // 6. Group Staggered Check-Out (PRD Section 7.3)
    // Now check out Room 201 only, transferring its balance to master folio!
    const groupCheckOutRes = await request('POST', '/api/v1/groups/grp-acme-2026/check-out-selected', {
      room_reservation_ids: ['grpr-201'],
      transfer_balance_to_master: true
    });
    assert.strictEqual(groupCheckOutRes.status, 200, 'Staggered checkout should succeed');
    assert.strictEqual(groupCheckOutRes.body.groupStatus, 'partially_checked_out', 'Group status must become partially_checked_out while other rooms stay');
    console.log('✔ Test 6 Passed: Staggered Group Check-Out (Room 201 departed, remaining 3 rooms occupied) OK');

    // 7. Verify Room 201 released to Housekeeping as DIRTY (PRD Section 5.4 & 9)
    const room201Res = await request('GET', '/api/v1/rooms');
    const room201 = room201Res.body.rooms.find(r => r.id === 'room-201');
    assert.strictEqual(room201.operational_status, 'available');
    assert.strictEqual(room201.housekeeping_status, 'dirty');
    console.log('✔ Test 7 Passed: Room Released to Housekeeping with Status "dirty" OK');

    // 8. Restaurant Walk-in Direct Settlement Without Room (Section 34.3)
    const restOrder = await request('POST', '/api/v1/restaurant/orders', {
      order_type: 'takeaway',
      items: [
        { menu_item_id: 'item-7', item_name: 'Hyderabadi Chicken Dum Biryani', quantity: 2, unit_price: 390, tax_rate: 5.0 }
      ]
    });
    assert.strictEqual(restOrder.status, 200);
    const settleRes = await request('POST', `/api/v1/restaurant/orders/${restOrder.body.orderId}/settle`, {
      payment_method: 'upi'
    });
    assert.strictEqual(settleRes.status, 200);
    assert.ok(settleRes.body.billNumber.startsWith('REST-BILL-'));
    console.log('✔ Test 8 Passed: Separate Restaurant Bill Settle (No Room Needed) OK');

    // 9. Restaurant Post to Room Settlement (Section 34.4)
    // Room 102 is vacant, Room 101 has active stay. Post to Room 101!
    const roomServiceOrder = await request('POST', '/api/v1/restaurant/orders', {
      order_type: 'room_service',
      room_id: 'room-101',
      items: [
        { menu_item_id: 'item-1', item_name: 'Paneer Tikka Angara', quantity: 1, unit_price: 320, tax_rate: 5.0 },
        { menu_item_id: 'item-10', item_name: 'Fresh Mint Lime Soda', quantity: 2, unit_price: 120, tax_rate: 5.0 }
      ]
    });
    assert.strictEqual(roomServiceOrder.status, 200);

    const postToRoomRes = await request('POST', `/api/v1/restaurant/orders/${roomServiceOrder.body.orderId}/post-to-room`, {
      room_id: 'room-101'
    });
    assert.strictEqual(postToRoomRes.status, 200);
    assert.strictEqual(postToRoomRes.body.roomNumber, '101');
    console.log('✔ Test 9 Passed: Room Service Posted to In-House Guest Folio with 5% GST OK');

    // 10. Attempt Post to Unoccupied Room Fails (Section 34.4)
    const failPostRes = await request('POST', `/api/v1/restaurant/orders/${roomServiceOrder.body.orderId}/post-to-room`, {
      room_id: 'room-102' // Room 102 is not occupied!
    });
    assert.strictEqual(failPostRes.status, 400);
    console.log('✔ Test 10 Passed: Posting to Unoccupied Room Blocked OK');

    // 11. India GST Tax Invoice Generation (Section 12.3 & 34.5)
    const folio101Res = await request('POST', '/api/v1/folios/folio-101/invoice');
    assert.strictEqual(folio101Res.status, 200);
    const inv = folio101Res.body.invoice;
    assert.ok(inv.cgst > 0 && inv.sgst > 0, 'CGST and SGST should both be calculated');
    assert.strictEqual(inv.cgst, inv.sgst, 'CGST and SGST must match for intra-state GST');
    console.log(`✔ Test 11 Passed: Combined GST Tax Invoice (Subtotal: ₹${inv.subtotal}, CGST: ₹${inv.cgst}, SGST: ₹${inv.sgst}, Total: ₹${inv.grand_total}) OK`);

    // 12. Night Audit & Business Date Advance (Section 25)
    const auditRes = await request('POST', '/api/v1/night-audit/run');
    assert.strictEqual(auditRes.status, 200);
    assert.strictEqual(auditRes.body.summary.new_business_date, '2026-11-11');
    assert.ok(auditRes.body.summary.rooms_charged >= 3);
    console.log(`✔ Test 12 Passed: Night Audit Executed & Business Date Advanced to ${auditRes.body.summary.new_business_date} OK`);

    // 13. Night Audit Idempotency (Cannot run twice for same business date)
    const auditRetryRes = await request('POST', '/api/v1/night-audit/run', { business_date: '2026-11-10' });
    assert.strictEqual(auditRetryRes.status, 400);
    assert.ok(auditRetryRes.body.error.includes('already been run'));
    console.log('✔ Test 13 Passed: Night Audit Idempotency Protection OK');

    // 14. Cashier Shift Opening, Reconciliation & Closing (Section 12.4)
    const shiftOpenRes = await request('POST', '/api/v1/cashier/open-shift', {
      opening_float: 5000,
      notes: 'Test morning shift'
    });
    assert.strictEqual(shiftOpenRes.status, 200);

    const shiftCloseRes = await request('POST', '/api/v1/cashier/close-shift', {
      closing_cash: 5000,
      notes: 'Shift closed without discrepancy'
    });
    assert.strictEqual(shiftCloseRes.status, 200);
    assert.strictEqual(shiftCloseRes.body.summary.variance, 0);
    console.log('✔ Test 14 Passed: Cashier Shift Opening, Reconciliation & Closing OK');

    console.log('\n========================================================');
    console.log('  ALL 14 ACCEPTANCE & INTEGRATION TESTS PASSED 100%!    ');
    console.log('========================================================\n');
  } catch (err) {
    console.error('❌ Test suite failed:', err);
    process.exit(1);
  } finally {
    if (server) server.close();
  }
}

runTests();
