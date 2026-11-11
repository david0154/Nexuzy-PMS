// Financial posting rules shared by reservations, folios, checkout and restaurant.
// Posted financial rows are never edited: corrections are new reversal/refund
// rows. Folio balances are always recomputed from the ledger so retries and
// concurrent devices cannot drift the stored totals.

const { v4: uuidv4 } = require('uuid');
const { nextDocumentNumber, insertDocument } = require('./documents');

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

async function recalcFolio(conn, folioId) {
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

  const totalCharges = round2(charges.total);
  const totalPayments = round2(Number(payments.total) - Number(refunds.total));
  const balance = round2(totalCharges - totalPayments);

  await conn.run(
    `UPDATE folios
     SET total_charges = ?, total_payments = ?, balance = ?,
         status = CASE
           WHEN status = 'closed' THEN 'closed'
           WHEN ? > 0 THEN 'open'
           ELSE 'settled'
         END
     WHERE id = ?`,
    [totalCharges, totalPayments, balance, Math.abs(balance) > 0.004 ? 1 : 0, folioId]
  );

  return { totalCharges, totalPayments, balance };
}

async function findDuplicatePayment(conn, propertyId, idempotencyKey) {
  if (!idempotencyKey) return null;
  return conn.get(
    `SELECT * FROM payments
     WHERE property_id = ? AND idempotency_key = ?
     ORDER BY created_at ASC LIMIT 1`,
    [propertyId, idempotencyKey]
  );
}

