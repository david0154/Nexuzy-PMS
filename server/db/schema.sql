-- Nexuzy PMS Database Schema (SQLite compatible)
-- Conforms to Nexuzy PMS PRD: Hotel, Restaurant, POS, Folios, GST, Group Stays, Inventory

PRAGMA foreign_keys = ON;

-- Properties
CREATE TABLE IF NOT EXISTS properties (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    gstin TEXT,
    address TEXT,
    city TEXT,
    state TEXT,
    country TEXT DEFAULT 'India',
    phone TEXT,
    email TEXT,
    currency TEXT DEFAULT 'INR',
    currency_symbol TEXT DEFAULT '₹',
    timezone TEXT DEFAULT 'Asia/Kolkata',
    business_date TEXT NOT NULL,
    checkin_time TEXT DEFAULT '14:00',
    checkout_time TEXT DEFAULT '11:00',
    bank_name TEXT,
    bank_account_number TEXT,
    bank_ifsc TEXT,
    bank_branch TEXT,
    upi_id TEXT,
    upi_name TEXT,
    default_room_tax_rate REAL DEFAULT 12.0,
    default_restaurant_tax_rate REAL DEFAULT 5.0,
    logo_url TEXT DEFAULT '/logo.png',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- System & Integration Settings (SMTP, Google Drive, Backups)
CREATE TABLE IF NOT EXISTS system_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Users & Roles
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    property_id TEXT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    role TEXT NOT NULL, -- 'admin', 'general_manager', 'front_desk', 'cashier', 'captain', 'waiter', 'kitchen', 'housekeeping', 'maintenance', 'inventory', 'accountant'
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (property_id) REFERENCES properties(id)
);

-- Room Types
CREATE TABLE IF NOT EXISTS room_types (
    id TEXT PRIMARY KEY,
    property_id TEXT NOT NULL,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    base_rate REAL NOT NULL,
    max_occupancy INTEGER DEFAULT 2,
    extra_adult_rate REAL DEFAULT 500,
    tax_rate REAL DEFAULT 12.0, -- GST rate %
    hsn_sac TEXT DEFAULT '996311',
    amenities TEXT, -- JSON string or comma-separated
    description TEXT,
    FOREIGN KEY (property_id) REFERENCES properties(id)
);

-- Individual Rooms
CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    property_id TEXT NOT NULL,
    room_number TEXT NOT NULL,
    room_type_id TEXT NOT NULL,
    floor TEXT,
    building TEXT DEFAULT 'Main Wing',
    operational_status TEXT DEFAULT 'available', -- 'available', 'occupied', 'out_of_order', 'out_of_service', 'blocked'
    housekeeping_status TEXT DEFAULT 'clean',    -- 'clean', 'dirty', 'cleaning', 'inspected', 'dnd'
    maintenance_status TEXT DEFAULT 'ok',        -- 'ok', 'reported', 'under_repair'
    rate_override REAL,
    features TEXT,
    UNIQUE(property_id, room_number),
    FOREIGN KEY (property_id) REFERENCES properties(id),
    FOREIGN KEY (room_type_id) REFERENCES room_types(id)
);

-- Guests
CREATE TABLE IF NOT EXISTS guests (
    id TEXT PRIMARY KEY,
    property_id TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT,
    phone TEXT NOT NULL,
    email TEXT,
    id_type TEXT, -- 'aadhaar', 'passport', 'driving_license', 'voter_id'
    id_number TEXT,
    address TEXT,
    city TEXT,
    state TEXT,
    country TEXT DEFAULT 'India',
    company_name TEXT,
    gstin TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (property_id) REFERENCES properties(id)
);

