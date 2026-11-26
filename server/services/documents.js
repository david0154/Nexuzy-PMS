// Document numbering and booking document generation.
// Every externally visible number (quotation, confirmation, advance receipt,
// payment receipt, tax invoice, credit note) comes from a per-property,
// per-document-type sequence so it is unique, traceable and gap-free.

const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');

const PREFIXES = {
  booking_quotation: 'QTN',
  booking_confirmation: 'CNF',
  advance_receipt: 'ADV',
  payment_receipt: 'RCP',
  tax_invoice: 'INV',
  proforma: 'PRO',
  credit_note: 'CRN',
  restaurant_bill: 'RST',
  restaurant_booking: 'RBK'
};

function fiscalYear(date = new Date()) {
  const year = date.getMonth() + 1 >= 4 ? date.getFullYear() : date.getFullYear() - 1;
  return `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
}

async function ensureSequence(conn, propertyId, documentType, prefix) {
  const id = `seq-${propertyId}-${documentType}`;
  await conn.run(
    `INSERT OR IGNORE INTO document_sequences (id, property_id, document_type, prefix, next_number, padding)
     VALUES (?, ?, ?, ?, 1, 5)`,
    [id, propertyId, documentType, prefix]
  );
  const row = await conn.get(
    'SELECT * FROM document_sequences WHERE property_id = ? AND document_type = ?',
    [propertyId, documentType]
  );
  return row;
}

// Must be called inside a write transaction for gap-free numbering.
async function nextDocumentNumber(conn, propertyId, documentType, options = {}) {
  let prefix = options.prefix || PREFIXES[documentType] || 'DOC';
  if (documentType === 'tax_invoice' && !options.prefix) {
    const prop = await conn.get('SELECT invoice_prefix FROM properties WHERE id = ?', [propertyId]);
    if (prop && prop.invoice_prefix) prefix = prop.invoice_prefix;
  }
  const seq = await ensureSequence(conn, propertyId, documentType, prefix);
  const number = seq.next_number;
  const padded = String(number).padStart(seq.padding || 5, '0');
  await conn.run(
    'UPDATE document_sequences SET next_number = next_number + 1 WHERE id = ?',
    [seq.id]
  );
  return `${seq.prefix || prefix}-${fiscalYear()}-${padded}`;
}

async function insertDocument(conn, {
  propertyId,
  reservationId = null,
  groupId = null,
  folioId = null,
  documentType,
  documentNumber,
  version = 1,
  status = 'issued',
  deliveryStatus = 'not_sent',
  deliveryNote = null,
  payload,
  totalAmount = 0,
  balanceAmount = 0,
  issuedBy = null
}) {
  const id = uuidv4();
  await conn.run(
    `INSERT INTO booking_documents
     (id, property_id, reservation_id, group_id, folio_id, document_type, document_number,
      version, status, delivery_status, delivery_note, payload, total_amount, balance_amount, issued_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, propertyId, reservationId, groupId, folioId, documentType, documentNumber,
      version, status, deliveryStatus, deliveryNote,
      payload ? JSON.stringify(payload) : null,
      Number(totalAmount) || 0, Number(balanceAmount) || 0, issuedBy
    ]
  );
  return id;
}