// Records a payment exactly once. Returns duplicate:true instead of posting a
// second charge when the same idempotency key is replayed by a retrying device.
async function recordPayment(conn, {
  propertyId,
  folioId = null,
  reservationId = null,
  groupId = null,
  restaurantOrderId = null,
  restaurantBookingId = null,
  amount,
  paymentMethod,
  paymentType = 'settlement',
  cashierId,
  transactionRef = null,
  notes = null,
  idempotencyKey = null,
  device = null,
  receiptType = 'payment_receipt',
  receiptPayload = null
}) {
  const duplicate = await findDuplicatePayment(conn, propertyId, idempotencyKey);
  if (duplicate) return { payment: duplicate, duplicate: true };

  const payAmount = round2(amount);
  if (!(payAmount > 0)) throw new Error('Valid payment amount required');
  if (!paymentMethod) throw new Error('Payment method is required');

  const paymentId = uuidv4();
  const receiptNo = await nextDocumentNumber(conn, propertyId, receiptType);

  await conn.run(
    `INSERT INTO payments
     (id, receipt_number, property_id, folio_id, reservation_id, group_id, amount,
      payment_method, payment_type, cashier_id, transaction_ref, notes, status,
      idempotency_key, restaurant_order_id, restaurant_booking_id, device)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?)`,
    [
      paymentId, receiptNo, propertyId, folioId, reservationId, groupId, payAmount,
      paymentMethod, paymentType, cashierId || null, transactionRef, notes,
      idempotencyKey, restaurantOrderId, restaurantBookingId, device
    ]
  );

  let receiptDocumentId = null;
  if (receiptType === 'advance_receipt' || receiptType === 'payment_receipt') {
    receiptDocumentId = await insertDocument(conn, {
      propertyId,
      reservationId,
      groupId,
      folioId,
      documentType: receiptType,
      documentNumber: receiptNo,
      payload: receiptPayload || {
        document_label: receiptType === 'advance_receipt' ? 'ADVANCE PAYMENT RECEIPT' : 'PAYMENT RECEIPT',
        is_tax_invoice: false,
        disclaimer: 'This document acknowledges money received. It is not a tax invoice.',
        amount: payAmount,
        payment_method: paymentMethod,
        transaction_ref: transactionRef,
        received_at: new Date().toISOString()
      },
      totalAmount: payAmount,
      issuedBy: cashierId
    });
  }

  if (folioId) await recalcFolio(conn, folioId);

  if (reservationId) {
    const advance = await conn.get(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM payments
       WHERE reservation_id = ? AND payment_type = 'advance_deposit'
         AND COALESCE(status, 'posted') = 'posted'`,
      [reservationId]
    );
    const refunded = await conn.get(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM payment_refunds WHERE reservation_id = ?',
      [reservationId]
    ).catch(() => ({ total: 0 }));
    const netAdvance = round2(Number(advance.total) - Number(refunded.total));
    const reservation = await conn.get('SELECT * FROM reservations WHERE id = ?', [reservationId]);
    if (reservation) {
      const total = Number(reservation.total_amount) || 0;
      const paymentStatus = netAdvance <= 0
        ? 'unpaid'
        : (total > 0 && netAdvance >= total - 0.004 ? 'fully_prepaid' : 'partially_paid');
      const autoConfirm = ['awaiting_advance', 'tentative'].includes(reservation.status) &&
        Number(reservation.advance_required || 0) > 0 &&
        netAdvance >= Number(reservation.advance_required) - 0.004;
      await conn.run(
        `UPDATE reservations
         SET deposit_paid = ?, payment_status = ?, updated_at = CURRENT_TIMESTAMP,
             status = CASE WHEN ? = 1 THEN 'confirmed' ELSE status END,
             confirmed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE confirmed_at END
         WHERE id = ?`,
        [netAdvance, paymentStatus, autoConfirm ? 1 : 0, autoConfirm ? 1 : 0, reservationId]
      );
    }
  }

  return {
    payment: {
      id: paymentId,
      receipt_number: receiptNo,
      amount: payAmount,
      payment_method: paymentMethod,
      receipt_document_id: receiptDocumentId
    },
    duplicate: false
  };
}

function taxBreakdown(entries) {
  const map = new Map();
  for (const entry of entries) {
    const rate = Number(entry.tax_rate || 0);
    const current = map.get(rate) || { tax_rate: rate, taxable_value: 0, tax_amount: 0 };
    current.taxable_value = round2(current.taxable_value + Number(entry.quantity) * Number(entry.unit_price));
    current.tax_amount = round2(current.tax_amount + Number(entry.tax_amount || 0));
    map.set(rate, current);
  }
  return Array.from(map.values())
    .map(row => ({
      ...row,
      cgst: round2(row.tax_amount / 2),
      sgst: round2(row.tax_amount / 2)
    }))
    .sort((a, b) => a.tax_rate - b.tax_rate);
}

async function buildCheckoutPreview(conn, stayId) {
  const stay = await conn.get(
    `SELECT s.*, r.room_number, r.floor, rt.name AS room_type_name, rt.tax_rate AS room_tax_rate,
            g.first_name || ' ' || COALESCE(g.last_name, '') AS guest_name,
            g.phone AS guest_phone, g.email AS guest_email, g.address AS guest_address,
            g.gstin AS guest_gstin, g.company_name AS guest_company,
            f.id AS folio_id, f.folio_number, f.status AS folio_status, f.invoice_id,
            p.name AS property_name, p.address AS property_address, p.city AS property_city,
            p.state AS property_state, p.gstin AS property_gstin, p.phone AS property_phone,
            p.email AS property_email, p.currency_symbol, p.default_room_tax_rate,
            p.logo_url, p.upi_id, p.phone_country_code,
            res.booking_reference
     FROM stays s
     JOIN rooms r ON s.room_id = r.id
     JOIN room_types rt ON r.room_type_id = rt.id
     JOIN guests g ON s.primary_guest_id = g.id
     LEFT JOIN folios f ON f.stay_id = s.id
     LEFT JOIN reservations res ON s.reservation_id = res.id
     JOIN properties p ON s.property_id = p.id
     WHERE s.id = ?`,
    [stayId]
  );
  if (!stay) return null;
  if (!stay.folio_id) throw new Error('Active folio not found for this stay');

  const entries = await conn.all(
    'SELECT * FROM folio_entries WHERE folio_id = ? ORDER BY date ASC, created_at ASC',
    [stay.folio_id]
  );
  const payments = await conn.all(
    `SELECT p.*, u.full_name AS cashier_name FROM payments p
     LEFT JOIN users u ON p.cashier_id = u.id
     WHERE p.folio_id = ? AND COALESCE(p.status, 'posted') = 'posted'
     ORDER BY p.created_at ASC`,
    [stay.folio_id]
  );
  const refunds = await conn.all(
    'SELECT * FROM payment_refunds WHERE folio_id = ? ORDER BY created_at ASC',
    [stay.folio_id]
  ).catch(() => []);

  const postedRestaurant = await conn.all(
    `SELECT DISTINCT ro.id, ro.order_number, ro.order_type, ro.total_amount, ro.status,
            ro.settled_at, fe.id AS folio_entry_id, fe.total_amount AS folio_charge,
            fe.description
     FROM folio_entries fe
     JOIN restaurant_orders ro ON fe.reference_id = ro.id
     WHERE fe.folio_id = ? AND fe.reference_type = 'restaurant_order'
     ORDER BY ro.settled_at DESC`,
    [stay.folio_id]
  );

  // Bills paid directly in the outlet are shown for transparency only. They are
  // excluded from payable charges because they never entered this folio.
  const separateRestaurant = await conn.all(
    `SELECT id, order_number, order_type, total_amount, settlement_method, bill_number, settled_at
     FROM restaurant_orders
     WHERE status = 'settled'
       AND (
         (room_id = ? AND date(settled_at) >= date(?) AND date(settled_at) <= date(?))
         OR stay_id = ?
       )
     ORDER BY settled_at DESC`,
    [stay.room_id, stay.check_in_time, stay.actual_check_out_time || stay.expected_check_out, stayId]
  );

  const totals = entries.reduce((acc, e) => {
    acc.gross = round2(acc.gross + Number(e.total_amount || 0));
    acc.tax = round2(acc.tax + Number(e.tax_amount || 0));
    acc.net = round2(acc.net + Number(e.quantity) * Number(e.unit_price));
    if (Number(e.total_amount) < 0) acc.adjustments = round2(acc.adjustments + Number(e.total_amount));
    return acc;
  }, { gross: 0, tax: 0, net: 0, adjustments: 0 });

  const paid = round2(payments.reduce((s, p) => s + Number(p.amount || 0), 0));
  const refunded = round2(refunds.reduce((s, r) => s + Number(r.amount || 0), 0));
  const balance = round2(totals.gross - paid + refunded);

  const existingInvoice = await conn.get(
    "SELECT * FROM invoices WHERE folio_id = ? AND status != 'cancelled' ORDER BY created_at DESC LIMIT 1",
    [stay.folio_id]
  );
  const confirmedSnapshot = await conn.get(
    "SELECT * FROM checkout_snapshots WHERE stay_id = ? AND status = 'confirmed' ORDER BY confirmed_at DESC LIMIT 1",
    [stayId]
  );

  const nights = Math.max(1, Math.round(
    (new Date(stay.expected_check_out) - new Date(stay.check_in_time)) / 86400000
  ));

  return {
    stay: {
      id: stay.id,
      stay_number: stay.stay_number,
      booking_reference: stay.booking_reference,
      room_number: stay.room_number,
      room_type_name: stay.room_type_name,
      floor: stay.floor,
      check_in_time: stay.check_in_time,
      expected_check_out: stay.expected_check_out,
      nights,
      nightly_rate: stay.nightly_rate,
      adults: stay.adults,
      children: stay.children,
      guest: {
        name: stay.guest_name,
        phone: stay.guest_phone,
        email: stay.guest_email,
        address: stay.guest_address,
        gstin: stay.guest_gstin,
        company: stay.guest_company
      }
    },
    property: {
      name: stay.property_name,
      address: stay.property_address,
      city: stay.property_city,
      state: stay.property_state,
      gstin: stay.property_gstin,
      phone: stay.property_phone,
      email: stay.property_email,
      currency_symbol: stay.currency_symbol || '₹',
      logo_url: stay.logo_url,
      upi_id: stay.upi_id,
      phone_country_code: stay.phone_country_code
    },
    folio: {
      id: stay.folio_id,
      folio_number: stay.folio_number,
      status: stay.folio_status,
      invoice_id: stay.invoice_id
    },
    entries,
    payments,
    refunds,
    tax_breakdown: taxBreakdown(entries),
    restaurant: {
      posted_to_room: postedRestaurant.map(o => ({ ...o, included_in_bill: true })),
      paid_separately: separateRestaurant.map(o => ({ ...o, included_in_bill: false, informational_only: true })),
      posted_total: round2(postedRestaurant.reduce((s, o) => s + Number(o.folio_charge || 0), 0)),
      separate_total: round2(separateRestaurant.reduce((s, o) => s + Number(o.total_amount || 0), 0))
    },
    totals: {
      room_charges: round2(entries.filter(e => e.department === 'room_rent').reduce((s, e) => s + Number(e.total_amount || 0), 0)),
      other_charges: round2(entries.filter(e => e.department !== 'room_rent').reduce((s, e) => s + Number(e.total_amount || 0), 0)),
      gross_charges: totals.gross,
      net_charges: totals.net,
      discounts_adjustments: totals.adjustments,
      total_tax: totals.tax,
      total_payments: paid,
      total_refunds: refunded,
      balance_due: balance > 0 ? balance : 0,
      refund_due: balance < 0 ? Math.abs(balance) : 0,
      balance
    },
    existing_invoice: existingInvoice || null,
    confirmed_snapshot: confirmedSnapshot || null,
    bill_confirmed: Boolean(confirmedSnapshot)
  };
}

async function confirmCheckoutPreview(conn, { propertyId, stayId, preview, userId, notes = null }) {
  const totalTax = preview.totals.total_tax;
  const id = uuidv4();
  const snapshot = await conn.get(
    "SELECT id FROM checkout_snapshots WHERE stay_id = ? AND status = 'confirmed'",
    [stayId]
  );
  if (snapshot) {
    await conn.run("UPDATE checkout_snapshots SET status = 'cancelled' WHERE id = ?", [snapshot.id]);
  }
  await conn.run(
    `INSERT INTO checkout_snapshots
     (id, property_id, stay_id, folio_id, snapshot_json, total_charges, total_tax,
      total_payments, balance, refund_due, status, confirmed_by, confirmed_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, CURRENT_TIMESTAMP, ?)`,
    [
      id, propertyId, stayId, preview.folio.id, JSON.stringify(preview),
      preview.totals.gross_charges, totalTax, preview.totals.total_payments,
      preview.totals.balance, preview.totals.refund_due, userId, notes
    ]
  );
  return conn.get('SELECT * FROM checkout_snapshots WHERE id = ?', [id]);
}

async function getInvoiceResponse(conn, invoiceId) {
  const invoice = await conn.get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
  if (!invoice) return null;
  const entries = await conn.all(
    'SELECT * FROM folio_entries WHERE folio_id = ? ORDER BY date ASC, created_at ASC',
    [invoice.folio_id]
  );
  const context = await conn.get(
    `SELECT f.folio_number, g.first_name, g.last_name, g.gstin AS guest_gstin,
            g.company_name, g.phone AS guest_phone, s.stay_number,
            p.name AS property_name, p.address AS property_address, p.city AS property_city,
            p.state AS property_state, p.gstin AS property_gstin, p.phone AS property_phone,
            p.email AS property_email, p.currency_symbol, p.logo_url,
            p.bank_name, p.bank_account_number, p.bank_ifsc, p.upi_id
     FROM folios f
     LEFT JOIN stays s ON f.stay_id = s.id
     LEFT JOIN guests g ON s.primary_guest_id = g.id
     JOIN properties p ON f.property_id = p.id
     WHERE f.id = ?`,
    [invoice.folio_id]
  );
  return {
    ...invoice,
    date: invoice.invoice_date,
    document_type: invoice.document_type || 'tax_invoice',
    is_tax_invoice: true,
    property: context ? {
      name: context.property_name,
      address: context.property_address,
      city: context.property_city,
      state: context.property_state,
      gstin: context.property_gstin,
      phone: context.property_phone,
      email: context.property_email,
      currency_symbol: context.currency_symbol,
      logo_url: context.logo_url,
      bank_name: context.bank_name,
      bank_account_number: context.bank_account_number,
      bank_ifsc: context.bank_ifsc,
      upi_id: context.upi_id
    } : null,
    customer: {
      name: context ? (`${context.first_name || ''} ${context.last_name || ''}`.trim() || context.company_name || 'Guest') : 'Guest',
      company: context ? context.company_name : null,
      gstin: context ? context.guest_gstin : null,
      phone: context ? context.guest_phone : null
    },
    folio_number: context ? context.folio_number : null,
    stay_number: context ? context.stay_number : null,
    items: entries,
    cgst: invoice.cgst_amount,
    sgst: invoice.sgst_amount,
    total_tax: invoice.total_tax,
    grand_total: invoice.grand_total,
    paid_amount: invoice.paid_amount,
    balance_due: invoice.balance_due,
    tax_breakdown: invoice.tax_breakdown ? JSON.parse(invoice.tax_breakdown) : []
  };
}

async function createFolioInvoice(conn, {
  propertyId,
  folioId,
  userId,
  snapshotId = null,
  allowDuplicate = false
}) {
  const existing = await conn.get(
    `SELECT * FROM invoices
     WHERE folio_id = ? AND invoice_type = 'tax_invoice' AND status != 'cancelled'
     ORDER BY created_at DESC LIMIT 1`,
    [folioId]
  );
  if (existing && existing.is_locked && !allowDuplicate) {
    return { invoice: await getInvoiceResponse(conn, existing.id), duplicate: true };
  }

  const folio = await conn.get('SELECT * FROM folios WHERE id = ?', [folioId]);
  if (!folio) throw new Error('Folio not found');

  const entries = await conn.all(
    'SELECT * FROM folio_entries WHERE folio_id = ? ORDER BY date ASC, created_at ASC',
    [folioId]
  );
  if (!entries.length) throw new Error('Cannot invoice an empty folio');

  const payments = await conn.get(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM payments
     WHERE folio_id = ? AND COALESCE(status, 'posted') = 'posted'`,
    [folioId]
  );
  const refunds = await conn.get(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM payment_refunds WHERE folio_id = ?',
    [folioId]
  ).catch(() => ({ total: 0 }));

  const stay = await conn.get(
    `SELECT s.primary_guest_id, g.first_name, g.last_name, g.gstin AS guest_gstin,
            g.company_name, g.phone AS guest_phone, p.state AS property_state,
            p.gstin AS property_gstin, p.name AS property_name, p.address AS property_address,
            p.city AS property_city, p.phone AS property_phone, p.email AS property_email,
            p.currency_symbol, p.logo_url, p.invoice_prefix,
            p.bank_name, p.bank_account_number, p.bank_ifsc, p.upi_id
     FROM folios f
     LEFT JOIN stays s ON f.stay_id = s.id
     LEFT JOIN guests g ON s.primary_guest_id = g.id
     JOIN properties p ON f.property_id = p.id
     WHERE f.id = ?`,
    [folioId]
  );

  let subtotal = 0;
  let totalTax = 0;
  for (const entry of entries) {
    subtotal += Number(entry.quantity) * Number(entry.unit_price);
    totalTax += Number(entry.tax_amount || 0);
  }
  subtotal = round2(subtotal);
  totalTax = round2(totalTax);
  const grandTotal = round2(subtotal + totalTax);
  const cgst = round2(totalTax / 2);
  const sgst = round2(totalTax - cgst);
  const paidAmount = round2(Number(payments.total) - Number(refunds.total));
  const balanceDue = round2(grandTotal - paidAmount);

  const invId = uuidv4();
  const invNo = await nextDocumentNumber(conn, propertyId, 'tax_invoice');
  const invDate = new Date().toISOString().slice(0, 10);
  const breakdown = taxBreakdown(entries);

  await conn.run(
    `INSERT INTO invoices
     (id, invoice_number, property_id, folio_id, guest_id, invoice_date, subtotal,
      cgst_amount, sgst_amount, igst_amount, total_tax, grand_total, paid_amount,
      balance_due, invoice_type, status, document_type, place_of_supply, tax_breakdown,
      snapshot_id, confirmed_by, confirmed_at, is_locked)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'tax_invoice', 'issued',
             'tax_invoice', ?, ?, ?, ?, CURRENT_TIMESTAMP, 1)`,
    [
      invId, invNo, propertyId, folioId, stay ? stay.primary_guest_id : null, invDate,
      subtotal, cgst, sgst, totalTax, grandTotal, paidAmount, balanceDue,
      stay ? stay.property_state : null, JSON.stringify(breakdown), snapshotId, userId
    ]
  );

  await conn.run('UPDATE folios SET invoice_id = ? WHERE id = ?', [invId, folioId]);
  if (snapshotId) {
    await conn.run("UPDATE checkout_snapshots SET status = 'invoice_issued' WHERE id = ?", [snapshotId]);
  }

  const customerName = stay
    ? (`${stay.first_name || ''} ${stay.last_name || ''}`.trim() || stay.company_name || 'Guest')
    : 'Guest';

  const invoice = {
    id: invId,
    invoice_number: invNo,
    date: invDate,
    document_type: 'tax_invoice',
    is_tax_invoice: true,
    property: stay ? {
      name: stay.property_name,
      address: stay.property_address,
      city: stay.property_city,
      state: stay.property_state,
      gstin: stay.property_gstin,
      phone: stay.property_phone,
      email: stay.property_email,
      currency_symbol: stay.currency_symbol,
      logo_url: stay.logo_url,
      bank_name: stay.bank_name,
      bank_account_number: stay.bank_account_number,
      bank_ifsc: stay.bank_ifsc,
      upi_id: stay.upi_id
    } : null,
    customer: stay ? {
      name: customerName,
      company: stay.company_name,
      gstin: stay.guest_gstin,
      phone: stay.guest_phone
    } : { name: customerName },
    items: entries,
    subtotal,
    cgst,
    sgst,
    total_tax: totalTax,
    grand_total: grandTotal,
    paid_amount: paidAmount,
    balance_due: balanceDue,
    tax_breakdown: breakdown
  };

  await insertDocument(conn, {
    propertyId,
    folioId,
    documentType: 'tax_invoice',
    documentNumber: invNo,
    payload: invoice,
    totalAmount: grandTotal,
    balanceAmount: balanceDue,
    issuedBy: userId
  });

  return { invoice, duplicate: false };
}

module.exports = {
  round2,
  recalcFolio,
  findDuplicatePayment,
  recordPayment,
  taxBreakdown,
  buildCheckoutPreview,
  confirmCheckoutPreview,
  createFolioInvoice,
  getInvoiceResponse
};