-- Group Master Reservations
CREATE TABLE IF NOT EXISTS group_reservations (
    id TEXT PRIMARY KEY,
    group_booking_number TEXT NOT NULL UNIQUE,
    property_id TEXT NOT NULL,
    group_name TEXT NOT NULL,
    contact_name TEXT NOT NULL,
    contact_phone TEXT NOT NULL,
    contact_email TEXT,
    booking_source TEXT DEFAULT 'direct', -- 'direct', 'corporate', 'agent', 'event'
    planned_start_date TEXT NOT NULL,
    planned_end_date TEXT NOT NULL,
    total_rooms INTEGER DEFAULT 1,
    status TEXT DEFAULT 'confirmed', -- 'confirmed', 'partially_checked_in', 'fully_checked_in', 'partially_checked_out', 'completed', 'cancelled'
    notes TEXT,
    master_folio_id TEXT,
    deposit_amount REAL DEFAULT 0,
    deposit_allocated REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (property_id) REFERENCES properties(id)
);

-- Individual Reservations
CREATE TABLE IF NOT EXISTS reservations (
    id TEXT PRIMARY KEY,
    booking_reference TEXT NOT NULL UNIQUE,
    property_id TEXT NOT NULL,
    guest_id TEXT NOT NULL,
    check_in_date TEXT NOT NULL,
    check_out_date TEXT NOT NULL,
    room_type_id TEXT NOT NULL,
    assigned_room_id TEXT,
    adult_count INTEGER DEFAULT 1,
    child_count INTEGER DEFAULT 0,
    rate_per_night REAL NOT NULL,
    deposit_required REAL DEFAULT 0,
    deposit_paid REAL DEFAULT 0,
    status TEXT DEFAULT 'confirmed', -- 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show'
    booking_source TEXT DEFAULT 'direct',
    special_requests TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (property_id) REFERENCES properties(id),
    FOREIGN KEY (guest_id) REFERENCES guests(id),
    FOREIGN KEY (room_type_id) REFERENCES room_types(id),
    FOREIGN KEY (assigned_room_id) REFERENCES rooms(id)
);

-- Group Room Reservations (Sub-record for each room in a group reservation)
CREATE TABLE IF NOT EXISTS group_room_reservations (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    room_type_id TEXT NOT NULL,
    assigned_room_id TEXT,
    guest_id TEXT,
    guest_name TEXT,
    planned_check_in TEXT NOT NULL,
    planned_check_out TEXT NOT NULL,
    actual_check_in DATETIME,
    actual_check_out DATETIME,
    nightly_rate REAL NOT NULL,
    status TEXT DEFAULT 'reserved', -- 'reserved', 'checked_in', 'checked_out', 'cancelled', 'no_show'
    stay_id TEXT,
    notes TEXT,
    FOREIGN KEY (group_id) REFERENCES group_reservations(id) ON DELETE CASCADE,
    FOREIGN KEY (room_type_id) REFERENCES room_types(id),
    FOREIGN KEY (assigned_room_id) REFERENCES rooms(id),
    FOREIGN KEY (guest_id) REFERENCES guests(id)
);

-- Stays (Active / Checked-in records for both individual & group stays)
CREATE TABLE IF NOT EXISTS stays (
    id TEXT PRIMARY KEY,
    stay_number TEXT NOT NULL UNIQUE,
    property_id TEXT NOT NULL,
    reservation_id TEXT,
    group_room_reservation_id TEXT,
    room_id TEXT NOT NULL,
    primary_guest_id TEXT NOT NULL,
    check_in_time DATETIME NOT NULL,
    expected_check_out TEXT NOT NULL,
    actual_check_out_time DATETIME,
    status TEXT DEFAULT 'occupied', -- 'occupied', 'checked_out', 'extended'
    nightly_rate REAL NOT NULL,
    adults INTEGER DEFAULT 1,
    children INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (property_id) REFERENCES properties(id),
    FOREIGN KEY (reservation_id) REFERENCES reservations(id),
    FOREIGN KEY (group_room_reservation_id) REFERENCES group_room_reservations(id),
    FOREIGN KEY (room_id) REFERENCES rooms(id),
    FOREIGN KEY (primary_guest_id) REFERENCES guests(id)
);

