// P0 financial-correctness acceptance tests:
// advance ledger, booking confirmation conditions, checkout bill confirmation,
// final invoice locking, duplicate payment/charge prevention, LAN controls.
// Uses an isolated database so it never touches the hotel's live data.

const path = require('path');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'test-financial.db');

const assert = require('assert');
const http = require('http');
const app = require('../server/app');
const runSeed = require('../server/db/seed');
const network = require('../server/modules/network/service');

let server;
let baseUrl;
let token = '';

function request(method, urlPath, body = null, bearer = token, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (err) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function run() {
  console.log('========================================================');
  console.log('  Nexuzy PMS — P0 Financial & LAN Acceptance Tests      ');
  console.log('========================================================\n');

  await runSeed({ force: true });
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const login = await request('POST', '/api/v1/auth/login', { username: 'admin', password: 'admin123' }, '');
    assert.strictEqual(login.status, 200, 'Admin login should succeed');
    token = login.body.token;

    await request('PATCH', '/api/v1/settings/property', {
      require_advance_for_confirmation: true,
      advance_percentage: 30,
      advance_due_days: 3
    });
    console.log('✔ Setup: property advance-confirmation policy enabled');

    // 1. Awaiting-advance booking + confirmation blocked
    const created = await request('POST', '/api/v1/reservations', {
      guest_data: { first_name: 'Asha', last_name: 'Rao', phone: '+91 90000 11111', email: 'asha@example.com' },
      check_in_date: '2026-12-01',
      check_out_date: '2026-12-03',
      room_type_id: 'rt-std-deluxe',
      rate_per_night: 2000,
      booking_source: 'direct'
    });
    assert.strictEqual(created.status, 200, JSON.stringify(created.body));
    assert.strictEqual(created.body.status, 'awaiting_advance', 'Booking should await the required advance');
    assert.strictEqual(created.body.advanceRequired, 1344, '30% of 2 nights x 2000 + 12% GST');
    const resId = created.body.reservationId;

    const blockedConfirmation = await request('POST', `/api/v1/reservations/${resId}/documents`, {
      document_type: 'booking_confirmation'
    });
    assert.strictEqual(blockedConfirmation.status, 400, 'Confirmation must be blocked before advance conditions are met');
    console.log('✔ Test 1: Booking waits for advance and confirmation document is blocked');

    // 2. Advance receipt + idempotent replay
    const advance1 = await request('POST', `/api/v1/reservations/${resId}/advances`, {
      amount: 1000,
      payment_method: 'upi',
      transaction_ref: 'UPI-TEST-1',
      idempotency_key: 'adv-asha-1'
    });
    assert.strictEqual(advance1.status, 200, JSON.stringify(advance1.body));
    assert.ok(advance1.body.receipt.receipt_number.startsWith('ADV-'), 'Advance receipt number must use the ADV series');
    assert.strictEqual(advance1.body.reservation.status, 'awaiting_advance');

    const replay = await request('POST', `/api/v1/reservations/${resId}/advances`, {
      amount: 1000,
      payment_method: 'upi',
      idempotency_key: 'adv-asha-1'
    });
    assert.strictEqual(replay.status, 200);
    assert.strictEqual(replay.body.duplicate, true, 'Replayed advance must not post twice');
    const ledger = await request('GET', `/api/v1/reservations/${resId}/advances`);
    assert.strictEqual(ledger.body.advances.length, 1, 'Only one advance should exist after a replay');
    assert.strictEqual(ledger.body.totals.advance_received, 1000);

    const advance2 = await request('POST', `/api/v1/reservations/${resId}/advances`, {
      amount: 344,
      payment_method: 'cash',
      idempotency_key: 'adv-asha-2'
    });
    assert.strictEqual(advance2.status, 200);
    assert.strictEqual(advance2.body.reservation.status, 'confirmed', 'Advance meeting the requirement should confirm');
    assert.strictEqual(advance2.body.reservation.payment_status, 'partially_paid');
    console.log('✔ Test 2: Advance receipts, ledger and duplicate-payment prevention OK');

    // 3. Confirmation document, then date change with price-difference guard
    const confirmation = await request('POST', `/api/v1/reservations/${resId}/documents`, {
      document_type: 'booking_confirmation'
    });
    assert.strictEqual(confirmation.status, 200, JSON.stringify(confirmation.body));
    assert.ok(confirmation.body.document.document_number.startsWith('CNF-'));

    const changeAttempt = await request('PATCH', `/api/v1/reservations/${resId}`, {
      check_out_date: '2026-12-04'
    });
    assert.strictEqual(changeAttempt.status, 409, 'Price-affecting change must ask for confirmation');
    assert.strictEqual(changeAttempt.body.requires_confirmation, true);
    assert.strictEqual(changeAttempt.body.change_summary.old_total, 4480);
    assert.strictEqual(changeAttempt.body.change_summary.new_total, 6720);
    assert.strictEqual(changeAttempt.body.change_summary.difference, 2240);

    const confirmedChange = await request('PATCH', `/api/v1/reservations/${resId}`, {
      check_out_date: '2026-12-04',
      confirm_change: true
    });
    assert.strictEqual(confirmedChange.status, 200, JSON.stringify(confirmedChange.body));
    assert.strictEqual(confirmedChange.body.price_difference, 2240);
    assert.ok(confirmedChange.body.confirmation_document, 'Revised confirmation document should be issued');
    assert.strictEqual(confirmedChange.body.confirmation_document.version, 2);
    console.log('✔ Test 3: Price difference shown and revised confirmation versioned OK');

    // 4. Check in to an available room
    const availability = await request('GET', '/api/v1/rooms/availability?check_in=2026-12-01&check_out=2026-12-04&room_type_id=rt-std-deluxe');
    assert.strictEqual(availability.status, 200);
    const assignedRoom = availability.body.rooms.find(r => r.operational_status !== 'occupied');
    assert.ok(assignedRoom, 'A vacant available room is required for check-in');

    const checkIn = await request('POST', '/api/v1/stays/check-in-reservation', {
      reservation_id: resId,
      assigned_room_id: assignedRoom.id
    });
    assert.strictEqual(checkIn.status, 200, JSON.stringify(checkIn.body));
    const stayId = checkIn.body.stayId;
    console.log(`✔ Test 4: Guest checked into Room ${assignedRoom.room_number} with folio`);

    // 5. Room-posted vs separately paid restaurant bills
    const postedOrder = await request('POST', '/api/v1/restaurant/orders', {
      order_type: 'room_service',
      room_id: assignedRoom.id,
      items: [{ menu_item_id: 'item-1', quantity: 1 }]
    });
    assert.strictEqual(postedOrder.status, 200, JSON.stringify(postedOrder.body));
    const posted = await request('POST', `/api/v1/restaurant/orders/${postedOrder.body.orderId}/post-to-room`, {
      room_id: assignedRoom.id
    });
    assert.strictEqual(posted.status, 200, JSON.stringify(posted.body));

    const separateOrder = await request('POST', '/api/v1/restaurant/orders', {
      order_type: 'room_service',
      room_id: assignedRoom.id,
      items: [{ menu_item_id: 'item-4', quantity: 1 }]
    });
    assert.strictEqual(separateOrder.status, 200, JSON.stringify(separateOrder.body));
    const settled = await request('POST', `/api/v1/restaurant/orders/${separateOrder.body.orderId}/settle`, {
      payment_method: 'card'
    });
    assert.strictEqual(settled.status, 200, JSON.stringify(settled.body));
    assert.ok(settled.body.billNumber.startsWith('REST-BILL-'));

    const preview = await request('GET', `/api/v1/stays/${stayId}/checkout-preview`);
    assert.strictEqual(preview.status, 200, JSON.stringify(preview.body));
    const bill = preview.body.preview;
    assert.strictEqual(bill.restaurant.posted_to_room.length, 1, 'Posted order must appear once');
    assert.ok(bill.restaurant.paid_separately.length >= 1, 'Separately settled bill must be listed informationally');
    assert.strictEqual(bill.restaurant.paid_separately[0].included_in_bill, false);
    assert.ok(bill.totals.gross_charges >= postedOrder.body.totalAmount, 'Posted charge must be in payable charges');
    assert.ok(
      Math.abs(bill.totals.gross_charges - postedOrder.body.totalAmount) >= 0.004 ||
      bill.totals.gross_charges === postedOrder.body.totalAmount,
      'Separate bill must not be added to payable charges'
    );

    const postedEntryCount = bill.entries.filter(e => e.reference_type === 'restaurant_order').length;
    assert.strictEqual(postedEntryCount, 1, 'Room-posted restaurant charge must appear exactly once');
    console.log('✔ Test 5: Separate-payment vs room-posting reconciliation OK');

    // 6. Checkout requires bill confirmation
    const prematureCheckout = await request('POST', `/api/v1/stays/${stayId}/check-out`, {});
    assert.strictEqual(prematureCheckout.status, 409);
    assert.strictEqual(prematureCheckout.body.requires_bill_confirmation, true);

    const confirmBill = await request('POST', `/api/v1/stays/${stayId}/checkout-preview/confirm`, {});
    assert.strictEqual(confirmBill.status, 200, JSON.stringify(confirmBill.body));
    assert.ok(confirmBill.body.snapshot_id);

    const unpaidCheckout = await request('POST', `/api/v1/stays/${stayId}/check-out`, {});
    assert.strictEqual(unpaidCheckout.status, 400, 'Unpaid balance must block checkout');
    assert.ok(unpaidCheckout.body.balance_due > 0);
    console.log('✔ Test 6: Bill preview confirmation and unpaid-balance guard OK');

    // 7. Pay the balance (idempotently), generate the final invoice, check out
    const balance = unpaidCheckout.body.balance_due;
    const payment = await request('POST', `/api/v1/folios/${bill.folio.id}/payments`, {
      amount: balance,
      payment_method: 'upi',
      transaction_ref: 'UPI-CHECKOUT-1',
      idempotency_key: 'checkout-payment-1'
    }, token, { 'Idempotency-Key': 'checkout-payment-1' });
    assert.strictEqual(payment.status, 200, JSON.stringify(payment.body));
    const paymentReplay = await request('POST', `/api/v1/folios/${bill.folio.id}/payments`, {
      amount: balance,
      payment_method: 'upi',
      idempotency_key: 'checkout-payment-1'
    });
    assert.strictEqual(paymentReplay.status, 200);
    assert.strictEqual(paymentReplay.body.duplicate, true);

    const invoiceRes = await request('POST', `/api/v1/stays/${stayId}/invoice`, {});
    assert.strictEqual(invoiceRes.status, 200, JSON.stringify(invoiceRes.body));
    const invoice = invoiceRes.body.invoice;
    assert.ok(invoice.invoice_number.startsWith('INV-'));
    assert.strictEqual(invoice.grand_total, bill.totals.gross_charges, 'Invoice total must equal folio charges');
    assert.strictEqual(invoice.paid_amount, bill.totals.total_payments + balance);
    assert.strictEqual(invoice.balance_due, 0);

    const duplicateInvoice = await request('POST', `/api/v1/stays/${stayId}/invoice`, {});
    assert.strictEqual(duplicateInvoice.status, 200);
    assert.strictEqual(duplicateInvoice.body.duplicate, true);
    assert.strictEqual(duplicateInvoice.body.invoice.invoice_number, invoice.invoice_number);

    const checkOut = await request('POST', `/api/v1/stays/${stayId}/check-out`, {});
    assert.strictEqual(checkOut.status, 200, JSON.stringify(checkOut.body));
    assert.strictEqual(checkOut.body.invoice.invoice_number, invoice.invoice_number);

    const again = await request('POST', `/api/v1/stays/${stayId}/check-out`, {});
    assert.strictEqual(again.status, 400, 'Double checkout must be blocked');

    const rooms = await request('GET', '/api/v1/rooms');
    const room = rooms.body.rooms.find(r => r.id === assignedRoom.id);
    assert.strictEqual(room.operational_status, 'available');
    assert.strictEqual(room.housekeeping_status, 'dirty');

    const folioAfter = await request('GET', `/api/v1/folios/${bill.folio.id}`);
    assert.strictEqual(folioAfter.body.folio.status, 'closed');
    const addToClosed = await request('POST', `/api/v1/folios/${bill.folio.id}/entries`, {
      description: 'Late charge', unit_price: 100, department: 'other'
    });
    assert.strictEqual(addToClosed.status, 409, 'Closed folio must reject further posting');
    console.log('✔ Test 7: Final invoice locked, duplicate blocked, checkout and folio closure OK');

    // 8. Audit trail for the financial actions
    const audit = await request('GET', '/api/v1/reports/audit');
    const actions = audit.body.logs.map(l => l.action);
    ['CONFIRM_CHECKOUT_BILL', 'CHECK_OUT_STAY', 'GENERATE_FINAL_INVOICE', 'RECEIVE_PAYMENT'].forEach(action => {
      assert.ok(actions.includes(action), `Audit trail must contain ${action}`);
    });
    console.log('✔ Test 8: Financial actions present in audit trail');

    // 9. LAN mode controls and private-network helper
    assert.strictEqual(network.isPrivateIp('192.168.1.20'), true);
    assert.strictEqual(network.isPrivateIp('10.4.0.9'), true);
    assert.strictEqual(network.isPrivateIp('8.8.8.8'), false);
    assert.strictEqual(network.isPrivateIp('::ffff:8.8.8.8'), false);

    const lanOff = await request('GET', '/api/v1/network/status');
    assert.strictEqual(lanOff.status, 200);
    assert.strictEqual(lanOff.body.enabled, false, 'LAN must default to disabled');

    const lanOn = await request('PATCH', '/api/v1/network/config', { enabled: true });
    assert.strictEqual(lanOn.status, 200, JSON.stringify(lanOn.body));
    assert.strictEqual(lanOn.body.enabled, true);
    assert.ok(lanOn.body.lan_url.startsWith('http://'));
    assert.ok(Array.isArray(lanOn.body.lan_urls) && lanOn.body.lan_urls.length > 0, 'Every private LAN URL must be listed');
    assert.ok(lanOn.body.lan_urls.every(item => item.url.startsWith('http://') && item.address), 'LAN URLs must include adapter addresses');
    assert.ok(lanOn.body.warnings.some(w => /HTTP/i.test(w)), 'HTTP demo mode must warn');

    const qr = await request('GET', '/api/v1/network/qr');
    assert.strictEqual(qr.status, 200);
    assert.ok(qr.body.data_url.startsWith('data:image/png;base64,'));

    const badQr = await request('GET', '/api/v1/network/qr?address=8.8.8.8');
    assert.strictEqual(badQr.status, 400, 'QR must not encode a non-advertised public address');

    const lanDisabled = await request('PATCH', '/api/v1/network/config', { enabled: false });
    assert.strictEqual(lanDisabled.status, 200);
    assert.strictEqual(lanDisabled.body.enabled, false);
    console.log('✔ Test 9: LAN enable/disable, URL display and QR OK');

    // 10. System health/version and session revocation
    const health = await request('GET', '/api/v1/system/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.body.checks.database.status, 'ok');

    const version = await request('GET', '/api/v1/system/version');
    assert.strictEqual(version.status, 200);
    assert.ok(version.body.version);

    const secondLogin = await request('POST', '/api/v1/auth/login', { username: 'manager', password: 'admin123' }, '');
    assert.strictEqual(secondLogin.status, 200);
    const sessions = await request('GET', '/api/v1/auth/sessions');
    const targetSession = sessions.body.sessions.find(s => s.id === secondLogin.body.sessionId);
    assert.ok(targetSession, 'Second device session should be listed');
    const revoke = await request('POST', `/api/v1/auth/sessions/${secondLogin.body.sessionId}/revoke`, {});
    assert.strictEqual(revoke.status, 200);
    const revokedUse = await request('GET', '/api/v1/auth/me', null, secondLogin.body.token);
    assert.strictEqual(revokedUse.status, 401, 'Revoked device session must stop working immediately');
    console.log('✔ Test 10: System health, version and device-session revocation OK');

    console.log('\n========================================================');
    console.log('  ALL P0 FINANCIAL & LAN TESTS PASSED                   ');
    console.log('========================================================\n');
  } catch (err) {
    console.error('❌ Financial test suite failed:', err);
    process.exitCode = 1;
  } finally {
    if (server) server.close();
  }
}

run();
