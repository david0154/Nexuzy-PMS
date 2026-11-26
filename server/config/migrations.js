// Additive, idempotent schema migrations.
// schema.sql covers fresh installs; this module upgrades databases created by
// earlier Nexuzy PMS releases without touching existing rows.

const db = require('./database');

const COLUMNS = {
  properties: [
    ['require_advance_for_confirmation', 'INTEGER DEFAULT 0'],
    ['advance_percentage', 'REAL DEFAULT 30.0'],
    ['advance_due_days', 'INTEGER DEFAULT 3'],
    ['invoice_prefix', "TEXT DEFAULT 'INV'"],
    ['phone_country_code', "TEXT DEFAULT '91'"],
    ['restaurant_tax_enabled', 'INTEGER DEFAULT 0'],
    ['local_tax_enabled', 'INTEGER DEFAULT 0'],
    ['local_tax_name', "TEXT DEFAULT 'Local Tax'"],
    ['local_tax_amount', 'REAL DEFAULT 0'],
    ['local_tax_max_guests', 'INTEGER DEFAULT 0'],
    ['local_tax_start_date', 'TEXT'],
    ['local_tax_end_date', 'TEXT'],
    ['rounding_enabled', 'INTEGER DEFAULT 0'],
    ['room_qr_enabled', 'INTEGER DEFAULT 1'],
    ['guest_portal_enabled', 'INTEGER DEFAULT 1'],
    ['guest_order_enabled', 'INTEGER DEFAULT 1'],
    ['guest_bill_enabled', 'INTEGER DEFAULT 1'],
    ['guest_service_enabled', 'INTEGER DEFAULT 1'],
    ['guest_help_enabled', 'INTEGER DEFAULT 1'],
    ['lan_guest_url', 'TEXT'],
    ['wifi_instructions', 'TEXT'],
    ['wifi_name', 'TEXT'],
    ['wifi_password', 'TEXT'],
    ['reception_contact', 'TEXT'],
    ['emergency_contact', 'TEXT'],
    ['room_assignment_mode', "TEXT DEFAULT 'manual'"],
    ['auto_assign_on_booking', 'INTEGER DEFAULT 0'],
    ['auto_assign_on_checkin', 'INTEGER DEFAULT 1'],
    ['require_inspected_for_checkin', 'INTEGER DEFAULT 1']
  ],
  reservations: [
    ['confirmation_required', 'INTEGER DEFAULT 0'],
    ['total_amount', 'REAL DEFAULT 0'],
    ['advance_required', 'REAL DEFAULT 0'],
    ['advance_due_date', 'TEXT'],
    ['payment_status', "TEXT DEFAULT 'unpaid'"],
    ['rate_plan', "TEXT DEFAULT 'standard'"],
    ['cancellation_reason', 'TEXT'],
    ['cancelled_at', 'DATETIME'],
    ['cancelled_by', 'TEXT'],
    ['refunded_amount', 'REAL DEFAULT 0'],
    ['confirmed_at', 'DATETIME'],
    ['confirmed_by', 'TEXT'],
    ['updated_at', 'DATETIME'],
    ['version', 'INTEGER DEFAULT 1'],
    ['bed_preference', 'TEXT'],
    ['ac_preference', "TEXT DEFAULT 'any'"],
    ['floor_preference', 'TEXT'],
    ['accessibility_required', 'INTEGER DEFAULT 0'],
    ['smoking_preference', "TEXT DEFAULT 'any'"],
    ['amenities_preference', 'TEXT'],
    ['assignment_mode', "TEXT DEFAULT 'manual'"],
    ['assignment_reason', 'TEXT'],
    ['preference_notes', 'TEXT']
  ],
  payment_refunds: [
    ['restaurant_booking_id', 'TEXT']
  ],
  restaurant_bookings: [
    ['idempotency_key', 'TEXT']
  ],
  payments: [
    ['restaurant_order_id', 'TEXT'],
    ['restaurant_booking_id', 'TEXT'],
    ['status', "TEXT DEFAULT 'posted'"],
    ['idempotency_key', 'TEXT'],
    ['reversed_at', 'DATETIME'],
    ['reversal_reason', 'TEXT'],
    ['device', 'TEXT']
  ],
  stays: [
    ['checked_in_by', 'TEXT'],
    ['checked_out_by', 'TEXT']
  ],
  folios: [
    ['closed_at', 'DATETIME'],
    ['closed_by', 'TEXT'],
    ['invoice_id', 'TEXT']
  ],
  invoices: [
    ['document_type', "TEXT DEFAULT 'tax_invoice'"],
    ['place_of_supply', 'TEXT'],
    ['tax_breakdown', 'TEXT'],
    ['snapshot_id', 'TEXT'],
    ['confirmed_by', 'TEXT'],
    ['confirmed_at', 'DATETIME'],
    ['is_locked', 'INTEGER DEFAULT 0'],
    ['notes', 'TEXT']
  ],
  restaurant_orders: [
    ['outlet_id', 'TEXT'],
    ['bill_number', 'TEXT'],
    ['payment_status', "TEXT DEFAULT 'unpaid'"],
    ['posted_folio_id', 'TEXT'],
    ['idempotency_key', 'TEXT'],
    ['guest_name', 'TEXT'],
    ['discount_amount', 'REAL DEFAULT 0'],
    ['updated_at', 'DATETIME']
  ],
  order_items: [
    ['addons_json', 'TEXT'],
    ['kot_round', 'INTEGER DEFAULT 0']
  ],
  kitchen_tickets: [
    ['print_count', 'INTEGER DEFAULT 0'],
    ['printed_at', 'DATETIME'],
    ['cancel_reason', 'TEXT'],
    ['created_by', 'TEXT']
  ],
  folio_entries: [
    ['idempotency_key', 'TEXT']
  ],
  audit_logs: [
    ['before_value', 'TEXT'],
    ['after_value', 'TEXT'],
    ['device', 'TEXT']
  ],
  stock_movements: [
    ['property_id', 'TEXT'],
    ['unit_cost', 'REAL'],
    ['previous_stock', 'REAL'],
    ['new_stock', 'REAL'],
    ['movement_group', 'TEXT'],
    ['approved_by', 'TEXT']
  ],
  guest_requests: [
    ['resolution_notes', 'TEXT'],
    ['updated_at', 'DATETIME'],
    ['completed_at', 'DATETIME']
  ],
  guest_sessions: [
    ['token_prefix', 'TEXT'],
    ['created_ip', 'TEXT']
  ],
  rooms: [
    ['bed_type', "TEXT DEFAULT 'queen'"],
    ['ac_type', "TEXT DEFAULT 'ac'"],
    ['smoking_allowed', 'INTEGER DEFAULT 0'],
    ['accessible', 'INTEGER DEFAULT 0'],
    ['view_type', 'TEXT'],
    ['max_occupancy', 'INTEGER']
  ]
};

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_payments_idempotency ON payments(property_id, idempotency_key)',
  'CREATE INDEX IF NOT EXISTS idx_booking_documents_reservation ON booking_documents(reservation_id)',
  'CREATE INDEX IF NOT EXISTS idx_checkout_snapshots_stay ON checkout_snapshots(stay_id)',
  'CREATE INDEX IF NOT EXISTS idx_lan_sessions_active ON lan_sessions(is_active, last_seen_at)',
  'CREATE INDEX IF NOT EXISTS idx_folio_entries_folio ON folio_entries(folio_id)',
  'CREATE INDEX IF NOT EXISTS idx_reservations_room_dates ON reservations(assigned_room_id, check_in_date, check_out_date)',
  'CREATE INDEX IF NOT EXISTS idx_folio_entries_idempotency ON folio_entries(folio_id, idempotency_key)',
  'CREATE INDEX IF NOT EXISTS idx_hotel_expenses_property_date ON hotel_expenses(property_id, expense_date)',
  'CREATE INDEX IF NOT EXISTS idx_restaurant_bookings_property_date ON restaurant_bookings(property_id, booking_date)',
  'CREATE INDEX IF NOT EXISTS idx_payments_restaurant_booking ON payments(restaurant_booking_id)',
  'CREATE INDEX IF NOT EXISTS idx_folio_entries_date ON folio_entries(date)',
  'CREATE INDEX IF NOT EXISTS idx_restaurant_orders_settled ON restaurant_orders(status, settled_at)',
  'CREATE INDEX IF NOT EXISTS idx_hotel_expenses_status_date ON hotel_expenses(status, expense_date)',
  'CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_rooms_operational ON rooms(operational_status)',
  'CREATE INDEX IF NOT EXISTS idx_stays_status_out ON stays(status, expected_check_out)',
  'CREATE INDEX IF NOT EXISTS idx_reservations_checkin ON reservations(check_in_date)',
  'CREATE INDEX IF NOT EXISTS idx_stock_items_property ON stock_items(property_id)',
  'CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements(stock_item_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_stock_movements_property ON stock_movements(property_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_room_qr_property ON room_qr_codes(property_id, is_active)',
  'CREATE INDEX IF NOT EXISTS idx_guest_sessions_stay ON guest_sessions(stay_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_guest_sessions_token ON guest_sessions(token_hash)',
  'CREATE INDEX IF NOT EXISTS idx_guest_requests_property ON guest_requests(property_id, status, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_guest_requests_stay ON guest_requests(stay_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_suppliers_property ON suppliers(property_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_purchase_orders_property ON purchase_orders(property_id, order_date)',
  'CREATE INDEX IF NOT EXISTS idx_purchase_order_items_po ON purchase_order_items(purchase_order_id)',
  'CREATE INDEX IF NOT EXISTS idx_menu_addons_item ON menu_addons(menu_item_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_items_unique_name ON stock_items(property_id, name COLLATE NOCASE)',
  'CREATE INDEX IF NOT EXISTS idx_room_allocations_room ON room_allocations(property_id, room_id, allocation_status)',
  'CREATE INDEX IF NOT EXISTS idx_room_allocations_reservation ON room_allocations(reservation_id, allocation_status)',
  'CREATE INDEX IF NOT EXISTS idx_room_allocations_stay ON room_allocations(stay_id, allocation_status)',
  'CREATE INDEX IF NOT EXISTS idx_reservations_room_type_dates ON reservations(property_id, room_type_id, check_in_date, check_out_date)'
];

