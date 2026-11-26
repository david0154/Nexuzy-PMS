// P1 management acceptance tests: room/type CRUD, restaurant menu CRUD,
// staff user creation/deactivation, and real PDF bill generation.
// Uses an isolated database and never touches the hotel's live data.

const path = require('path');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'test-management.db');

const assert = require('assert');
const http = require('http');
const app = require('../server/app');
const runSeed = require('../server/db/seed');
const { generateInvoicePdf } = require('../server/services/pdf');

let server;
let baseUrl;
let token = '';
let frontDeskToken = '';

function request(method, urlPath, body = null, bearer = token) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const headers = { 'Content-Type': 'application/json' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const contentType = res.headers['content-type'] || '';
        if (contentType.includes('application/pdf')) {
          resolve({ status: res.statusCode, pdf: buffer, contentType });
          return;
        }
        const data = buffer.toString('utf8');
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
  console.log('  Nexuzy PMS — Management & PDF Acceptance Tests       ');
  console.log('========================================================\n');

  await runSeed({ force: true });
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const login = await request('POST', '/api/v1/auth/login', { username: 'admin', password: 'admin123' }, '');
    assert.strictEqual(login.status, 200, 'Admin login should succeed');
    token = login.body.token;

    // Room types and rooms
    const roomType = await request('POST', '/api/v1/rooms/types', {
      name: 'Test Deluxe', code: 'TDLX', base_rate: 3200, max_occupancy: 3, tax_rate: 12
    });
    assert.strictEqual(roomType.status, 201, 'Room type should be created');
    assert.ok(roomType.body.id);

    const duplicateType = await request('POST', '/api/v1/rooms/types', {
      name: 'Test Deluxe', code: 'TDLX2', base_rate: 3000
    });
    assert.strictEqual(duplicateType.status, 409, 'Duplicate room type name should be rejected');

    const room = await request('POST', '/api/v1/rooms', {
      room_number: 'T-901', room_type_id: roomType.body.id, floor: 'Test Floor', building: 'Test Wing'
    });
    assert.strictEqual(room.status, 201, 'Room should be created');
    assert.ok(room.body.id);

    const duplicateRoom = await request('POST', '/api/v1/rooms', {
      room_number: 'T-901', room_type_id: roomType.body.id
    });
    assert.strictEqual(duplicateRoom.status, 409, 'Duplicate room number should be rejected');

    const updatedRoom = await request('PATCH', `/api/v1/rooms/${room.body.id}`, {
      room_number: 'T-902', floor: 'Second Test Floor', features: 'Balcony'
    });
    assert.strictEqual(updatedRoom.status, 200, 'Room should update');
    const rooms = await request('GET', '/api/v1/rooms');
    const savedRoom = rooms.body.rooms.find(r => r.id === room.body.id);
    assert.strictEqual(savedRoom.room_number, 'T-902');
    assert.strictEqual(savedRoom.features, 'Balcony');

    const blockedTypeDelete = await request('DELETE', `/api/v1/rooms/types/${roomType.body.id}`);
    assert.strictEqual(blockedTypeDelete.status, 409, 'A room type in use must not be deleted');

    // Menu categories and items
    const category = await request('POST', '/api/v1/restaurant/menu/categories', { name: 'Test Starters' });
    assert.strictEqual(category.status, 201, 'Menu category should be created');

    const item = await request('POST', '/api/v1/restaurant/menu/items', {
      category_id: category.body.id,
      name: 'Test Paneer Tikka',
      price: 280,
      tax_rate: 5,
      station: 'kitchen',
      is_veg: true
    });
    assert.strictEqual(item.status, 201, 'Menu item should be created');

    const duplicateItem = await request('POST', '/api/v1/restaurant/menu/items', {
      category_id: category.body.id,
      name: 'Test Paneer Tikka',
      price: 300
    });
    assert.strictEqual(duplicateItem.status, 409, 'Duplicate menu item should be rejected');

    const updatedItem = await request('PATCH', `/api/v1/restaurant/menu/items/${item.body.id}`, {
      price: 310, is_available: false
    });
    assert.strictEqual(updatedItem.status, 200, 'Menu item should update');

    const posMenu = await request('GET', '/api/v1/restaurant/menu');
    assert.ok(!posMenu.body.items.some(i => i.id === item.body.id), 'Unavailable item must disappear from POS menu');

    const manageMenu = await request('GET', '/api/v1/restaurant/menu/manage');
    const managedItem = manageMenu.body.items.find(i => i.id === item.body.id);
    assert.strictEqual(Number(managedItem.price), 310);
    assert.strictEqual(Number(managedItem.is_available), 0);

    // Restaurant bill JSON and PDF for a settled separate bill
    const availableMenu = await request('GET', '/api/v1/restaurant/menu');
    const sellable = availableMenu.body.items[0];
    const restaurantOrder = await request('POST', '/api/v1/restaurant/orders', {
      order_type: 'takeaway',
      items: [{ menu_item_id: sellable.id, quantity: 1 }]
    });
    assert.strictEqual(restaurantOrder.status, 200, 'Restaurant order should be created');
    const settled = await request('POST', `/api/v1/restaurant/orders/${restaurantOrder.body.orderId}/settle`, {
      payment_method: 'cash'
    });
    assert.strictEqual(settled.status, 200, 'Restaurant order should settle');
    assert.ok(settled.body.orderId, 'Settle response must include the order id for receipts');
    const billJson = await request('GET', `/api/v1/restaurant/orders/${settled.body.orderId}/bill`);
    assert.strictEqual(billJson.status, 200, 'Restaurant bill JSON should load');
    assert.ok(billJson.body.bill.id, 'Restaurant bill must include its order id');
    const billPdf = await request('GET', `/api/v1/restaurant/orders/${settled.body.orderId}/bill/pdf`);
    assert.strictEqual(billPdf.status, 200, 'Restaurant bill PDF should download');
    assert.strictEqual(billPdf.pdf.slice(0, 5).toString(), '%PDF-', 'Restaurant bill must be a PDF');

    // Staff users
    const createdUser = await request('POST', '/api/v1/auth/users', {
      username: 'test.frontdesk',
      password: 'FrontDesk#123',
      full_name: 'Test Front Desk',
      email: 'frontdesk@example.com',
      role: 'front_desk'
    });
    assert.strictEqual(createdUser.status, 201, 'Staff user should be created');

    const weakPassword = await request('POST', '/api/v1/auth/users', {
      username: 'test.weak', password: '123', full_name: 'Weak User', role: 'waiter'
    });
    assert.strictEqual(weakPassword.status, 400, 'Weak passwords must be rejected');

    const frontDeskLogin = await request('POST', '/api/v1/auth/login', {
      username: 'test.frontdesk', password: 'FrontDesk#123'
    }, '');
    assert.strictEqual(frontDeskLogin.status, 200, 'New staff login should work');
    frontDeskToken = frontDeskLogin.body.token;

    const forbiddenRoomCreate = await request('POST', '/api/v1/rooms', {
      room_number: 'T-903', room_type_id: roomType.body.id
    }, frontDeskToken);
    assert.strictEqual(forbiddenRoomCreate.status, 403, 'Front desk must not manage rooms');

    const forbiddenUserList = await request('GET', '/api/v1/auth/users', null, frontDeskToken);
    assert.strictEqual(forbiddenUserList.status, 403, 'Front desk must not manage users');

    const deactivate = await request('PATCH', `/api/v1/auth/users/${createdUser.body.userId}`, {
      role: 'front_desk', is_active: false
    });
    assert.strictEqual(deactivate.status, 200, 'User should deactivate');

    const blockedLogin = await request('POST', '/api/v1/auth/login', {
      username: 'test.frontdesk', password: 'FrontDesk#123'
    }, '');
    assert.strictEqual(blockedLogin.status, 401, 'Inactive user must not sign in');

    // Real PDF output through the authenticated HTTP route
    const inHouse = await request('GET', '/api/v1/stays/in-house');
    const liveStay = (inHouse.body.stays || [])[0];
    assert.ok(liveStay, 'Seeded in-house stay should exist for invoice PDF test');
    const confirmed = await request('POST', `/api/v1/stays/${liveStay.id}/checkout-preview/confirm`, {});
    assert.strictEqual(confirmed.status, 200, 'Checkout bill should confirm');
    const invoice = await request('POST', `/api/v1/stays/${liveStay.id}/invoice`, {});
    assert.strictEqual(invoice.status, 200, 'Final invoice should generate');
    const invoicePdf = await request('GET', `/api/v1/folios/${liveStay.folio_id}/invoice/pdf`);
    assert.strictEqual(invoicePdf.status, 200, 'Invoice PDF endpoint should return a document');
    assert.strictEqual(invoicePdf.pdf.slice(0, 5).toString(), '%PDF-', 'Invoice endpoint must return a PDF');

    // Real PDF output from the document service
    const pdf = await generateInvoicePdf({
      invoice_number: 'INV-TEST-PDF',
      date: '2026-11-10',
      is_tax_invoice: true,
      property: { name: 'Test Hotel', address: '1 Test Road', city: 'Pune', state: 'MH', gstin: '27AAAAA0000A1Z5' },
      customer: { name: 'Test Guest' },
      items: [{ description: 'Room charge', department: 'room_rent', quantity: 1, unit_price: 1000, tax_rate: 12, tax_amount: 120, total_amount: 1120 }],
      subtotal: 1000, cgst: 60, sgst: 60, total_tax: 120, grand_total: 1120, paid_amount: 0, balance_due: 1120
    });
    assert.ok(Buffer.isBuffer(pdf) && pdf.length > 1000, 'PDF should contain real document bytes');
    assert.strictEqual(pdf.slice(0, 5).toString(), '%PDF-', 'PDF must start with a PDF header');

    // Safe cleanup of room catalog rows created by this test.
    const roomDelete = await request('DELETE', `/api/v1/rooms/${room.body.id}`);
    assert.strictEqual(roomDelete.status, 200, 'Unreferenced room should delete');
    const typeDelete = await request('DELETE', `/api/v1/rooms/types/${roomType.body.id}`);
    assert.strictEqual(typeDelete.status, 200, 'Unreferenced room type should delete');

    console.log('\n✔ 8 management/PDF test groups passed');
    console.log('  Room and room-type CRUD, duplicate guards, menu CRUD, POS visibility,');
    console.log('  staff creation, role enforcement, deactivation and PDF generation.\n');
  } catch (err) {
    console.error('\n✗ Management test failed:', err.message);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  } finally {
    if (server) server.close();
  }
}

run();
