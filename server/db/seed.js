const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { applyMigrations } = require('../config/migrations');

async function runSeed(options = {}) {
  const force = options.force || false;
  console.log('--- Initializing Nexuzy PMS Database & Seeding Initial Data ---');

  if (force) {
    await db.exec('PRAGMA foreign_keys = OFF;');
    const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    for (const t of tables) {
      await db.exec(`DROP TABLE IF EXISTS "${t.name}"`);
    }
    await db.exec('PRAGMA foreign_keys = ON;');
    console.log('✓ Cleared previous database tables for clean re-seed');
  }

  // 1. Read and execute schema
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  await db.exec(schemaSql);
  await applyMigrations();
  console.log('✓ Database schema executed successfully');

  // Check if property exists
  if (!force) {
    const existingProp = await db.get("SELECT id FROM properties WHERE code = 'NEX-01'");
    if (existingProp) {
      console.log('Database already seeded. Skipping initial seeding.');
      return;
    }
  }

  const propId = 'prop-nexuzy-01';
  const defaultBusinessDate = '2026-11-10';

  // 2. Insert Property
  await db.run(
    `INSERT INTO properties (id, name, code, gstin, address, city, state, country, phone, email, currency, currency_symbol, timezone, business_date, checkin_time, checkout_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      propId,
      'Grand Nexuzy Hotel & Suites',
      'NEX-01',
      '29AABCN1234F1Z5',
      'Plot 42, 100 Feet Road, Indiranagar',
      'Bengaluru',
      'Karnataka',
      'India',
      '+91 80 4912 3456',
      'contact@nexuzy.in',
      'INR',
      '₹',
      'Asia/Kolkata',
      defaultBusinessDate,
      '14:00',
      '11:00'
    ]
  );
  console.log('✓ Property created: Grand Nexuzy Hotel & Suites');

  // 3. Insert Users
  const passwordHash = await bcrypt.hash('admin123', 10);
  const users = [
    { id: 'usr-admin', username: 'admin', full_name: 'David Administrator', role: 'admin', email: 'david@nexuzy.in' },
    { id: 'usr-gm', username: 'manager', full_name: 'Priya Sharma (GM)', role: 'general_manager', email: 'priya@nexuzy.in' },
    { id: 'usr-frontdesk', username: 'reception', full_name: 'Rahul Verma (Front Desk)', role: 'front_desk', email: 'rahul@nexuzy.in' },
    { id: 'usr-cashier', username: 'cashier', full_name: 'Sneha Patel (Cashier)', role: 'cashier', email: 'sneha@nexuzy.in' },
    { id: 'usr-captain', username: 'captain', full_name: 'Vikram Roy (Captain)', role: 'captain', email: 'vikram@nexuzy.in' },
    { id: 'usr-waiter', username: 'waiter', full_name: 'Karan Singh (Waiter)', role: 'waiter', email: 'karan@nexuzy.in' },
    { id: 'usr-kitchen', username: 'chef', full_name: 'Chef Sanjeev (Head Chef)', role: 'kitchen', email: 'kitchen@nexuzy.in' },
    { id: 'usr-hk', username: 'housekeeping', full_name: 'Sunita Bai (Housekeeping)', role: 'housekeeping', email: 'hk@nexuzy.in' },
    { id: 'usr-maint', username: 'maintenance', full_name: 'Ramesh Kumar (Technician)', role: 'maintenance', email: 'tech@nexuzy.in' },
    { id: 'usr-inventory', username: 'store', full_name: 'Anil Gupta (Storekeeper)', role: 'inventory', email: 'store@nexuzy.in' }
  ];

  for (const u of users) {
    await db.run(
      `INSERT INTO users (id, property_id, username, password_hash, full_name, email, role, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [u.id, propId, u.username, passwordHash, u.full_name, u.email, u.role]
    );
  }
  console.log(`✓ Seeded ${users.length} staff users (default password: admin123)`);

  // 4. Insert Room Types
  const roomTypes = [
    {
      id: 'rt-std-deluxe',
      name: 'Deluxe Queen Room',
      code: 'DLX-Q',
      base_rate: 2800,
      max_occupancy: 2,
      extra_adult_rate: 600,
      tax_rate: 12.0,
      hsn_sac: '996311',
      amenities: 'Queen Bed, AC, Wi-Fi, Smart TV, Tea/Coffee maker, Work Desk',
      description: 'Comfortable premium room with modern fixtures and high-speed Wi-Fi.'
    },
    {
      id: 'rt-exec-suite',
      name: 'Executive King Suite',
      code: 'EXE-K',
      base_rate: 4500,
      max_occupancy: 3,
      extra_adult_rate: 800,
      tax_rate: 12.0,
      hsn_sac: '996311',
      amenities: 'King Bed, Living Area, Bathtub, Minibar, Balcony, Coffee Machine',
      description: 'Spacious suite designed for business executives and family comfort.'
    },
    {
      id: 'rt-pres-villa',
      name: 'Presidential Penthouse',
      code: 'PRS-P',
      base_rate: 9000,
      max_occupancy: 4,
      extra_adult_rate: 1200,
      tax_rate: 18.0,
      hsn_sac: '996311',
      amenities: 'Panoramic View, Jacuzzi, Private Lounge, Butler Service, 2 King Beds',
      description: 'Luxury top-floor penthouse with complete hospitality privileges.'
    }
  ];

  for (const rt of roomTypes) {
    await db.run(
      `INSERT INTO room_types (id, property_id, name, code, base_rate, max_occupancy, extra_adult_rate, tax_rate, hsn_sac, amenities, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [rt.id, propId, rt.name, rt.code, rt.base_rate, rt.max_occupancy, rt.extra_adult_rate, rt.tax_rate, rt.hsn_sac, rt.amenities, rt.description]
    );
  }
  console.log(`✓ Seeded ${roomTypes.length} room types`);

  // 5. Insert Rooms
  const rooms = [
    // 1st Floor - Deluxe
    { id: 'room-101', number: '101', typeId: 'rt-std-deluxe', floor: '1st Floor', opStatus: 'occupied', hkStatus: 'clean' },
    { id: 'room-102', number: '102', typeId: 'rt-std-deluxe', floor: '1st Floor', opStatus: 'available', hkStatus: 'dirty' },
    { id: 'room-103', number: '103', typeId: 'rt-std-deluxe', floor: '1st Floor', opStatus: 'available', hkStatus: 'clean' },
    { id: 'room-104', number: '104', typeId: 'rt-std-deluxe', floor: '1st Floor', opStatus: 'available', hkStatus: 'inspected' },
    // 2nd Floor - Staggered Group Block
    { id: 'room-201', number: '201', typeId: 'rt-exec-suite', floor: '2nd Floor', opStatus: 'occupied', hkStatus: 'clean' },
    { id: 'room-202', number: '202', typeId: 'rt-exec-suite', floor: '2nd Floor', opStatus: 'occupied', hkStatus: 'clean' },
    { id: 'room-203', number: '203', typeId: 'rt-exec-suite', floor: '2nd Floor', opStatus: 'occupied', hkStatus: 'clean' },
    { id: 'room-204', number: '204', typeId: 'rt-exec-suite', floor: '2nd Floor', opStatus: 'available', hkStatus: 'inspected' }, // Reserved for 4th guest
    // 3rd Floor - Presidential & Suites
    { id: 'room-301', number: '301', typeId: 'rt-pres-villa', floor: '3rd Floor', opStatus: 'available', hkStatus: 'clean' },
    { id: 'room-302', number: '302', typeId: 'rt-pres-villa', floor: '3rd Floor', opStatus: 'out_of_order', hkStatus: 'dirty', maintStatus: 'under_repair' }
  ];

  for (const r of rooms) {
    await db.run(
      `INSERT INTO rooms (id, property_id, room_number, room_type_id, floor, building, operational_status, housekeeping_status, maintenance_status)
       VALUES (?, ?, ?, ?, ?, 'Main Wing', ?, ?, ?)`,
      [r.id, propId, r.number, r.typeId, r.floor, r.opStatus, r.hkStatus, r.maintStatus || 'ok']
    );
  }
  console.log(`✓ Seeded ${rooms.length} rooms`);

  // 6. Insert Guests
  const guests = [
    {
      id: 'guest-1',
      firstName: 'Amitabh',
      lastName: 'Sen',
      phone: '+91 98765 43210',
      email: 'amitabh.sen@example.com',
      idType: 'aadhaar',
      idNumber: '1234-5678-9012',
      city: 'Kolkata',
      state: 'West Bengal'
    },
    {
      id: 'guest-2',
      firstName: 'Rajesh',
      lastName: 'Koothrappali',
      phone: '+91 98220 11223',
      email: 'rajesh.k@acmecorp.in',
      idType: 'passport',
      idNumber: 'Z8912345',
      company: 'Acme Technologies Ltd',
      gstin: '27AAACA1234A1Z5',
      city: 'Mumbai',
      state: 'Maharashtra'
    },
    {
      id: 'guest-3',
      firstName: 'Neha',
      lastName: 'Kapoor',
      phone: '+91 99112 33445',
      email: 'neha.k@acmecorp.in',
      idType: 'driving_license',
      idNumber: 'DL042018001234',
      company: 'Acme Technologies Ltd',
      city: 'Delhi',
      state: 'Delhi'
    },
    {
      id: 'guest-4',
      firstName: 'Vikram',
      lastName: 'Malhotra',
      phone: '+91 97400 88776',
      email: 'vikram.m@acmecorp.in',
      idType: 'aadhaar',
      idNumber: '8765-4321-2109',
      company: 'Acme Technologies Ltd',
      city: 'Bengaluru',
      state: 'Karnataka'
    },
    {
      id: 'guest-5',
      firstName: 'Ananya',
      lastName: 'Deshmukh',
      phone: '+91 96555 44332',
      email: 'ananya.d@acmecorp.in',
      idType: 'passport',
      idNumber: 'P4455667',
      company: 'Acme Technologies Ltd',
      city: 'Pune',
      state: 'Maharashtra'
    }
  ];

  for (const g of guests) {
    await db.run(
      `INSERT INTO guests (id, property_id, first_name, last_name, phone, email, id_type, id_number, company_name, gstin, city, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [g.id, propId, g.firstName, g.lastName, g.phone, g.email, g.idType, g.idNumber, g.company || null, g.gstin || null, g.city, g.state]
    );
  }
  console.log(`✓ Seeded ${guests.length} guest profiles`);

  // 7. Individual Stay in Room 101 with Folio & Folio Entries
  const stay101Id = 'stay-ind-101';
  const folio101Id = 'folio-101';
  await db.run(
    `INSERT INTO stays (id, stay_number, property_id, room_id, primary_guest_id, check_in_time, expected_check_out, status, nightly_rate, adults)
     VALUES (?, 'STY-2026-001', ?, 'room-101', 'guest-1', '2026-11-09 14:30:00', '2026-11-12', 'occupied', 2800, 1)`,
    [stay101Id, propId]
  );

  await db.run(
    `INSERT INTO folios (id, folio_number, property_id, stay_id, folio_type, status, total_charges, total_payments, balance)
     VALUES (?, 'FOL-101-01', ?, ?, 'room', 'open', 6272, 3000, 3272)`,
    [folio101Id, propId, stay101Id]
  );

  // Folio entries for Room 101: 2 nights rent + GST, plus room service
  await db.run(
    `INSERT INTO folio_entries (id, folio_id, date, department, description, quantity, unit_price, tax_rate, tax_amount, total_amount, created_by)
     VALUES 
     (?, ?, '2026-11-09', 'room_rent', 'Deluxe Queen Room Rent (Night 1)', 1, 2800, 12, 336, 3136, 'usr-frontdesk'),
     (?, ?, '2026-11-10', 'room_rent', 'Deluxe Queen Room Rent (Night 2)', 1, 2800, 12, 336, 3136, 'usr-frontdesk')`,
    [uuidv4(), folio101Id, uuidv4(), folio101Id]
  );

  // Advance deposit paid
  await db.run(
    `INSERT INTO payments (id, receipt_number, property_id, folio_id, amount, payment_method, payment_type, cashier_id, transaction_ref, notes)
     VALUES (?, 'REC-2026-001', ?, ?, 3000, 'upi', 'advance_deposit', 'usr-cashier', 'UPI/261109/98712', 'Advance payment at check-in')`,
    [uuidv4(), propId, folio101Id]
  );
  console.log('✓ Seeded Individual Stay in Room 101 with Folio & Advance Payment');

  // 8. Group Reservation with Staggered Check-In (Section 7.2)
  // 4 rooms: 201, 202, 203 checked in; 204 reserved / arriving later
  const groupId = 'grp-acme-2026';
  const groupMasterFolioId = 'folio-grp-master-01';

  // Insert Group Master record first
  await db.run(
    `INSERT INTO group_reservations (id, group_booking_number, property_id, group_name, contact_name, contact_phone, contact_email, booking_source, planned_start_date, planned_end_date, total_rooms, status, notes, master_folio_id, deposit_amount, deposit_allocated)
     VALUES (?, 'GRP-2026-088', ?, 'Acme Corp Annual Offsite', 'Rajesh Koothrappali', '+91 98220 11223', 'rajesh.k@acmecorp.in', 'corporate', '2026-11-10', '2026-11-14', 4, 'partially_checked_in', 'High priority corporate booking. 3 rooms arrived, 4th arrives tonight.', ?, 15000, 0)`,
    [groupId, propId, groupMasterFolioId]
  );

  // Insert Master Folio linked to group
  await db.run(
    `INSERT INTO folios (id, folio_number, property_id, group_reservation_id, folio_type, status, total_charges, total_payments, balance)
     VALUES (?, 'FOL-GRP-MASTER', ?, ?, 'group_master', 'open', 0, 15000, -15000)`,
    [groupMasterFolioId, propId, groupId]
  );

  // Group advance deposit
  await db.run(
    `INSERT INTO payments (id, receipt_number, property_id, folio_id, group_id, amount, payment_method, payment_type, cashier_id, transaction_ref, notes)
     VALUES (?, 'REC-GRP-001', ?, ?, ?, 15000, 'bank_transfer', 'advance_deposit', 'usr-cashier', 'NEFT/ACME/55123', 'Corporate advance for offsite')`,
    [uuidv4(), propId, groupMasterFolioId, groupId]
  );

  // Room 201 Stay (Checked In)
  const grpRoom1 = 'grpr-201';
  const stay201Id = 'stay-grp-201';
  const folio201Id = 'folio-grp-201';
  await db.run(
    `INSERT INTO group_room_reservations (id, group_id, room_type_id, assigned_room_id, guest_id, guest_name, planned_check_in, planned_check_out, actual_check_in, nightly_rate, status, stay_id)
     VALUES (?, ?, 'rt-exec-suite', 'room-201', 'guest-2', 'Rajesh Koothrappali', '2026-11-10', '2026-11-14', '2026-11-10 11:15:00', 4500, 'checked_in', ?)`,
    [grpRoom1, groupId, stay201Id]
  );
  await db.run(
    `INSERT INTO stays (id, stay_number, property_id, group_room_reservation_id, room_id, primary_guest_id, check_in_time, expected_check_out, status, nightly_rate)
     VALUES (?, 'STY-2026-002', ?, ?, 'room-201', 'guest-2', '2026-11-10 11:15:00', '2026-11-14', 'occupied', 4500)`,
    [stay201Id, propId, grpRoom1]
  );
  await db.run(
    `INSERT INTO folios (id, folio_number, property_id, stay_id, folio_type, status, total_charges, total_payments, balance)
     VALUES (?, 'FOL-201-01', ?, ?, 'room', 'open', 5040, 0, 5040)`,
    [folio201Id, propId, stay201Id]
  );
  await db.run(
    `INSERT INTO folio_entries (id, folio_id, date, department, description, quantity, unit_price, tax_rate, tax_amount, total_amount, created_by)
     VALUES (?, ?, '2026-11-10', 'room_rent', 'Executive King Suite Rent (Night 1)', 1, 4500, 12, 540, 5040, 'usr-frontdesk')`,
    [uuidv4(), folio201Id]
  );

  // Room 202 Stay (Checked In)
  const grpRoom2 = 'grpr-202';
  const stay202Id = 'stay-grp-202';
  const folio202Id = 'folio-grp-202';
  await db.run(
    `INSERT INTO group_room_reservations (id, group_id, room_type_id, assigned_room_id, guest_id, guest_name, planned_check_in, planned_check_out, actual_check_in, nightly_rate, status, stay_id)
     VALUES (?, ?, 'rt-exec-suite', 'room-202', 'guest-3', 'Neha Kapoor', '2026-11-10', '2026-11-14', '2026-11-10 11:20:00', 4500, 'checked_in', ?)`,
    [grpRoom2, groupId, stay202Id]
  );
  await db.run(
    `INSERT INTO stays (id, stay_number, property_id, group_room_reservation_id, room_id, primary_guest_id, check_in_time, expected_check_out, status, nightly_rate)
     VALUES (?, 'STY-2026-003', ?, ?, 'room-202', 'guest-3', '2026-11-10 11:20:00', '2026-11-14', 'occupied', 4500)`,
    [stay202Id, propId, grpRoom2]
  );
  await db.run(
    `INSERT INTO folios (id, folio_number, property_id, stay_id, folio_type, status, total_charges, total_payments, balance)
     VALUES (?, 'FOL-202-01', ?, ?, 'room', 'open', 5040, 0, 5040)`,
    [folio202Id, propId, stay202Id]
  );
  await db.run(
    `INSERT INTO folio_entries (id, folio_id, date, department, description, quantity, unit_price, tax_rate, tax_amount, total_amount, created_by)
     VALUES (?, ?, '2026-11-10', 'room_rent', 'Executive King Suite Rent (Night 1)', 1, 4500, 12, 540, 5040, 'usr-frontdesk')`,
    [uuidv4(), folio202Id]
  );

  // Room 203 Stay (Checked In)
  const grpRoom3 = 'grpr-203';
  const stay203Id = 'stay-grp-203';
  const folio203Id = 'folio-grp-203';
  await db.run(
    `INSERT INTO group_room_reservations (id, group_id, room_type_id, assigned_room_id, guest_id, guest_name, planned_check_in, planned_check_out, actual_check_in, nightly_rate, status, stay_id)
     VALUES (?, ?, 'rt-exec-suite', 'room-203', 'guest-4', 'Vikram Malhotra', '2026-11-10', '2026-11-14', '2026-11-10 11:25:00', 4500, 'checked_in', ?)`,
    [grpRoom3, groupId, stay203Id]
  );
  await db.run(
    `INSERT INTO stays (id, stay_number, property_id, group_room_reservation_id, room_id, primary_guest_id, check_in_time, expected_check_out, status, nightly_rate)
     VALUES (?, 'STY-2026-004', ?, ?, 'room-203', 'guest-4', '2026-11-10 11:25:00', '2026-11-14', 'occupied', 4500)`,
    [stay203Id, propId, grpRoom3]
  );
  await db.run(
    `INSERT INTO folios (id, folio_number, property_id, stay_id, folio_type, status, total_charges, total_payments, balance)
     VALUES (?, 'FOL-203-01', ?, ?, 'room', 'open', 5040, 0, 5040)`,
    [folio203Id, propId, stay203Id]
  );
  await db.run(
    `INSERT INTO folio_entries (id, folio_id, date, department, description, quantity, unit_price, tax_rate, tax_amount, total_amount, created_by)
     VALUES (?, ?, '2026-11-10', 'room_rent', 'Executive King Suite Rent (Night 1)', 1, 4500, 12, 540, 5040, 'usr-frontdesk')`,
    [uuidv4(), folio203Id]
  );

  // Room 204 (4th Guest - RESERVED / Expected Arrival - Demonstrates Section 7.2)
  const grpRoom4 = 'grpr-204';
  await db.run(
    `INSERT INTO group_room_reservations (id, group_id, room_type_id, assigned_room_id, guest_id, guest_name, planned_check_in, planned_check_out, nightly_rate, status)
     VALUES (?, ?, 'rt-exec-suite', 'room-204', 'guest-5', 'Ananya Deshmukh', '2026-11-10', '2026-11-14', 4500, 'reserved')`,
    [grpRoom4, groupId]
  );
  console.log('✓ Seeded Group Booking (Acme Corp): 3 rooms checked in, 1 room reserved for later check-in');

  // 9. Restaurant Tables
  const tables = [
    { id: 'tbl-1', number: 'T-01', capacity: 2, section: 'Indoor AC', status: 'occupied' },
    { id: 'tbl-2', number: 'T-02', capacity: 4, section: 'Indoor AC', status: 'available' },
    { id: 'tbl-3', number: 'T-03', capacity: 4, section: 'Indoor AC', status: 'available' },
    { id: 'tbl-4', number: 'T-04', capacity: 6, section: 'Garden Terrace', status: 'available' },
    { id: 'tbl-5', number: 'T-05', capacity: 4, section: 'Garden Terrace', status: 'available' },
    { id: 'tbl-6', number: 'Bar-01', capacity: 2, section: 'Lounge Bar', status: 'available' }
  ];

  for (const t of tables) {
    await db.run(
      `INSERT INTO restaurant_tables (id, property_id, table_number, capacity, section, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [t.id, propId, t.number, t.capacity, t.section, t.status]
    );
  }
  console.log(`✓ Seeded ${tables.length} restaurant tables`);

  // 10. Menu Categories & Items (GST 5% as per Section 34.6)
  const categories = [
    { id: 'cat-starters', name: 'Starters & Appetizers', order: 1 },
    { id: 'cat-mains', name: 'Main Course Specialties', order: 2 },
    { id: 'cat-biryani', name: 'Dum Biryanis & Breads', order: 3 },
    { id: 'cat-beverages', name: 'Beverages & Mocktails', order: 4 },
    { id: 'cat-desserts', name: 'Desserts & Sweets', order: 5 }
  ];

  for (const c of categories) {
    await db.run(
      `INSERT INTO menu_categories (id, property_id, name, display_order)
       VALUES (?, ?, ?, ?)`,
      [c.id, propId, c.name, c.order]
    );
  }

  const menuItems = [
    { id: 'item-1', catId: 'cat-starters', name: 'Paneer Tikka Angara', code: 'STA-01', price: 320, station: 'kitchen', isVeg: 1, desc: 'Cottage cheese marinated in fiery spices cooked in clay tandoor' },
    { id: 'item-2', catId: 'cat-starters', name: 'Murgh Malai Tikka', code: 'STA-02', price: 380, station: 'kitchen', isVeg: 0, desc: 'Creamy cardamom infused chicken skewers' },
    { id: 'item-3', catId: 'cat-starters', name: 'Crispy Corn Salt & Pepper', code: 'STA-03', price: 240, station: 'kitchen', isVeg: 1, desc: 'Crunchy golden corn tossed with bell peppers and scallions' },
    { id: 'item-4', catId: 'cat-mains', name: 'Paneer Butter Masala', code: 'MAI-01', price: 340, station: 'kitchen', isVeg: 1, desc: 'Rich tomato cashew gravy with fresh cottage cheese' },
    { id: 'item-5', catId: 'cat-mains', name: 'Butter Chicken Grand Style', code: 'MAI-02', price: 420, station: 'kitchen', isVeg: 0, desc: 'Tandoori chicken in velvety makhani butter gravy' },
    { id: 'item-6', catId: 'cat-mains', name: 'Dal Makhani Bukhara', code: 'MAI-03', price: 290, station: 'kitchen', isVeg: 1, desc: 'Slow simmered black lentils finished with cream and white butter' },
    { id: 'item-7', catId: 'cat-biryani', name: 'Hyderabadi Chicken Dum Biryani', code: 'BIR-01', price: 390, station: 'kitchen', isVeg: 0, desc: 'Fragrant basmati cooked with spiced chicken, mint and saffron' },
    { id: 'item-8', catId: 'cat-biryani', name: 'Subz Nizami Biryani', code: 'BIR-02', price: 310, station: 'kitchen', isVeg: 1, desc: 'Assorted seasonal vegetables layered with long-grain basmati' },
    { id: 'item-9', catId: 'cat-biryani', name: 'Garlic Butter Naan', code: 'BRD-01', price: 75, station: 'kitchen', isVeg: 1, desc: 'Tandoor baked refined flour bread topped with minced garlic' },
    { id: 'item-10', catId: 'cat-beverages', name: 'Fresh Mint Lime Soda', code: 'BEV-01', price: 120, station: 'bar', isVeg: 1, desc: 'Refreshing soda with fresh mint sprigs and lime' },
    { id: 'item-11', catId: 'cat-beverages', name: 'Cold Pressed Mango Lassi', code: 'BEV-02', price: 160, station: 'bar', isVeg: 1, desc: 'Rich Alphonso mango blended with churned sweet yoghurt' },
    { id: 'item-12', catId: 'cat-desserts', name: 'Gulab Jamun with Rabri', code: 'DES-01', price: 180, station: 'kitchen', isVeg: 1, desc: 'Warm khoya dumplings soaked in saffron syrup served with rabri' }
  ];

  for (const m of menuItems) {
    await db.run(
      `INSERT INTO menu_items (id, property_id, category_id, name, code, description, price, unit, station, tax_rate, hsn_sac, is_available, is_veg)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'portion', ?, 5.0, '996331', 1, ?)`,
      [m.id, propId, m.catId, m.name, m.code, m.desc, m.price, m.station, m.isVeg]
    );
  }
  console.log(`✓ Seeded ${menuItems.length} menu items with 5% GST`);

  // 11. Seed Active Restaurant Order on Table T-01
  const orderId = 'ord-demo-01';
  await db.run(
    `INSERT INTO restaurant_orders (id, order_number, property_id, table_id, order_type, status, subtotal, tax_amount, total_amount, waiter_name)
     VALUES (?, 'ORD-2026-001', ?, 'tbl-1', 'dine_in', 'active', 760, 38, 798, 'Karan Singh')`,
    [orderId, propId]
  );
  await db.run("UPDATE restaurant_tables SET current_order_id = ? WHERE id = 'tbl-1'", [orderId]);

  // Order Items
  await db.run(
    `INSERT INTO order_items (id, order_id, menu_item_id, item_name, quantity, unit_price, tax_rate, tax_amount, total_amount, status)
     VALUES 
     (?, ?, 'item-1', 'Paneer Tikka Angara', 1, 320, 5.0, 16, 336, 'ready'),
     (?, ?, 'item-5', 'Butter Chicken Grand Style', 1, 420, 5.0, 21, 441, 'preparing'),
     (?, ?, 'item-9', 'Garlic Butter Naan', 2, 75, 5.0, 7.5, 157.5, 'preparing')`,
    [uuidv4(), orderId, uuidv4(), orderId, uuidv4(), orderId]
  );

  // KOT
  await db.run(
    `INSERT INTO kitchen_tickets (id, kot_number, order_id, table_id, station, status, round_number, notes)
     VALUES (?, 'KOT-1001', ?, 'tbl-1', 'kitchen', 'preparing', 1, 'Medium spicy')`,
    [uuidv4(), orderId]
  );
  console.log('✓ Seeded Active Table Order & KOT on Table T-01');

  // 12. Seed Housekeeping Tasks
  await db.run(
    `INSERT INTO housekeeping_tasks (id, property_id, room_id, task_type, status, priority, assigned_to, notes)
     VALUES 
     (?, ?, 'room-102', 'checkout_cleaning', 'dirty', 'high', 'usr-hk', 'Guest departed morning. Deep sanitize needed for next arrival.'),
     (?, ?, 'room-302', 'deep_clean', 'cleaning', 'urgent', 'usr-hk', 'Maintenance repair in progress, clean after completion.')`,
    [uuidv4(), propId, uuidv4(), propId]
  );
  console.log('✓ Seeded Housekeeping tasks');

  // 13. Seed Maintenance Tickets
  await db.run(
    `INSERT INTO maintenance_tickets (id, property_id, room_id, title, description, category, priority, status, blocks_room, reported_by, assigned_to)
     VALUES (?, ?, 'room-302', 'HVAC Aircon cooling leak', 'Master AC cooling coil issue detected. Technicians replacing refrigerant gas.', 'hvac', 'high', 'in_progress', 1, 'usr-frontdesk', 'usr-maint')`,
    [uuidv4(), propId]
  );
  console.log('✓ Seeded Maintenance ticket for Room 302');

  // 14. Seed Inventory Items
  const stockItems = [
    { id: 'stk-1', name: 'Premium Basmati Rice', cat: 'kitchen_ingredients', unit: 'kg', stock: 120, min: 25, price: 95 },
    { id: 'stk-2', name: 'Fresh Malai Paneer', cat: 'kitchen_ingredients', unit: 'kg', stock: 18, min: 10, price: 320 },
    { id: 'stk-3', name: 'Refined Sunflower Oil', cat: 'kitchen_ingredients', unit: 'ltr', stock: 45, min: 20, price: 140 },
    { id: 'stk-4', name: 'Luxury Cotton Bed Sheets (King)', cat: 'linen', unit: 'pcs', stock: 50, min: 15, price: 850 },
    { id: 'stk-5', name: 'Herbal Shampoo & Body Wash (50ml)', cat: 'amenities', unit: 'bottle', stock: 240, min: 50, price: 25 }
  ];

  for (const s of stockItems) {
    await db.run(
      `INSERT INTO stock_items (id, property_id, name, category, unit, current_stock, min_stock, cost_price, reorder_level)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [s.id, propId, s.name, s.cat, s.unit, s.stock, s.min, s.price, s.min * 1.5]
    );
  }
  console.log(`✓ Seeded ${stockItems.length} inventory items`);

  // 15. Seed Cashier Shift
  await db.run(
    `INSERT INTO cashier_shifts (id, property_id, user_id, opening_time, opening_float, total_cash, total_card, total_upi, total_room_postings, status, notes)
     VALUES ('shift-demo-01', ?, 'usr-cashier', '2026-11-10 08:00:00', 5000, 0, 0, 3000, 0, 'open', 'Morning operational shift')`,
    [propId]
  );
  console.log('✓ Seeded active Cashier shift');

  console.log('========================================================');
  console.log('  Nexuzy PMS Database Initialization & Seeding Complete ');
  console.log('========================================================');
}

if (require.main === module) {
  runSeed()
    .then(() => {
      console.log('Seed execution finished.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}

module.exports = runSeed;