async function tableExists(table) {
  const row = await db.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [table]
  );
  return Boolean(row);
}

async function applyMigrations() {
  // Fresh databases created before this release may not have the allocation
  // ledger in schema.sql when restored from an older package.
  await db.exec(`CREATE TABLE IF NOT EXISTS room_allocations (
    id TEXT PRIMARY KEY,
    property_id TEXT NOT NULL,
    reservation_id TEXT,
    stay_id TEXT,
    room_id TEXT NOT NULL,
    guest_id TEXT,
    previous_room_id TEXT,
    allocation_status TEXT NOT NULL DEFAULT 'assigned',
    assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    assigned_by TEXT,
    released_at DATETIME,
    released_by TEXT,
    release_reason TEXT,
    allocation_reason TEXT
  )`);
  const applied = [];
  for (const [table, columns] of Object.entries(COLUMNS)) {
    if (!(await tableExists(table))) continue;
    const existing = await db.all(`PRAGMA table_info("${table}")`);
    const names = new Set(existing.map(c => c.name));
    for (const [name, definition] of columns) {
      if (names.has(name)) continue;
      await db.run(`ALTER TABLE "${table}" ADD COLUMN "${name}" ${definition}`);
      applied.push(`${table}.${name}`);
    }
  }

  for (const sql of INDEXES) {
    try {
      await db.run(sql);
    } catch (err) {
      // Older SQLite builds or unusual restored schemas: an index is an
      // optimisation, never a reason to fail startup.
      if (!/already exists/i.test(err.message)) {
        console.warn(`Migration index warning: ${err.message}`);
      }
    }
  }

  if (applied.length) {
    console.log(`✓ Applied ${applied.length} additive schema migration(s)`);
  }
  return applied;
}

module.exports = { applyMigrations, COLUMNS };
