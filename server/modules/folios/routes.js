const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const { authenticateToken, requireRoles } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');
const {
  round2,
  recalcFolio,
  recordPayment,
  createFolioInvoice,
  getInvoiceResponse
} = require('../../services/billing');
const { nextDocumentNumber, insertDocument } = require('../../services/documents');
const { sendInvoicePdf } = require('../../services/pdf');

const POSTING_ROLES = ['admin', 'general_manager', 'front_desk', 'cashier'];
const APPROVER_ROLES = ['admin', 'general_manager'];

function idempotencyKey(req) {
  return req.headers['idempotency-key'] || req.body.idempotency_key || null;
}

async function loadFolioContext(folioId) {
  return db.get(
    `SELECT f.*,
            s.stay_number, s.check_in_time, s.expected_check_out, s.primary_guest_id,
            r.room_number,
            g.first_name || ' ' || COALESCE(g.last_name, '') as guest_name,
            g.phone as guest_phone, g.email as guest_email, g.address as guest_address,
            g.gstin as guest_gstin, g.company_name as guest_company,
            grp.group_name, grp.group_booking_number
     FROM folios f
     LEFT JOIN stays s ON f.stay_id = s.id
     LEFT JOIN rooms r ON s.room_id = r.id
     LEFT JOIN guests g ON s.primary_guest_id = g.id
     LEFT JOIN group_reservations grp ON f.group_reservation_id = grp.id
     WHERE f.id = ?`,
    [folioId]
  );
}

// ---------------------------------------------------------------
// Read folio ledger
// ---------------------------------------------------------------
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const folio = await loadFolioContext(req.params.id);
    if (!folio) return res.status(404).json({ success: false, error: 'Folio not found' });

    const entries = await db.all(
      'SELECT * FROM folio_entries WHERE folio_id = ? ORDER BY date ASC, created_at ASC',
      [req.params.id]
    );
    const payments = await db.all(
      `SELECT p.*, u.full_name as cashier_name
       FROM payments p
       LEFT JOIN users u ON p.cashier_id = u.id
       WHERE p.folio_id = ? AND COALESCE(p.status, 'posted') = 'posted'
       ORDER BY p.created_at ASC`,
      [req.params.id]
    );
    const refunds = await db.all(
      'SELECT * FROM payment_refunds WHERE folio_id = ? ORDER BY created_at ASC',
      [req.params.id]
    ).catch(() => []);
    const documents = await db.all(
      `SELECT id, document_type, document_number, status, total_amount, created_at
       FROM booking_documents WHERE folio_id = ? ORDER BY created_at ASC`,
      [req.params.id]
    );

    res.json({ success: true, folio, entries, payments, refunds, documents });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// Post an approved extra charge
