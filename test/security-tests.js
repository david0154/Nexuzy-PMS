// Nexuzy PMS — property isolation, inventory, tax/rounding and room QR/guest tests.
// Runs against an isolated database so it never touches hotel data.

const path = require('path');
process.env.NODE_ENV = 'test';
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'test-security.db');

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

function request(method, urlPath, body = null, bearer = adminToken, extraHeaders = {}) {
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

async function login(username, password) {
  const res = await request('POST', '/api/v1/auth/login', { username, password }, '');
  assert.strictEqual(res.status, 200, `Login for ${username} should succeed: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

async function ensureBetaProperty() {
  const propId = 'prop-beta-01';
  await db.run(
    `INSERT INTO properties (id, name, code, city, state, business_date, default_room_tax_rate, default_restaurant_tax_rate)
     VALUES (?, 'Beta Riverside Hotel', 'BETA-01', 'Pune', 'Maharashtra', '2026-11-10', 12, 5)`,
    [propId]
  );
  await db.run(
    `INSERT INTO users (id, property_id, username, password_hash, full_name, role)
     VALUES (?, ?, 'betaadmin', ?, 'Beta Administrator', 'admin')`,
    [uuidv4(), propId, await bcrypt.hash('beta123', 10)]
  );
  await db.run(
    `INSERT INTO room_types (id, property_id, name, code, base_rate, max_occupancy, tax_rate)
     VALUES ('rt-beta-std', ?, 'Beta Standard', 'BSTD', 1500, 3, 12)`,
    [propId]
  );
  await db.run(
    `INSERT INTO rooms (id, property_id, room_number, room_type_id, floor, building, operational_status, housekeeping_status)
     VALUES ('beta-room-1', ?, 'B-101', 'rt-beta-std', '1', 'Beta Wing', 'available', 'clean')`,
    [propId]
  );
  await db.run(
    `INSERT INTO menu_categories (id, property_id, name, display_order) VALUES ('cat-beta', ?, 'Beta Menu', 1)`,
    [propId]
  );
  await db.run(
    `INSERT INTO menu_items (id, property_id, category_id, name, code, price, station, tax_rate, is_available, is_veg)
     VALUES ('beta-item-1', ?, 'cat-beta', 'Beta Special Thali', 'BETA-1', 250, 'kitchen', 5, 1, 1)`,
    [propId]
  );
}

async function main() {
  console.log('========================================================');
  console.log('  Nexuzy PMS — Security, Inventory, Tax & QR Tests      ');
  console.log('========================================================\n');

  await runSeed({ force: true });
  await ensureBetaProperty();

  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    adminToken = await login('admin', 'admin123');
    betaToken = await login('betaadmin', 'beta123');

    // ---------------------------------------------------------
    // Property isolation
    // ---------------------------------------------------------
    const betaSettings = await request('GET', '/api/v1/settings', null, betaToken);
    assert.strictEqual(betaSettings.status, 200);
    assert.strictEqual(betaSettings.body.property.name, 'Beta Riverside Hotel');
    assert.strictEqual(betaSettings.body.property.id, 'prop-beta-01');

    await request('PATCH', '/api/v1/settings/property', { name: 'Beta Renamed Hotel' }, betaToken);
    const alphaSettings = await request('GET', '/api/v1/settings', null, adminToken);
    assert.strictEqual(alphaSettings.body.property.name, 'Grand Nexuzy Hotel & Suites', 'Beta admin must not change the Alpha property');
    console.log('✔ Settings are property-scoped (no LIMIT 1 leak)');

    const betaRooms = await request('GET', '/api/v1/rooms', null, betaToken);
    assert.strictEqual(betaRooms.status, 200);
    assert.ok(betaRooms.body.rooms.every(room => room.property_id === 'prop-beta-01'), 'Beta must only see Beta rooms');

    const betaFolio = await request('GET', '/api/v1/folios/folio-101', null, betaToken);
    assert.strictEqual(betaFolio.status, 404, 'Cross-property folio must be hidden');
    console.log('✔ Rooms and folios are isolated by property');

    const betaOrder = await request('POST', '/api/v1/restaurant/orders', {
      order_type: 'dine_in',
      items: [{ menu_item_id: 'item-1', quantity: 1 }]
    }, betaToken);
    assert.strictEqual(betaOrder.status, 400, 'Cross-property menu item must be rejected');
    console.log('✔ Restaurant menu ownership is enforced');

    const createdReservation = await request('POST', '/api/v1/reservations', {
      guest_data: { first_name: 'Isolation', phone: '+91 90000 55555' },
      check_in_date: '2027-01-10',
      check_out_date: '2027-01-12',
      room_type_id: 'rt-std-deluxe',
      rate_per_night: 2000
    });
    assert.strictEqual(createdReservation.status, 200, JSON.stringify(createdReservation.body));
    const betaCheckIn = await request('POST', '/api/v1/stays/check-in-reservation', {
      reservation_id: createdReservation.body.reservationId,
      assigned_room_id: 'beta-room-1'
    }, betaToken);
    assert.strictEqual(betaCheckIn.status, 404, 'Cross-property reservation check-in must fail');
    console.log('✔ Cross-property reservation check-in is rejected');

    // ---------------------------------------------------------
    // Inventory
    // ---------------------------------------------------------
    const betaInventory = await request('GET', '/api/v1/inventory/items', null, betaToken);
    assert.strictEqual(betaInventory.status, 200);
    assert.ok(betaInventory.body.items.every(item => item.property_id === 'prop-beta-01'));

    const crossMovement = await request('POST', '/api/v1/inventory/movements', {
      stock_item_id: 'stk-1', movement_type: 'purchase', quantity: 5
    }, betaToken);
    assert.strictEqual(crossMovement.status, 404, 'Cross-property stock item must not be found');

    const invalidType = await request('POST', '/api/v1/inventory/movements', {
      stock_item_id: 'stk-1', movement_type: 'teleport', quantity: 5
    });
    assert.strictEqual(invalidType.status, 400);

    const negativeQty = await request('POST', '/api/v1/inventory/movements', {
      stock_item_id: 'stk-1', movement_type: 'purchase', quantity: -5
    });
    assert.strictEqual(negativeQty.status, 400);

    const insufficient = await request('POST', '/api/v1/inventory/movements', {
      stock_item_id: 'stk-1', movement_type: 'issue', quantity: 999999
    });
    assert.strictEqual(insufficient.status, 400);

    const duplicateItem = await request('POST', '/api/v1/inventory/items', {
      name: 'premium basmati rice', category: 'kitchen_ingredients', unit: 'kg'
    });
    assert.strictEqual(duplicateItem.status, 409, 'Case-insensitive duplicate stock item must be rejected');
    console.log('✔ Inventory rejects wrong property, invalid type, negative quantity, insufficient stock and duplicates');

    const before = await db.get("SELECT current_stock FROM stock_items WHERE id = 'stk-2'");
    const purchase = await request('POST', '/api/v1/inventory/movements', {
      stock_item_id: 'stk-2', movement_type: 'receipt', quantity: 10, unit_cost: 330, reference: 'GRN-TEST'
    });
    assert.strictEqual(purchase.status, 200, JSON.stringify(purchase.body));
    assert.strictEqual(Number(purchase.body.newStock), Number(before.current_stock) + 10, 'Receipt must increase stock');

    const issue = await request('POST', '/api/v1/inventory/movements', {
      stock_item_id: 'stk-2', movement_type: 'issue', quantity: 4, reason: 'Kitchen requisition'
    });
    assert.strictEqual(issue.status, 200);
    assert.strictEqual(Number(issue.body.newStock), Number(before.current_stock) + 6);

    const wastage = await request('POST', '/api/v1/inventory/movements', {
      stock_item_id: 'stk-2', movement_type: 'wastage', quantity: 1, reason: 'Spoiled'
    });
    assert.strictEqual(wastage.status, 200);

    const returned = await request('POST', '/api/v1/inventory/movements', {
      stock_item_id: 'stk-2', movement_type: 'return', quantity: 2
    });
    assert.strictEqual(returned.status, 200);

    const adjustment = await request('POST', '/api/v1/inventory/movements', {
      stock_item_id: 'stk-2', movement_type: 'adjustment', quantity: 1, direction: 'decrease', reason: 'Stock count'
    });
    assert.strictEqual(adjustment.status, 200);

    const missingDirection = await request('POST', '/api/v1/inventory/movements', {
      stock_item_id: 'stk-2', movement_type: 'adjustment', quantity: 1, reason: 'No direction'
    });
    assert.strictEqual(missingDirection.status, 400, 'Adjustment without direction must not increase stock');

    const transferOut = await request('POST', '/api/v1/inventory/movements', {
      stock_item_id: 'stk-2', movement_type: 'transfer_out', quantity: 1, reason: 'To bar store'
    });
    assert.strictEqual(transferOut.status, 200);
    const transferIn = await request('POST', '/api/v1/inventory/movements', {
      stock_item_id: 'stk-2', movement_type: 'transfer_in', quantity: 1, reason: 'From kitchen store'
    });
    assert.strictEqual(transferIn.status, 200);

    const ledger = await request('GET', '/api/v1/inventory/items/stk-2/movements');
    assert.strictEqual(ledger.status, 200);
    assert.ok(ledger.body.movements.length >= 7, 'Every movement must be in the permanent ledger');
    assert.ok(ledger.body.movements.every(m => m.previous_stock !== null && m.new_stock !== null), 'Ledger rows must keep before/after balances');

    // Concurrent receipts must both be recorded without losing stock.
    const concurrentBefore = await db.get("SELECT current_stock FROM stock_items WHERE id = 'stk-3'");
    const [c1, c2] = await Promise.all([
      request('POST', '/api/v1/inventory/movements', { stock_item_id: 'stk-3', movement_type: 'purchase', quantity: 5 }),
      request('POST', '/api/v1/inventory/movements', { stock_item_id: 'stk-3', movement_type: 'purchase', quantity: 7 })
    ]);
    assert.strictEqual(c1.status, 200, JSON.stringify(c1.body));
    assert.strictEqual(c2.status, 200, JSON.stringify(c2.body));
    const concurrentAfter = await db.get("SELECT current_stock FROM stock_items WHERE id = 'stk-3'");
    assert.strictEqual(Number(concurrentAfter.current_stock), Number(concurrentBefore.current_stock) + 12, 'Concurrent movements must not lose updates');
    console.log('✔ All movement types, ledger history and concurrent stock updates are correct');

    // ---------------------------------------------------------
    // Tax configuration, local tax, rounding and combined checkout
    // ---------------------------------------------------------
    await request('PATCH', '/api/v1/settings/property', {
      lan_guest_url: `http://127.0.0.1:${server.address().port}`,
      local_tax_enabled: true,
      local_tax_name: 'City Tax',
      local_tax_amount: 100,
      local_tax_max_guests: 0,
      rounding_enabled: true,
      guest_portal_enabled: true,
      room_qr_enabled: true,
      guest_order_enabled: true,
      guest_bill_enabled: true,
      guest_service_enabled: true,
      guest_help_enabled: true,
      reception_contact: '+91 80 4912 3456',
      emergency_contact: '+91 98765 00000',
      wifi_instructions: 'Connect to NEXUZY-GUEST Wi-Fi before scanning.'
    });

    // Local tax: 2 guests x 3 nights x 100 = 600, charged once per guest-night.
    const localStay = await request('POST', '/api/v1/stays/walk-in', {
      first_name: 'LocalTax', phone: '+91 90000 77771', room_id: 'room-103',
      nights: 3, rate_per_night: 1000, adults: 2
    });
    assert.strictEqual(localStay.status, 200, JSON.stringify(localStay.body));
    const localFolio = await db.get('SELECT * FROM folios WHERE stay_id = ?', [localStay.body.stayId]);
    const localEntries = await db.all("SELECT * FROM folio_entries WHERE folio_id = ? AND department = 'local_tax'", [localFolio.id]);
    assert.strictEqual(localEntries.length, 3, 'One local tax entry per guest-night');
    assert.strictEqual(localEntries.reduce((sum, e) => sum + Number(e.total_amount), 0), 600);

    const localPreview = await request('GET', `/api/v1/stays/${localStay.body.stayId}/checkout-preview`);
    assert.strictEqual(localPreview.status, 200);
    assert.strictEqual(Number(localPreview.body.preview.totals.local_tax), 600);

    const localKey = `checkout-local-${Date.now()}`;
    const localCheckout = await request('POST', `/api/v1/stays/${localStay.body.stayId}/checkout-payment`, {
      payment_method: 'upi'
    }, adminToken, { 'Idempotency-Key': localKey });
    assert.strictEqual(localCheckout.status, 200, JSON.stringify(localCheckout.body));
    assert.ok(localCheckout.body.invoice, 'Combined checkout must issue an invoice');
    assert.ok(localCheckout.body.invoice.folio_id, 'Invoice response must include folio_id so the final-bill PDF button can work');
    assert.ok(localCheckout.body.payment && localCheckout.body.payment.receipt_number, 'Combined checkout must issue a receipt');

    const localReplay = await request('POST', `/api/v1/stays/${localStay.body.stayId}/checkout-payment`, {
      payment_method: 'upi'
    }, adminToken, { 'Idempotency-Key': localKey });
    assert.strictEqual(localReplay.status, 200);
    assert.strictEqual(localReplay.body.duplicate, true, 'A retried checkout must not post a second payment');
    const localTaxAfter = await db.all("SELECT * FROM folio_entries WHERE folio_id = ? AND department = 'local_tax'", [localFolio.id]);
    assert.strictEqual(localTaxAfter.length, 3, 'Retry must not duplicate local tax');
    console.log('✔ Local tax is charged exactly once per guest-night and checkout retries are idempotent');

    // Rounding: 1250.52 extra charge on a walk-in stay must round to the nearest rupee.
    const roundStay = await request('POST', '/api/v1/stays/walk-in', {
      first_name: 'Rounding', phone: '+91 90000 77772', room_id: 'room-104',
      nights: 1, rate_per_night: 1000, adults: 1
    });
    assert.strictEqual(roundStay.status, 200, JSON.stringify(roundStay.body));
    const roundFolio = await db.get('SELECT * FROM folios WHERE stay_id = ?', [roundStay.body.stayId]);
    await request('POST', `/api/v1/folios/${roundFolio.id}/entries`, {
      description: 'Laundry', quantity: 1, unit_price: 1250.52, tax_rate: 0, department: 'laundry'
    });
    const roundPreview = await request('GET', `/api/v1/stays/${roundStay.body.stayId}/checkout-preview`);
    const previewBalance = Number(roundPreview.body.preview.totals.balance_due);
    assert.ok(previewBalance > 0);
    const expectedRounded = Math.round(previewBalance);
    const roundCheckout = await request('POST', `/api/v1/stays/${roundStay.body.stayId}/checkout-payment`, {
      payment_method: 'cash'
    }, adminToken, { 'Idempotency-Key': `checkout-round-${Date.now()}` });
    assert.strictEqual(roundCheckout.status, 200, JSON.stringify(roundCheckout.body));
    assert.strictEqual(Number(roundCheckout.body.amount_collected), expectedRounded, 'Rounded payable must be the nearest whole rupee');
    assert.ok(Math.abs(Number(roundCheckout.body.rounding.adjustment) - (expectedRounded - previewBalance)) < 0.011);
    const roundingEntries = await db.all("SELECT * FROM folio_entries WHERE folio_id = ? AND department = 'rounding'", [roundFolio.id]);
    assert.strictEqual(roundingEntries.length, 1, 'Rounding adjustment must be a single ledger line');
    console.log('✔ Rounding is applied transparently and recorded in the ledger');

    // ---------------------------------------------------------
    // Room QR and guest workflow
    // ---------------------------------------------------------
    const generate = await request('POST', '/api/v1/room-qr/generate-all', {}, adminToken);
    assert.strictEqual(generate.status, 200, JSON.stringify(generate.body));
    assert.ok(generate.body.created.length >= 8, 'All rooms should receive a QR');

    const qr101 = await db.get("SELECT * FROM room_qr_codes WHERE room_id = 'room-101'");
    const qr102 = await db.get("SELECT * FROM room_qr_codes WHERE room_id = 'room-102'");
    assert.ok(qr101 && qr102);

    await request('PATCH', '/api/v1/room-qr/room-102', { is_active: false });
    const disabledResolve = await request('POST', '/api/v1/guest-room/resolve', { qr_token: qr102.qr_token }, '');
    assert.strictEqual(disabledResolve.status, 403, 'Disabled room QR must be rejected');
    await request('PATCH', '/api/v1/room-qr/room-102', { is_active: true });
    console.log('✔ QR generation, disable/enable and disabled-QR rejection work');

    const resolve = await request('POST', '/api/v1/guest-room/resolve', { qr_token: qr101.qr_token }, '');
    assert.strictEqual(resolve.status, 200, JSON.stringify(resolve.body));
    assert.strictEqual(resolve.body.room.number, '101');
    assert.ok(resolve.body.session_token);
    const guestSession = resolve.body.session_token;
    const guestHeaders = { 'X-Guest-Session': guestSession };

    const guestMenu = await request('GET', '/api/v1/guest-room/menu', null, '', guestHeaders);
    assert.strictEqual(guestMenu.status, 200);
    assert.strictEqual(guestMenu.body.restaurant_tax_enabled, false, 'Restaurant GST must be disabled by default');

    const guestOrderKey = `guest-order-${Date.now()}`;
    const guestOrder = await request('POST', '/api/v1/guest-room/orders', {
      items: [{ menu_item_id: 'item-9', quantity: 2, notes: 'Extra garlic' }],
      idempotency_key: guestOrderKey
    }, '', guestHeaders);
    assert.strictEqual(guestOrder.status, 200, JSON.stringify(guestOrder.body));
    assert.strictEqual(Number(guestOrder.body.order.tax_amount), 0, 'Disabled restaurant GST must post zero tax');
    assert.strictEqual(Number(guestOrder.body.order.total_amount), 150);
    assert.ok(guestOrder.body.order.kot_numbers.length > 0, 'Guest order must generate a KOT');

    const guestOrderReplay = await request('POST', '/api/v1/guest-room/orders', {
      items: [{ menu_item_id: 'item-9', quantity: 2 }],
      idempotency_key: guestOrderKey
    }, '', guestHeaders);
    assert.strictEqual(guestOrderReplay.status, 200);
    assert.strictEqual(guestOrderReplay.body.duplicate, true, 'Guest order retries must not duplicate the order');

    const folioCharges = await db.all(
      "SELECT * FROM folio_entries WHERE folio_id = 'folio-101' AND reference_type = 'restaurant_order'"
    );
    assert.strictEqual(folioCharges.length, 1, 'Guest order must post to the folio exactly once');
    const kotCount = await db.get(
      'SELECT COUNT(*) AS count FROM kitchen_tickets WHERE order_id = ?',
      [guestOrder.body.order.id]
    );
    assert.strictEqual(Number(kotCount.count), 1, 'Only one KOT should be generated');
    console.log('✔ Guest order posts exactly once, generates one KOT and zero restaurant GST while disabled');

    await request('PATCH', '/api/v1/settings/property', {
      restaurant_tax_enabled: true, default_restaurant_tax_rate: 5
    });
    const taxedOrder = await request('POST', '/api/v1/guest-room/orders', {
      items: [{ menu_item_id: 'item-10', quantity: 1 }],
      idempotency_key: `guest-order-taxed-${Date.now()}`
    }, '', guestHeaders);
    assert.strictEqual(taxedOrder.status, 200, JSON.stringify(taxedOrder.body));
    assert.strictEqual(Number(taxedOrder.body.order.tax_amount), 6, 'Enabled restaurant GST must be calculated on the server');
    assert.strictEqual(Number(taxedOrder.body.order.total_amount), 126);

    const guestOrders = await request('GET', '/api/v1/guest-room/orders', null, '', guestHeaders);
    assert.strictEqual(guestOrders.status, 200);
    assert.ok(guestOrders.body.orders.length >= 2);
    assert.ok(guestOrders.body.orders[0].tickets.length >= 1, 'Guest must see KOT progress');

    const billBefore = await request('GET', '/api/v1/guest-room/bill', null, '', guestHeaders);
    assert.strictEqual(billBefore.status, 200);
    assert.ok(Number(billBefore.body.summary.restaurant_charges) >= 276, 'Restaurant charges must appear on the guest bill');

    const guestRequest = await request('POST', '/api/v1/guest-room/requests', {
      category: 'housekeeping', description: 'Please clean the bathroom'
    }, '', guestHeaders);
    assert.strictEqual(guestRequest.status, 201, JSON.stringify(guestRequest.body));
    const staffRequests = await request('GET', '/api/v1/guest-requests?status=pending');
    assert.strictEqual(staffRequests.status, 200);
    assert.ok(staffRequests.body.requests.some(r => r.id === guestRequest.body.request.id));
    const completeRequest = await request('PATCH', `/api/v1/guest-requests/${guestRequest.body.request.id}`, {
      status: 'completed', resolution_notes: 'Cleaned and inspected'
    });
    assert.strictEqual(completeRequest.status, 200, JSON.stringify(completeRequest.body));
    console.log('✔ Guest requests reach staff and can be completed');

    // Checkout Room 101 and revoke the old guest session.
    const checkout = await request('POST', '/api/v1/stays/stay-ind-101/checkout-payment', {
      payment_method: 'card'
    }, adminToken, { 'Idempotency-Key': `checkout-101-${Date.now()}` });
    assert.strictEqual(checkout.status, 200, JSON.stringify(checkout.body));
    assert.ok(checkout.body.invoice && checkout.body.invoice.invoice_number);
    assert.ok(checkout.body.totals.local_tax >= 300, 'Checkout must include local tax for the seeded stay');
    assert.ok(Number(checkout.body.amount_collected) > 0);

    const oldSessionBill = await request('GET', '/api/v1/guest-room/bill', null, '', guestHeaders);
    assert.ok([401, 403].includes(oldSessionBill.status), 'Old guest session must stop working after checkout');
    const qrStillActive = await db.get("SELECT is_active FROM room_qr_codes WHERE room_id = 'room-101'");
    assert.strictEqual(Number(qrStillActive.is_active), 1, 'Permanent room QR must remain active after checkout');
    console.log('✔ Combined checkout issues invoice/receipt, includes local tax and revokes the guest session');

    // New guest in the same room gets a fresh session and sees no previous charges.
    const newStay = await request('POST', '/api/v1/stays/walk-in', {
      first_name: 'NextGuest', phone: '+91 90000 77779', room_id: 'room-101',
      nights: 1, rate_per_night: 2000, adults: 1
    });
    assert.strictEqual(newStay.status, 200, JSON.stringify(newStay.body));
    const newResolve = await request('POST', '/api/v1/guest-room/resolve', { qr_token: qr101.qr_token }, '');
    assert.strictEqual(newResolve.status, 200, 'Permanent QR must work for the next guest');
    assert.notStrictEqual(newResolve.body.session_token, guestSession);
    const newBill = await request('GET', '/api/v1/guest-room/bill', null, '', { 'X-Guest-Session': newResolve.body.session_token });
    assert.strictEqual(newBill.status, 200);
    assert.strictEqual(Number(newBill.body.summary.restaurant_charges), 0, 'New guest must not see the previous guest restaurant bill');
    assert.ok(Number(newBill.body.summary.total_charges) < 5000, 'New guest bill must not include previous stay charges');
    const oldTokenRetry = await request('GET', '/api/v1/guest-room/bill', null, '', guestHeaders);
    assert.ok([401, 403].includes(oldTokenRetry.status));
    console.log('✔ Next guest in the same room gets a fresh session and cannot see the old guest bill');

    console.log('\n========================================================');
    console.log('  ALL SECURITY, INVENTORY, TAX & ROOM QR TESTS PASSED   ');
    console.log('========================================================');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

main()
  .then(async () => {
    await db.close();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n✘ TEST FAILURE:', err.message);
    console.error(err.stack);
    try { await db.close(); } catch (closeErr) { /* ignore */ }
    process.exit(1);
  });