-- Folios (One or more per stay, plus group master folios)
CREATE TABLE IF NOT EXISTS folios (
    id TEXT PRIMARY KEY,
    folio_number TEXT NOT NULL UNIQUE,
    property_id TEXT NOT NULL,
    stay_id TEXT,
    group_reservation_id TEXT,
    folio_type TEXT NOT NULL, -- 'room', 'group_master', 'restaurant_direct'
    status TEXT DEFAULT 'open', -- 'open', 'settled', 'closed'
    total_charges REAL DEFAULT 0,
    total_payments REAL DEFAULT 0,
    balance REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (property_id) REFERENCES properties(id),
    FOREIGN KEY (stay_id) REFERENCES stays(id),
    FOREIGN KEY (group_reservation_id) REFERENCES group_reservations(id)
);

-- Folio Entries (Audit-trailed ledger charges)
CREATE TABLE IF NOT EXISTS folio_entries (
    id TEXT PRIMARY KEY,
    folio_id TEXT NOT NULL,
    date TEXT NOT NULL,
    department TEXT NOT NULL, -- 'room_rent', 'restaurant', 'room_service', 'laundry', 'extra_bed', 'tax', 'discount', 'other'
    description TEXT NOT NULL,
    quantity REAL DEFAULT 1,
    unit_price REAL NOT NULL,
    tax_rate REAL DEFAULT 0,
    tax_amount REAL DEFAULT 0,
    total_amount REAL NOT NULL,
    reference_id TEXT, -- e.g. restaurant_order_id
    reference_type TEXT,
    created_by TEXT,
    is_transferred INTEGER DEFAULT 0,
    transferred_to_folio_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (folio_id) REFERENCES folios(id)
);

-- Payments
CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    receipt_number TEXT NOT NULL UNIQUE,
    property_id TEXT NOT NULL,
    folio_id TEXT,
    reservation_id TEXT,
    group_id TEXT,
    amount REAL NOT NULL,
    payment_method TEXT NOT NULL, -- 'cash', 'card', 'upi', 'bank_transfer'
    payment_type TEXT DEFAULT 'settlement', -- 'advance_deposit', 'settlement', 'interim'
    cashier_id TEXT,
    shift_id TEXT,
    transaction_ref TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (property_id) REFERENCES properties(id),
    FOREIGN KEY (folio_id) REFERENCES folios(id),
    FOREIGN KEY (cashier_id) REFERENCES users(id)
);

-- Invoices (GST Compliant Invoices)
CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    invoice_number TEXT NOT NULL UNIQUE,
    property_id TEXT NOT NULL,
    folio_id TEXT,
    guest_id TEXT,
    invoice_date TEXT NOT NULL,
    subtotal REAL NOT NULL,
    cgst_amount REAL DEFAULT 0,
    sgst_amount REAL DEFAULT 0,
    igst_amount REAL DEFAULT 0,
    total_tax REAL DEFAULT 0,
    grand_total REAL NOT NULL,
    paid_amount REAL DEFAULT 0,
    balance_due REAL DEFAULT 0,
    invoice_type TEXT DEFAULT 'tax_invoice', -- 'tax_invoice', 'proforma', 'advance_receipt', 'restaurant_bill'
    status TEXT DEFAULT 'issued', -- 'issued', 'cancelled', 'paid'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (property_id) REFERENCES properties(id),
    FOREIGN KEY (folio_id) REFERENCES folios(id),
    FOREIGN KEY (guest_id) REFERENCES guests(id)
);

-- Restaurant Tables
CREATE TABLE IF NOT EXISTS restaurant_tables (
    id TEXT PRIMARY KEY,
    property_id TEXT NOT NULL,
    table_number TEXT NOT NULL,
    capacity INTEGER DEFAULT 4,
    section TEXT DEFAULT 'Main Dining',
    status TEXT DEFAULT 'available', -- 'available', 'occupied', 'reserved', 'billed', 'cleaning'
    current_order_id TEXT,
    UNIQUE(property_id, table_number),
    FOREIGN KEY (property_id) REFERENCES properties(id)
);

