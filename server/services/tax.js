// Server-side tax configuration: room GST, restaurant GST, local tax and
// checkout rounding. No browser-supplied tax value is ever used.
//
// Local tax is charged exactly once per eligible guest-night. Each night is a
// folio ledger row with a deterministic idempotency key, so check-in,
// extensions, night audit and checkout can safely run repeatedly.

const { v4: uuidv4 } = require('uuid');
const { round2, recalcFolio } = require('./billing');

function asFlag(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 1 || value === '1' || value === 'true';
}

function taxConfig(property) {
  const p = property || {};
  return {
    room_tax_rate: Number(p.default_room_tax_rate ?? 12),
    restaurant_tax_enabled: asFlag(p.restaurant_tax_enabled, false),
    restaurant_tax_rate: Number(p.default_restaurant_tax_rate ?? 5),
    local_tax_enabled: asFlag(p.local_tax_enabled, false),
    local_tax_name: p.local_tax_name || 'Local Tax',
    local_tax_amount: Number(p.local_tax_amount || 0),
    local_tax_max_guests: Number(p.local_tax_max_guests || 0),
    local_tax_start_date: p.local_tax_start_date || null,
    local_tax_end_date: p.local_tax_end_date || null,
    rounding_enabled: asFlag(p.rounding_enabled, false)
  };
}

// Restaurant GST is disabled unless an administrator explicitly enables it.
function effectiveRestaurantTaxRate(property, item) {
  if (!asFlag(property && property.restaurant_tax_enabled, false)) return 0;
  const rate = Number(item && item.tax_rate);
  if (Number.isFinite(rate)) return rate;
  return Number(property.default_restaurant_tax_rate ?? 5);
}

function eligibleGuestCount(stay, property) {
  const guests = Math.max(0, Number(stay.adults || 0) + Number(stay.children || 0));
  const cap = Number((property && property.local_tax_max_guests) || 0);
  if (cap > 0) return Math.min(guests, cap);
  return guests;
}

function stayNights(stay) {
  const start = String(stay.check_in_time || '').slice(0, 10);
  const end = String(stay.expected_check_out || '').slice(0, 10);
  if (!start || !end) return [];
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return [];
  const nights = [];
  const cursor = new Date(startDate);
  let guard = 0;
  while (cursor < endDate && guard < 366) {
    nights.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard += 1;
  }
  return nights;
}

/**
 * Posts local tax ledger rows for every eligible, not-yet-charged guest-night.
 * Must run inside db.transaction().
 */
async function postLocalTaxForStay(conn, property, stay, { userId = null } = {}) {
  const config = taxConfig(property);
  if (!config.local_tax_enabled || !(config.local_tax_amount > 0)) {
    return { posted: 0, amount: 0 };
  }

  const folio = await conn.get('SELECT * FROM folios WHERE stay_id = ?', [stay.id]);
  if (!folio || folio.status === 'closed') return { posted: 0, amount: 0 };

  const guests = eligibleGuestCount(stay, property);
  if (!(guests > 0)) return { posted: 0, amount: 0 };

  let posted = 0;
  let amount = 0;
  for (const night of stayNights(stay)) {
    if (config.local_tax_start_date && night < config.local_tax_start_date) continue;
    if (config.local_tax_end_date && night > config.local_tax_end_date) continue;

    const key = `local-tax:${stay.id}:${night}`;
    const existing = await conn.get(
      'SELECT id FROM folio_entries WHERE folio_id = ? AND idempotency_key = ?',
      [folio.id, key]
    );
    if (existing) continue;

    const lineTotal = round2(config.local_tax_amount * guests);
    await conn.run(
      `INSERT INTO folio_entries
       (id, folio_id, date, department, description, quantity, unit_price, tax_rate, tax_amount,
        total_amount, reference_id, reference_type, created_by, idempotency_key)
       VALUES (?, ?, ?, 'local_tax', ?, ?, ?, 0, 0, ?, ?, 'local_tax', ?, ?)`,
      [
        uuidv4(), folio.id, night,
        `${config.local_tax_name} (${guests} guest${guests === 1 ? '' : 's'})`,
        guests, config.local_tax_amount, lineTotal, stay.id, userId, key
      ]
    );
    posted += 1;
    amount = round2(amount + lineTotal);
  }

  if (posted > 0) await recalcFolio(conn, folio.id);
  return { posted, amount };
}

async function folioBalance(conn, folioId) {
  const charges = await conn.get(
    'SELECT COALESCE(SUM(total_amount), 0) AS total FROM folio_entries WHERE folio_id = ?',
    [folioId]
  );
  const payments = await conn.get(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM payments
     WHERE folio_id = ? AND COALESCE(status, 'posted') = 'posted'`,
    [folioId]
  );
  const refunds = await conn.get(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM payment_refunds WHERE folio_id = ?',
    [folioId]
  ).catch(() => ({ total: 0 }));
  return round2(Number(charges.total) - Number(payments.total) + Number(refunds.total));
}

/**
 * Applies the optional checkout rounding adjustment as a transparent ledger
 * line. Idempotent per stay, so retries cannot round twice.
 */
async function applyCheckoutRounding(conn, { property, folioId, stayId, userId = null }) {
  const config = taxConfig(property);
  if (!config.rounding_enabled) return { applied: false, adjustment: 0, balance: await folioBalance(conn, folioId) };

  const key = `rounding:${stayId}`;
  const existing = await conn.get(
    'SELECT * FROM folio_entries WHERE folio_id = ? AND idempotency_key = ?',
    [folioId, key]
  );
  if (existing) {
    return {
      applied: true,
      already_applied: true,
      adjustment: Number(existing.total_amount),
      balance: await folioBalance(conn, folioId)
    };
  }

  const balance = await folioBalance(conn, folioId);
  if (balance <= 0.004) return { applied: false, adjustment: 0, balance };

  const rounded = Math.round(balance);
  const adjustment = round2(rounded - balance);
  if (Math.abs(adjustment) < 0.005) return { applied: false, adjustment: 0, balance };

  await conn.run(
    `INSERT INTO folio_entries
     (id, folio_id, date, department, description, quantity, unit_price, tax_rate, tax_amount,
      total_amount, reference_id, reference_type, created_by, idempotency_key)
     VALUES (?, ?, date('now'), 'rounding', ?, 1, ?, 0, 0, ?, ?, 'rounding', ?, ?)`,
    [
      uuidv4(), folioId,
      adjustment >= 0 ? 'Rounding adjustment' : 'Rounding adjustment (credit)',
      adjustment, adjustment, stayId, userId, key
    ]
  );
  await recalcFolio(conn, folioId);

  return {
    applied: true,
    adjustment,
    balance,
    rounded_balance: rounded,
    new_balance: await folioBalance(conn, folioId)
  };
}

module.exports = {
  taxConfig,
  effectiveRestaurantTaxRate,
  eligibleGuestCount,
  stayNights,
  postLocalTaxForStay,
  folioBalance,
  applyCheckoutRounding
};
