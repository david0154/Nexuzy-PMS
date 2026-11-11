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
    ['phone_country_code', "TEXT DEFAULT '91'"]
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
    ['version', 'INTEGER DEFAULT 1']
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
  'CREATE INDEX IF NOT EXISTS idx_reservations_checkin ON reservations(check_in_date)'
];

async function tableExists(table) {
  const row = await db.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [table]
  );
  return Boolean(row);
}

async function applyMigrations() {
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