-- Restaurant Menu Categories
CREATE TABLE IF NOT EXISTS menu_categories (
    id TEXT PRIMARY KEY,
    property_id TEXT NOT NULL,
    name TEXT NOT NULL,
    display_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    FOREIGN KEY (property_id) REFERENCES properties(id)
);

-- Restaurant Menu Items
CREATE TABLE IF NOT EXISTS menu_items (
    id TEXT PRIMARY KEY,
    property_id TEXT NOT NULL,
    category_id TEXT NOT NULL,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    description TEXT,
    price REAL NOT NULL,
    unit TEXT DEFAULT 'portion',
    station TEXT DEFAULT 'kitchen', -- 'kitchen', 'bar', 'bakery'
    tax_rate REAL DEFAULT 5.0,      -- GST rate % (Restaurant standard: 5%)
    hsn_sac TEXT DEFAULT '996331',
    is_available INTEGER DEFAULT 1,
    is_veg INTEGER DEFAULT 1,
    FOREIGN KEY (property_id) REFERENCES properties(id),
    FOREIGN KEY (category_id) REFERENCES menu_categories(id)
);

-- Menu Item Variants
CREATE TABLE IF NOT EXISTS menu_variants (
    id TEXT PRIMARY KEY,
    menu_item_id TEXT NOT NULL,
    variant_name TEXT NOT NULL, -- 'Half', 'Full', 'Small', 'Large'
    price REAL NOT NULL,
    FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE
);

-- Restaurant Orders
CREATE TABLE IF NOT EXISTS restaurant_orders (
    id TEXT PRIMARY KEY,
    order_number TEXT NOT NULL UNIQUE,
    property_id TEXT NOT NULL,
    table_id TEXT,
    order_type TEXT DEFAULT 'dine_in', -- 'dine_in', 'takeaway', 'room_service'
    stay_id TEXT,                      -- Linked when room service or posted to room
    room_id TEXT,
    status TEXT DEFAULT 'active',      -- 'draft', 'active', 'billed', 'settled', 'posted_to_room', 'cancelled'
    subtotal REAL DEFAULT 0,
    tax_amount REAL DEFAULT 0,
    total_amount REAL DEFAULT 0,
    settlement_method TEXT,            -- 'cash', 'card', 'upi', 'room_folio'
    settled_at DATETIME,
    waiter_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (property_id) REFERENCES properties(id),
    FOREIGN KEY (table_id) REFERENCES restaurant_tables(id),
    FOREIGN KEY (stay_id) REFERENCES stays(id),
    FOREIGN KEY (room_id) REFERENCES rooms(id)
);

-- Restaurant Order Items
CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    menu_item_id TEXT NOT NULL,
    item_name TEXT NOT NULL,
    variant_name TEXT,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL,
    tax_rate REAL DEFAULT 5.0,
    tax_amount REAL DEFAULT 0,
    total_amount REAL NOT NULL,
    status TEXT DEFAULT 'new', -- 'new', 'preparing', 'ready', 'served', 'cancelled'
    kot_id TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES restaurant_orders(id) ON DELETE CASCADE,
    FOREIGN KEY (menu_item_id) REFERENCES menu_items(id)
);

-- Kitchen Order Tickets (KOT)
CREATE TABLE IF NOT EXISTS kitchen_tickets (
    id TEXT PRIMARY KEY,
    kot_number TEXT NOT NULL UNIQUE,
    order_id TEXT NOT NULL,
    table_id TEXT,
    room_id TEXT,
    station TEXT DEFAULT 'kitchen',
    status TEXT DEFAULT 'new', -- 'new', 'preparing', 'ready', 'served'
    round_number INTEGER DEFAULT 1,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES restaurant_orders(id) ON DELETE CASCADE
);

