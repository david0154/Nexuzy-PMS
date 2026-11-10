const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const { authenticateToken } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');

// GET /api/v1/folios/:id
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const folio = await db.get(
      `SELECT f.*, 
              s.stay_number, s.check_in_time, s.expected_check_out,
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
      [id]
    );

    if (!folio) {
      return res.status(404).json({ success: false, error: 'Folio not found' });
    }

    const entries = await db.all(
      `SELECT * FROM folio_entries WHERE folio_id = ? ORDER BY date ASC, created_at ASC`,
      [id]
    );

    const payments = await db.all(
      `SELECT p.*, u.full_name as cashier_name
       FROM payments p
       LEFT JOIN users u ON p.cashier_id = u.id
       WHERE p.folio_id = ?
       ORDER BY p.created_at ASC`,
      [id]
    );

    res.json({
      success: true,
      folio,
      entries,
      payments
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/folios/:id/entries (Add charge to folio)
router.post('/:id/entries', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { department, description, quantity = 1, unit_price, tax_rate = 12.0 } = req.body;

    if (!description || unit_price === undefined) {
      return res.status(400).json({ success: false, error: 'Description and unit price are required' });
    }

    const qty = Number(quantity);
    const price = Number(unit_price);
    const tax = Number(tax_rate);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price < 0 ||
        !Number.isFinite(tax) || tax < 0 || tax > 100) {
      return res.status(400).json({ success: false, error: 'Quantity, unit price or tax rate is invalid' });
    }

    const targetFolio = await db.get('SELECT id, property_id, status FROM folios WHERE id = ?', [id]);
    if (!targetFolio || targetFolio.property_id !== req.user.property_id) {
      return res.status(404).json({ success: false, error: 'Folio not found' });
    }
    if (targetFolio.status !== 'open') {
      return res.status(409).json({ success: false, error: 'Cannot add charges to a settled or closed folio' });
    }

    const sub = Math.round(qty * price * 100) / 100;
    const taxAmt = Math.round(sub * (tax / 100) * 100) / 100;
    const total = Math.round((sub + taxAmt) * 100) / 100;
    const entryId = uuidv4();

    await db.transaction(async () => {
      await db.run(
        `INSERT INTO folio_entries 
         (id, folio_id, date, department, description, quantity, unit_price, tax_rate, tax_amount, total_amount, created_by)
         VALUES (?, ?, date('now'), ?, ?, ?, ?, ?, ?, ?, ?)`,
        [entryId, id, department || 'other', description, qty, price, tax, taxAmt, total, req.user.id]
      );

      await db.run(
        `UPDATE folios 
         SET total_charges = total_charges + ?,
             balance = balance + ?
         WHERE id = ?`,
        [total, total, id]
      );
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'ADD_FOLIO_CHARGE',
      entityType: 'folio',
      entityId: id,
      details: { description, total, department },
      req
    });

    const updatedFolio = await db.get('SELECT * FROM folios WHERE id = ?', [id]);
    res.json({ success: true, message: 'Charge added to folio', folio: updatedFolio });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/folios/:id/payments (Receive payment on folio)
router.post('/:id/payments', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, payment_method, notes, transaction_ref } = req.body;

    const payAmt = Number(amount);
    if (!payAmt || payAmt <= 0) {
      return res.status(400).json({ success: false, error: 'Valid payment amount required' });
    }
    const allowedMethods = ['cash', 'card', 'upi', 'bank_transfer'];
    if (!allowedMethods.includes(String(payment_method || '').toLowerCase())) {
      return res.status(400).json({ success: false, error: 'Payment method must be cash, card, upi or bank_transfer' });
    }
    if (!Number.isFinite(payAmt) || payAmt <= 0) {
      return res.status(400).json({ success: false, error: 'Valid payment amount required' });
    }

    const targetFolio = await db.get('SELECT id, property_id, status, balance FROM folios WHERE id = ?', [id]);
    if (!targetFolio || targetFolio.property_id !== req.user.property_id) {
      return res.status(404).json({ success: false, error: 'Folio not found' });
    }
    if (targetFolio.status !== 'open') {
      return res.status(409).json({ success: false, error: 'Cannot receive payment on a settled or closed folio' });
    }
    if (payAmt > Number(targetFolio.balance) + 0.005) {
      return res.status(400).json({ success: false, error: 'Payment exceeds the outstanding folio balance' });
    }

    const payId = uuidv4();
    const receiptNo = `REC-${Date.now().toString().slice(-6)}`;

    await db.transaction(async () => {
      // 1. Record payment
      await db.run(
        `INSERT INTO payments 
         (id, receipt_number, property_id, folio_id, amount, payment_method, payment_type, cashier_id, transaction_ref, notes)
         VALUES (?, ?, ?, ?, ?, ?, 'settlement', ?, ?, ?)`,
        [payId, receiptNo, req.user.property_id, id, payAmt, String(payment_method).toLowerCase(), req.user.id, transaction_ref || null, notes || null]
      );

      // 2. Update folio balance
      await db.run(
        `UPDATE folios 
         SET total_payments = total_payments + ?,
             balance = balance - ?,
             status = CASE WHEN balance - ? <= 0 THEN 'settled' ELSE status END
         WHERE id = ?`,
        [payAmt, payAmt, payAmt, id]
      );

      // 3. Update active cashier shift totals if open
      const shift = await db.get(
        "SELECT id FROM cashier_shifts WHERE user_id = ? AND status = 'open' ORDER BY opening_time DESC LIMIT 1",
        [req.user.id]
      );
      if (shift) {
        let field = 'total_cash';
        if (payment_method === 'card') field = 'total_card';
        else if (payment_method === 'upi') field = 'total_upi';
        await db.run(`UPDATE cashier_shifts SET ${field} = ${field} + ? WHERE id = ?`, [payAmt, shift.id]);
      }
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'RECEIVE_PAYMENT',
      entityType: 'folio',
      entityId: id,
      details: { amount: payAmt, payment_method, receiptNo },
      req
    });

    const updatedFolio = await db.get('SELECT * FROM folios WHERE id = ?', [id]);
    res.json({
      success: true,
      message: 'Payment recorded successfully',
      receiptNumber: receiptNo,
      folio: updatedFolio
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/folios/:id/transfers (Transfer charge to another folio, e.g. room -> master)
router.post('/:id/transfers', authenticateToken, async (req, res) => {
  try {
    const { id: sourceFolioId } = req.params;
    const { target_folio_id, amount, reason } = req.body;

    const transferAmt = Number(amount);
    if (!transferAmt || transferAmt <= 0) {
      return res.status(400).json({ success: false, error: 'Valid transfer amount required' });
    }

    const sourceFolio = await db.get('SELECT * FROM folios WHERE id = ?', [sourceFolioId]);
    const targetFolio = await db.get('SELECT * FROM folios WHERE id = ?', [target_folio_id]);

    if (!sourceFolio || !targetFolio) {
      return res.status(404).json({ success: false, error: 'Source or target folio not found' });
    }

    await db.transaction(async () => {
      // Credit source folio
      await db.run(
        `INSERT INTO folio_entries (id, folio_id, date, department, description, quantity, unit_price, tax_rate, tax_amount, total_amount, created_by, is_transferred, transferred_to_folio_id)
         VALUES (?, ?, date('now'), 'discount', ?, 1, ?, 0, 0, ?, ?, 1, ?)`,
        [uuidv4(), sourceFolioId, `Transferred to Folio ${targetFolio.folio_number}: ${reason || ''}`, -transferAmt, -transferAmt, req.user.id, target_folio_id]
      );
      await db.run(
        `UPDATE folios SET total_charges = total_charges - ?, balance = balance - ? WHERE id = ?`,
        [transferAmt, transferAmt, sourceFolioId]
      );

      // Debit target folio
      await db.run(
        `INSERT INTO folio_entries (id, folio_id, date, department, description, quantity, unit_price, tax_rate, tax_amount, total_amount, created_by)
         VALUES (?, ?, date('now'), 'other', ?, 1, ?, 0, 0, ?, ?)`,
        [uuidv4(), target_folio_id, `Transferred from Folio ${sourceFolio.folio_number}: ${reason || ''}`, transferAmt, transferAmt, req.user.id]
      );
      await db.run(
        `UPDATE folios SET total_charges = total_charges + ?, balance = balance + ? WHERE id = ?`,
        [transferAmt, transferAmt, target_folio_id]
      );
    });

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'FOLIO_CHARGE_TRANSFER',
      entityType: 'folio',
      entityId: sourceFolioId,
      details: { targetFolioId: target_folio_id, amount: transferAmt, reason },
      req
    });

    res.json({ success: true, message: `Transferred ₹${transferAmt} to Folio ${targetFolio.folio_number}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/folios/:id/invoice (Generate GST Tax Invoice)
router.post('/:id/invoice', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const folio = await db.get(
      `SELECT f.*, s.primary_guest_id, g.first_name, g.last_name, g.gstin as guest_gstin, g.company_name
       FROM folios f
       LEFT JOIN stays s ON f.stay_id = s.id
       LEFT JOIN guests g ON s.primary_guest_id = g.id
       WHERE f.id = ?`,
      [id]
    );

    if (!folio) return res.status(404).json({ success: false, error: 'Folio not found' });

    const entries = await db.all('SELECT * FROM folio_entries WHERE folio_id = ?', [id]);
    const property = await db.get('SELECT * FROM properties WHERE id = ?', [req.user.property_id]);

    let subtotal = 0;
    let totalTax = 0;

    entries.forEach(e => {
      subtotal += (e.quantity * e.unit_price);
      totalTax += (e.tax_amount || 0);
    });

    const grandTotal = subtotal + totalTax;
    const cgst = Math.round(totalTax / 2 * 100) / 100;
    const sgst = Math.round(totalTax / 2 * 100) / 100;
    const igst = 0; // Standard Intra-state calculation

    const invId = uuidv4();
    const invNo = `INV-${Date.now().toString().slice(-6)}`;
    const invDate = new Date().toISOString().slice(0, 10);

    await db.run(
      `INSERT INTO invoices 
       (id, invoice_number, property_id, folio_id, guest_id, invoice_date, subtotal, cgst_amount, sgst_amount, igst_amount, total_tax, grand_total, paid_amount, balance_due, invoice_type, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'tax_invoice', 'issued')`,
      [
        invId,
        invNo,
        req.user.property_id,
        id,
        folio.primary_guest_id || null,
        invDate,
        subtotal,
        cgst,
        sgst,
        igst,
        totalTax,
        grandTotal,
        folio.total_payments,
        folio.balance
      ]
    );

    res.json({
      success: true,
      invoice: {
        id: invId,
        invoice_number: invNo,
        date: invDate,
        property,
        customer: {
          name: `${folio.first_name || ''} ${folio.last_name || ''}`.trim() || folio.company_name || 'Guest',
          company: folio.company_name,
          gstin: folio.guest_gstin
        },
        items: entries,
        subtotal,
        cgst,
        sgst,
        total_tax: totalTax,
        grand_total: grandTotal,
        paid_amount: folio.total_payments,
        balance_due: folio.balance
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