// ---------------------------------------------------------------
router.post('/:id/entries', authenticateToken, requireRoles(...POSTING_ROLES), async (req, res) => {
  try {
    const { description, quantity = 1, unit_price, tax_rate = 12.0, department = 'other' } = req.body;
    if (!description || unit_price === undefined) {
      return res.status(400).json({ success: false, error: 'Description and unit price are required' });
    }
    if (!(Number(quantity) > 0) || Number.isNaN(Number(unit_price))) {
      return res.status(400).json({ success: false, error: 'Quantity and unit price must be valid numbers' });
    }

    const folio = await db.get('SELECT * FROM folios WHERE id = ?', [req.params.id]);
    if (!folio) return res.status(404).json({ success: false, error: 'Folio not found' });
    if (folio.status === 'closed') {
      return res.status(409).json({
        success: false,
        error: 'Folio is closed. Use an authorised post-checkout debit note instead of adding a charge.'
      });
    }

    const key = idempotencyKey(req);
    if (key) {
      const duplicate = await db.get(
        'SELECT * FROM folio_entries WHERE folio_id = ? AND idempotency_key = ?',
        [req.params.id, key]
      );
      if (duplicate) {
        return res.json({
          success: true,
          duplicate: true,
          message: 'This charge was already posted; the existing ledger line is unchanged.',
          folio
        });
      }
    }

    const sub = round2(Number(quantity) * Number(unit_price));
    const taxAmt = round2(sub * (Number(tax_rate) / 100));
    const total = round2(sub + taxAmt);

    await db.transaction(async (conn) => {
      await conn.run(
        `INSERT INTO folio_entries
         (id, folio_id, date, department, description, quantity, unit_price, tax_rate, tax_amount, total_amount, created_by, idempotency_key)
         VALUES (?, ?, date('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), req.params.id, department || 'other', description, quantity, unit_price, tax_rate, taxAmt, total, req.user.id, key]
      );
      await recalcFolio(conn, req.params.id);
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'ADD_FOLIO_CHARGE',
      entityType: 'folio',
      entityId: req.params.id,
      afterValue: { description, quantity, unit_price, tax_rate, total_amount: total, department },
      details: { description, total, department },
      req
    });

    const updatedFolio = await db.get('SELECT * FROM folios WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Charge added to folio', folio: updatedFolio });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// Reverse a posted charge (never edit/delete the original)
// ---------------------------------------------------------------
router.post('/:id/entries/:entryId/reverse', authenticateToken, requireRoles(...APPROVER_ROLES), async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, error: 'Reversal reason is required' });

    const folio = await db.get('SELECT * FROM folios WHERE id = ?', [req.params.id]);
    if (!folio) return res.status(404).json({ success: false, error: 'Folio not found' });
    if (folio.status === 'closed') {
      return res.status(409).json({ success: false, error: 'Closed folios require a credit note workflow' });
    }
    const entry = await db.get('SELECT * FROM folio_entries WHERE id = ? AND folio_id = ?', [req.params.entryId, req.params.id]);
    if (!entry) return res.status(404).json({ success: false, error: 'Folio entry not found' });

    const already = await db.get(
      "SELECT id FROM folio_entries WHERE folio_id = ? AND reference_type = 'reversal' AND reference_id = ?",
      [req.params.id, entry.id]
    );
    if (already) return res.status(400).json({ success: false, error: 'This charge has already been reversed' });

    await db.transaction(async (conn) => {
      await conn.run(
        `INSERT INTO folio_entries
         (id, folio_id, date, department, description, quantity, unit_price, tax_rate, tax_amount, total_amount, reference_id, reference_type, created_by)
         VALUES (?, ?, date('now'), ?, ?, ?, ?, ?, ?, ?, ?, 'reversal', ?)`,
        [
          uuidv4(), req.params.id, entry.department,
          `Reversal of: ${entry.description} (${reason})`,
          entry.quantity, -Number(entry.unit_price), entry.tax_rate,
          -Number(entry.tax_amount), -Number(entry.total_amount),
          entry.id, req.user.id
        ]
      );
      await recalcFolio(conn, req.params.id);
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'REVERSE_FOLIO_CHARGE',
      entityType: 'folio',
      entityId: req.params.id,
      beforeValue: entry,
      details: { reversed_entry_id: entry.id, reason },
      req
    });

    const updatedFolio = await db.get('SELECT * FROM folios WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Charge reversed with an auditable adjustment', folio: updatedFolio });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// Receive payment (idempotent, partial payments allowed)
// ---------------------------------------------------------------
router.post('/:id/payments', authenticateToken, requireRoles(...POSTING_ROLES), async (req, res) => {
  try {
    const { amount, payment_method, notes, transaction_ref } = req.body;
    const payAmt = round2(amount);
    if (!(payAmt > 0)) {
      return res.status(400).json({ success: false, error: 'Valid payment amount required' });
    }
    if (!payment_method) {
      return res.status(400).json({ success: false, error: 'Payment method is required (cash, card, upi, bank_transfer)' });
    }
    const folio = await loadFolioContext(req.params.id);
    if (!folio) return res.status(404).json({ success: false, error: 'Folio not found' });
    if (folio.status === 'closed') {
      return res.status(409).json({ success: false, error: 'Folio is closed and cannot accept a new payment' });
    }

    const result = await db.transaction(async (conn) => {
      const receipt = await recordPayment(conn, {
        propertyId: req.user.property_id,
        folioId: req.params.id,
        amount: payAmt,
        paymentMethod: payment_method,
        paymentType: 'settlement',
        cashierId: req.user.id,
        transactionRef: transaction_ref || null,
        notes: notes || null,
        idempotencyKey: idempotencyKey(req),
        device: req.headers['user-agent'] || null,
        receiptPayload: {
          document_label: 'PAYMENT RECEIPT',
          is_tax_invoice: false,
          disclaimer: 'This document acknowledges money received. It is not a tax invoice.',
          folio_number: folio.folio_number,
          guest_name: folio.guest_name,
          room_number: folio.room_number,
          amount: payAmt,
          payment_method,
          transaction_ref: transaction_ref || null,
          received_at: new Date().toISOString()
        }
      });

      if (!receipt.duplicate) {
        const shift = await conn.get(
          "SELECT id FROM cashier_shifts WHERE user_id = ? AND status = 'open' ORDER BY opening_time DESC LIMIT 1",
          [req.user.id]
        );
        if (shift) {
          let field = 'total_cash';
          if (payment_method === 'card') field = 'total_card';
          else if (payment_method === 'upi') field = 'total_upi';
          await conn.run(`UPDATE cashier_shifts SET ${field} = ${field} + ? WHERE id = ?`, [payAmt, shift.id]);
        }
      }

      return receipt;
    });

    if (!result.duplicate) {
      await logAudit({
        propertyId: req.user.property_id,
        userId: req.user.id,
        action: 'RECEIVE_PAYMENT',
        entityType: 'folio',
        entityId: req.params.id,
        details: { amount: payAmt, payment_method, receiptNo: result.payment.receipt_number },
        req
      });
    }

    const updatedFolio = await db.get('SELECT * FROM folios WHERE id = ?', [req.params.id]);
    res.json({
      success: true,
      duplicate: result.duplicate,
      message: result.duplicate
        ? 'This payment was already recorded; the original receipt is unchanged.'
        : 'Payment recorded successfully',
      receiptNumber: result.payment.receipt_number,
      folio: updatedFolio
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// Refund an overpayment / guest credit (append-only)
// ---------------------------------------------------------------
router.post('/:id/refunds', authenticateToken, requireRoles(...APPROVER_ROLES), async (req, res) => {
  try {
    const { amount, reason, refund_method, transaction_ref } = req.body;
    const refundAmount = round2(amount);
    if (!(refundAmount > 0)) return res.status(400).json({ success: false, error: 'Valid refund amount required' });
    if (!reason) return res.status(400).json({ success: false, error: 'Refund reason is required' });

    const folio = await loadFolioContext(req.params.id);
    if (!folio) return res.status(404).json({ success: false, error: 'Folio not found' });
    if (folio.balance >= -0.004) {
      return res.status(400).json({ success: false, error: 'This folio has no credit balance to refund' });
    }
    if (refundAmount > Math.abs(Number(folio.balance)) + 0.004) {
      return res.status(400).json({
        success: false,
        error: `Refund exceeds the available credit of ₹${Math.abs(Number(folio.balance))}`
      });
    }

    const refund = await db.transaction(async (conn) => {
      const receiptNo = await nextDocumentNumber(conn, req.user.property_id, 'credit_note');
      const id = uuidv4();
      await conn.run(
        `INSERT INTO payment_refunds
         (id, receipt_number, property_id, folio_id, amount, refund_method, reason,
          transaction_ref, approved_by, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, receiptNo, req.user.property_id, folio.id, refundAmount, refund_method || 'cash', reason, transaction_ref || null, req.user.id, req.user.id]
      );
      await insertDocument(conn, {
        propertyId: req.user.property_id,
        folioId: folio.id,
        documentType: 'credit_note',
        documentNumber: receiptNo,
        payload: {
          document_label: 'CREDIT NOTE / REFUND VOUCHER',
          is_tax_invoice: false,
          disclaimer: 'This records an authorised refund of a guest credit.',
          folio_number: folio.folio_number,
          guest_name: folio.guest_name,
          amount: refundAmount,
          method: refund_method || 'cash',
          reason,
          issued_at: new Date().toISOString()
        },
        totalAmount: refundAmount,
        issuedBy: req.user.id
      });
      await recalcFolio(conn, folio.id);
      return { id, receipt_number: receiptNo, amount: refundAmount };
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'REFUND_FOLIO_CREDIT',
      entityType: 'folio',
      entityId: folio.id,
      details: { ...refund, reason },
      req
    });

    const updated = await db.get('SELECT * FROM folios WHERE id = ?', [folio.id]);
    res.json({ success: true, message: 'Refund recorded', refund, folio: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// Transfer a charge between folios
// ---------------------------------------------------------------
router.post('/:id/transfers', authenticateToken, requireRoles(...POSTING_ROLES), async (req, res) => {
  try {
    const { target_folio_id, amount, reason } = req.body;
    const transferAmt = round2(amount);
    if (!(transferAmt > 0)) {
      return res.status(400).json({ success: false, error: 'Valid transfer amount required' });
    }
    if (!reason) return res.status(400).json({ success: false, error: 'Transfer reason is required' });

    const sourceFolio = await db.get('SELECT * FROM folios WHERE id = ?', [req.params.id]);
    const targetFolio = await db.get('SELECT * FROM folios WHERE id = ?', [target_folio_id]);
    if (!sourceFolio || !targetFolio) {
      return res.status(404).json({ success: false, error: 'Source or target folio not found' });
    }
    if (sourceFolio.id === targetFolio.id) {
      return res.status(400).json({ success: false, error: 'Cannot transfer to the same folio' });
    }
    if (sourceFolio.status === 'closed' || targetFolio.status === 'closed') {
      return res.status(409).json({ success: false, error: 'Closed folios cannot participate in a transfer' });
    }

    await db.transaction(async (conn) => {
      await conn.run(
        `INSERT INTO folio_entries
         (id, folio_id, date, department, description, quantity, unit_price, tax_rate, tax_amount, total_amount, created_by, is_transferred, transferred_to_folio_id)
         VALUES (?, ?, date('now'), 'discount', ?, 1, ?, 0, 0, ?, ?, 1, ?)`,
        [uuidv4(), sourceFolio.id, `Transferred to Folio ${targetFolio.folio_number}: ${reason}`, -transferAmt, -transferAmt, req.user.id, targetFolio.id]
      );
      await recalcFolio(conn, sourceFolio.id);

      await conn.run(
        `INSERT INTO folio_entries
         (id, folio_id, date, department, description, quantity, unit_price, tax_rate, tax_amount, total_amount, created_by)
         VALUES (?, ?, date('now'), 'other', ?, 1, ?, 0, 0, ?, ?)`,
        [uuidv4(), targetFolio.id, `Transferred from Folio ${sourceFolio.folio_number}: ${reason}`, transferAmt, transferAmt, req.user.id]
      );
      await recalcFolio(conn, targetFolio.id);
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'FOLIO_CHARGE_TRANSFER',
      entityType: 'folio',
      entityId: sourceFolio.id,
      details: { targetFolioId: targetFolio.id, amount: transferAmt, reason },
      req
    });

    res.json({ success: true, message: `Transferred ₹${transferAmt} to Folio ${targetFolio.folio_number}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// Download the locked tax invoice as a real PDF
// ---------------------------------------------------------------
router.get('/:id/invoice/pdf', authenticateToken, async (req, res) => {
  try {
    const invoice = await db.get(
      `SELECT id, invoice_number FROM invoices
       WHERE folio_id = ? AND invoice_type = 'tax_invoice' AND status != 'cancelled'
       ORDER BY created_at DESC LIMIT 1`,
      [req.params.id]
    );
    if (!invoice) {
      return res.status(404).json({ success: false, error: 'Generate the final invoice before downloading a PDF.' });
    }
    const payload = await getInvoiceResponse(db, invoice.id);
    await sendInvoicePdf(res, payload, `${invoice.invoice_number}.pdf`);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// Final GST tax invoice (locked, numbered, duplicate protected)
// ---------------------------------------------------------------
router.post('/:id/invoice', authenticateToken, requireRoles(...POSTING_ROLES), async (req, res) => {
  try {
    const folio = await db.get('SELECT * FROM folios WHERE id = ?', [req.params.id]);
    if (!folio) return res.status(404).json({ success: false, error: 'Folio not found' });

    const result = await db.transaction(async (conn) => {
      return createFolioInvoice(conn, {
        propertyId: req.user.property_id,
        folioId: req.params.id,
        userId: req.user.id,
        snapshotId: req.body.snapshot_id || null
      });
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: result.duplicate ? 'INVOICE_DUPLICATE_BLOCKED' : 'GENERATE_TAX_INVOICE',
      entityType: 'folio',
      entityId: req.params.id,
      details: { invoice_number: result.invoice.invoice_number, duplicate: result.duplicate },
      req
    });

    res.json({
      success: true,
      duplicate: result.duplicate,
      message: result.duplicate
        ? `Invoice ${result.invoice.invoice_number} already exists for this folio.`
        : 'Tax invoice generated',
      invoice: result.invoice
    });
  } catch (err) {
    const status = /empty folio/i.test(err.message) ? 400 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

module.exports = router;
