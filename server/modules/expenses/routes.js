// Hotel operating expenses.
// Expenses are recorded as a simple cash-out ledger, separate from guest folios.
// Voided rows are retained for the audit trail and excluded from totals.

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const { authenticateToken, requireRoles } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');
const { round2 } = require('../../services/billing');

const EXPENSE_ROLES = ['admin', 'general_manager', 'accountant'];
const PAYMENT_MODES = ['cash', 'upi', 'card', 'bank_transfer', 'netbanking', 'credit'];
const CATEGORIES = [
  'salary', 'utilities', 'groceries', 'maintenance', 'housekeeping',
  'laundry', 'rent', 'marketing', 'transport', 'licenses', 'miscellaneous'
];

function today() {
  return new Date().toISOString().slice(0, 10);
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

// GET /api/v1/expenses?from=&to=&category=&payment_mode=&search=
router.get('/', authenticateToken, requireRoles(...EXPENSE_ROLES), async (req, res) => {
  try {
    const from = validDate(req.query.from) ? req.query.from : '1900-01-01';
    const to = validDate(req.query.to) ? req.query.to : '2999-12-31';
    const where = ['e.property_id = ?', 'date(e.expense_date) BETWEEN date(?) AND date(?)'];
    const params = [req.user.property_id, from, to];

    if (req.query.category) { where.push('e.category = ?'); params.push(req.query.category); }
    if (req.query.payment_mode) { where.push('e.payment_mode = ?'); params.push(req.query.payment_mode); }
    if (req.query.status) { where.push('e.status = ?'); params.push(req.query.status); }
    if (req.query.search) {
      where.push('(e.description LIKE ? OR e.vendor LIKE ? OR e.reference LIKE ?)');
      const s = `%${req.query.search}%`;
      params.push(s, s, s);
    }

    const expenses = await db.all(
      `SELECT e.*, u.full_name AS created_by_name
       FROM hotel_expenses e
       LEFT JOIN users u ON e.created_by = u.id
       WHERE ${where.join(' AND ')}
       ORDER BY date(e.expense_date) DESC, e.created_at DESC`,
      params
    );

    const posted = expenses.filter(e => e.status === 'posted');
    const totals = posted.reduce((acc, e) => {
      acc.amount = round2(acc.amount + Number(e.amount || 0));
      acc.tax = round2(acc.tax + Number(e.tax_amount || 0));
      if (e.payment_mode === 'cash') acc.cash = round2(acc.cash + Number(e.amount || 0));
      else if (e.payment_mode === 'upi') acc.upi = round2(acc.upi + Number(e.amount || 0));
      else if (e.payment_mode === 'card') acc.card = round2(acc.card + Number(e.amount || 0));
      else if (['bank_transfer', 'netbanking'].includes(e.payment_mode)) acc.bank = round2(acc.bank + Number(e.amount || 0));
      else acc.credit = round2(acc.credit + Number(e.amount || 0));
      return acc;
    }, { amount: 0, tax: 0, cash: 0, upi: 0, card: 0, bank: 0, credit: 0 });

    res.json({ success: true, from, to, expenses, count: expenses.length, totals, categories: CATEGORIES, payment_modes: PAYMENT_MODES });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/expenses/summary?from=&to=
router.get('/summary', authenticateToken, requireRoles(...EXPENSE_ROLES), async (req, res) => {
  try {
    const from = validDate(req.query.from) ? req.query.from : '1900-01-01';
    const to = validDate(req.query.to) ? req.query.to : '2999-12-31';
    const byCategory = await db.all(
      `SELECT category, COUNT(*) AS entries, COALESCE(SUM(amount), 0) AS total
       FROM hotel_expenses
       WHERE property_id = ? AND status = 'posted'
         AND date(expense_date) BETWEEN date(?) AND date(?)
       GROUP BY category ORDER BY total DESC`,
      [req.user.property_id, from, to]
    );
    const byMonth = await db.all(
      `SELECT substr(expense_date, 1, 7) AS month, COALESCE(SUM(amount), 0) AS total
       FROM hotel_expenses
       WHERE property_id = ? AND status = 'posted'
         AND date(expense_date) BETWEEN date(?) AND date(?)
       GROUP BY month ORDER BY month DESC LIMIT 12`,
      [req.user.property_id, from, to]
    );
    res.json({ success: true, from, to, by_category: byCategory, by_month: byMonth });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/expenses
router.post('/', authenticateToken, requireRoles(...EXPENSE_ROLES), async (req, res) => {
  try {
    const {
      expense_date, category, vendor, description, amount, tax_amount = 0,
      payment_mode = 'cash', reference, paid_by, notes
    } = req.body;

    if (!description || !String(description).trim()) {
      return res.status(400).json({ success: false, error: 'Expense description is required' });
    }
    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, error: `Expense category must be one of: ${CATEGORIES.join(', ')}` });
    }
    const value = round2(amount);
    if (!(value > 0)) {
      return res.status(400).json({ success: false, error: 'A valid expense amount is required' });
    }
    if (!PAYMENT_MODES.includes(payment_mode)) {
      return res.status(400).json({ success: false, error: `Payment mode must be one of: ${PAYMENT_MODES.join(', ')}` });
    }
    if (expense_date && !validDate(expense_date)) {
      return res.status(400).json({ success: false, error: 'Expense date must be YYYY-MM-DD' });
    }

    const id = uuidv4();
    await db.run(
      `INSERT INTO hotel_expenses
       (id, property_id, expense_date, category, vendor, description, amount, tax_amount,
        payment_mode, reference, paid_by, notes, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?)`,
      [
        id, req.user.property_id, expense_date || today(), category, vendor || null,
        String(description).trim(), value, round2(tax_amount), payment_mode,
        reference || null, paid_by || null, notes || null, req.user.id
      ]
    );

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'CREATE_HOTEL_EXPENSE',
      entityType: 'hotel_expense',
      entityId: id,
      details: { category, description, amount: value, payment_mode },
      req
    });

    const expense = await db.get('SELECT * FROM hotel_expenses WHERE id = ?', [id]);
    res.status(201).json({ success: true, message: 'Expense recorded', expense });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/v1/expenses/:id — corrections on an open (posted) expense
router.patch('/:id', authenticateToken, requireRoles(...EXPENSE_ROLES), async (req, res) => {
  try {
    const expense = await db.get(
      'SELECT * FROM hotel_expenses WHERE id = ? AND property_id = ?',
      [req.params.id, req.user.property_id]
    );
    if (!expense) return res.status(404).json({ success: false, error: 'Expense not found' });
    if (expense.status === 'void') {
      return res.status(400).json({ success: false, error: 'A voided expense cannot be edited' });
    }

    const category = req.body.category || expense.category;
    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, error: 'Invalid expense category' });
    }
    const amount = req.body.amount !== undefined ? round2(req.body.amount) : Number(expense.amount);
    if (!(amount > 0)) return res.status(400).json({ success: false, error: 'A valid expense amount is required' });
    const paymentMode = req.body.payment_mode || expense.payment_mode;
    if (!PAYMENT_MODES.includes(paymentMode)) {
      return res.status(400).json({ success: false, error: 'Invalid payment mode' });
    }

    await db.run(
      `UPDATE hotel_expenses SET expense_date = ?, category = ?, vendor = ?, description = ?,
         amount = ?, tax_amount = ?, payment_mode = ?, reference = ?, paid_by = ?, notes = ?
       WHERE id = ?`,
      [
        req.body.expense_date || expense.expense_date, category,
        req.body.vendor !== undefined ? req.body.vendor : expense.vendor,
        req.body.description !== undefined ? String(req.body.description).trim() : expense.description,
        amount,
        req.body.tax_amount !== undefined ? round2(req.body.tax_amount) : expense.tax_amount,
        paymentMode,
        req.body.reference !== undefined ? req.body.reference : expense.reference,
        req.body.paid_by !== undefined ? req.body.paid_by : expense.paid_by,
        req.body.notes !== undefined ? req.body.notes : expense.notes,
        expense.id
      ]
    );

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'UPDATE_HOTEL_EXPENSE',
      entityType: 'hotel_expense',
      entityId: expense.id,
      beforeValue: { amount: expense.amount, category: expense.category, payment_mode: expense.payment_mode },
      afterValue: { amount, category, payment_mode: paymentMode },
      req
    });

    const updated = await db.get('SELECT * FROM hotel_expenses WHERE id = ?', [expense.id]);
    res.json({ success: true, message: 'Expense updated', expense: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/expenses/:id/void — retained for the audit trail, excluded from totals
router.post('/:id/void', authenticateToken, requireRoles('admin', 'general_manager'), async (req, res) => {
  try {
    if (!req.body.reason) return res.status(400).json({ success: false, error: 'A void reason is required' });
    const expense = await db.get(
      'SELECT * FROM hotel_expenses WHERE id = ? AND property_id = ?',
      [req.params.id, req.user.property_id]
    );
    if (!expense) return res.status(404).json({ success: false, error: 'Expense not found' });
    if (expense.status === 'void') return res.status(400).json({ success: false, error: 'Expense is already voided' });

    await db.run(
      "UPDATE hotel_expenses SET status = 'void', void_reason = ? WHERE id = ?",
      [req.body.reason, expense.id]
    );

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'VOID_HOTEL_EXPENSE',
      entityType: 'hotel_expense',
      entityId: expense.id,
      details: { reason: req.body.reason, amount: expense.amount, category: expense.category },
      req
    });

    res.json({ success: true, message: 'Expense voided. The record is retained for audit.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