-- Housekeeping Tasks
CREATE TABLE IF NOT EXISTS housekeeping_tasks (
    id TEXT PRIMARY KEY,
    property_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    task_type TEXT DEFAULT 'checkout_cleaning', -- 'daily_cleaning', 'checkout_cleaning', 'deep_clean', 'inspection'
    status TEXT DEFAULT 'dirty',                 -- 'dirty', 'cleaning', 'cleaned', 'inspected', 'ready'
    priority TEXT DEFAULT 'normal',              -- 'low', 'normal', 'high', 'urgent'
    assigned_to TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (property_id) REFERENCES properties(id),
    FOREIGN KEY (room_id) REFERENCES rooms(id)
);

-- Maintenance Tickets
CREATE TABLE IF NOT EXISTS maintenance_tickets (
    id TEXT PRIMARY KEY,
    property_id TEXT NOT NULL,
    room_id TEXT,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT DEFAULT 'general', -- 'electrical', 'plumbing', 'hvac', 'furniture', 'appliance', 'general'
    priority TEXT DEFAULT 'medium',   -- 'low', 'medium', 'high', 'urgent'
    status TEXT DEFAULT 'open',       -- 'open', 'in_progress', 'completed', 'waiting_parts'
    blocks_room INTEGER DEFAULT 0,    -- 1 if room should be marked out_of_order
    reported_by TEXT,
    assigned_to TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME,
    FOREIGN KEY (property_id) REFERENCES properties(id),
    FOREIGN KEY (room_id) REFERENCES rooms(id)
);

-- Cashier Shifts
CREATE TABLE IF NOT EXISTS cashier_shifts (
    id TEXT PRIMARY KEY,
    property_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    opening_time DATETIME NOT NULL,
    closing_time DATETIME,
    opening_float REAL DEFAULT 0,
    total_cash REAL DEFAULT 0,
    total_card REAL DEFAULT 0,
    total_upi REAL DEFAULT 0,
    total_room_postings REAL DEFAULT 0,
    closing_cash REAL,
    variance REAL DEFAULT 0,
    status TEXT DEFAULT 'open', -- 'open', 'closed'
    notes TEXT,
    FOREIGN KEY (property_id) REFERENCES properties(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Inventory Stock Items
CREATE TABLE IF NOT EXISTS stock_items (
    id TEXT PRIMARY KEY,
    property_id TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL, -- 'kitchen_ingredients', 'beverages', 'housekeeping_supplies', 'amenities'
    unit TEXT NOT NULL,     -- 'kg', 'ltr', 'pcs', 'bottle', 'box'
    current_stock REAL DEFAULT 0,
    min_stock REAL DEFAULT 10,
    cost_price REAL DEFAULT 0,
    reorder_level REAL DEFAULT 15,
    FOREIGN KEY (property_id) REFERENCES properties(id)
);

-- Inventory Stock Movements
CREATE TABLE IF NOT EXISTS stock_movements (
    id TEXT PRIMARY KEY,
    stock_item_id TEXT NOT NULL,
    movement_type TEXT NOT NULL, -- 'receipt', 'issue', 'wastage', 'adjustment'
    quantity REAL NOT NULL,
    reference TEXT,
    reason TEXT,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (stock_item_id) REFERENCES stock_items(id)
);

-- Night Audit Logs
CREATE TABLE IF NOT EXISTS night_audit_logs (
    id TEXT PRIMARY KEY,
    property_id TEXT NOT NULL,
    business_date TEXT NOT NULL,
    new_business_date TEXT NOT NULL,
    rooms_charged INTEGER DEFAULT 0,
    total_room_revenue REAL DEFAULT 0,
    total_tax REAL DEFAULT 0,
    run_by TEXT,
    status TEXT DEFAULT 'success',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (property_id) REFERENCES properties(id)
);

-- Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    property_id TEXT,
    user_id TEXT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    details TEXT,
    ip_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