async function getBookingContext(conn, reservationId) {
  const reservation = await conn.get(
    `SELECT res.*,
            g.first_name || ' ' || COALESCE(g.last_name, '') AS guest_name,
            g.phone AS guest_phone, g.email AS guest_email, g.address AS guest_address,
            g.gstin AS guest_gstin, g.company_name AS guest_company,
            rt.name AS room_type_name, rt.tax_rate AS room_tax_rate, rt.hsn_sac,
            r.room_number,
            p.name AS property_name, p.address AS property_address, p.city AS property_city,
            p.state AS property_state, p.gstin AS property_gstin, p.phone AS property_phone,
            p.email AS property_email, p.currency_symbol, p.logo_url,
            p.bank_name, p.bank_account_number, p.bank_ifsc, p.upi_id, p.phone_country_code
     FROM reservations res
     JOIN guests g ON res.guest_id = g.id
     JOIN room_types rt ON res.room_type_id = rt.id
     LEFT JOIN rooms r ON res.assigned_room_id = r.id
     JOIN properties p ON res.property_id = p.id
     WHERE res.id = ?`,
    [reservationId]
  );
  if (!reservation) return null;

  const payments = await conn.all(
    `SELECT p.* FROM payments p
     WHERE p.reservation_id = ? AND COALESCE(p.status, 'posted') = 'posted'
     ORDER BY p.created_at ASC`,
    [reservationId]
  );
  const refunds = await conn.all(
    'SELECT * FROM payment_refunds WHERE reservation_id = ? ORDER BY created_at ASC',
    [reservationId]
  ).catch(() => []);

  const nights = Math.max(1, Math.round(
    (new Date(reservation.check_out_date) - new Date(reservation.check_in_date)) / 86400000
  ));
  const advance = payments
    .filter(p => p.payment_type === 'advance_deposit')
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const refunded = refunds.reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const total = Number(reservation.total_amount) ||
    (Number(reservation.rate_per_night) * nights);

  return {
    reservation,
    payments,
    refunds,
    nights,
    totals: {
      total_amount: total,
      advance_received: advance,
      refunded,
      net_advance: advance - refunded,
      balance_due: total - advance + refunded
    }
  };
}

async function buildBookingDocumentPayload(conn, reservationId, documentType) {
  const ctx = await getBookingContext(conn, reservationId);
  if (!ctx) throw new Error('Reservation not found');
  const r = ctx.reservation;
  const docLabel = {
    booking_quotation: 'BOOKING QUOTATION / PRO FORMA ESTIMATE',
    booking_confirmation: 'BOOKING CONFIRMATION',
    proforma: 'PRO FORMA INVOICE'
  }[documentType] || 'BOOKING DOCUMENT';

  return {
    document_label: docLabel,
    is_tax_invoice: false,
    disclaimer: documentType === 'booking_confirmation'
      ? 'This confirmation records reservation conditions. It is not a tax invoice and does not by itself acknowledge payment.'
      : 'This is an estimate only. It is not a tax invoice and is not proof of payment.',
    property: {
      name: r.property_name,
      address: r.property_address,
      city: r.property_city,
      state: r.property_state,
      gstin: r.property_gstin,
      phone: r.property_phone,
      email: r.property_email,
      logo_url: r.logo_url
    },
    guest: {
      name: r.guest_name,
      phone: r.guest_phone,
      email: r.guest_email,
      gstin: r.guest_gstin,
      company: r.guest_company
    },
    booking: {
      reference: r.booking_reference,
      status: r.status,
      check_in_date: r.check_in_date,
      check_out_date: r.check_out_date,
      nights: ctx.nights,
      room_type: r.room_type_name,
      room_number: r.room_number,
      adults: r.adult_count,
      children: r.child_count,
      rate_per_night: r.rate_per_night,
      rate_plan: r.rate_plan,
      special_requests: r.special_requests
    },
    price_summary: {
      room_total: Number(r.rate_per_night) * ctx.nights,
      taxes: Math.max(0, ctx.totals.total_amount - Number(r.rate_per_night) * ctx.nights),
      total_amount: ctx.totals.total_amount,
      advance_required: Number(r.advance_required || 0),
      advance_received: ctx.totals.advance_received,
      balance_due: ctx.totals.balance_due,
      currency_symbol: r.currency_symbol || '₹'
    },
    cancellation_policy: {
      summary: 'Advance refunds and forfeiture follow the property cancellation policy and require authorised approval.',
      advance_due_date: r.advance_due_date || null
    },
    payments: ctx.payments.map(p => ({
      receipt_number: p.receipt_number,
      amount: p.amount,
      payment_method: p.payment_method,
      payment_type: p.payment_type,
      created_at: p.created_at
    })),
    contact: {
      phone: r.property_phone,
      email: r.property_email
    }
  };
}

module.exports = {
  PREFIXES,
  fiscalYear,
  ensureSequence,
  nextDocumentNumber,
  insertDocument,
  getBookingContext,
  buildBookingDocumentPayload
};
