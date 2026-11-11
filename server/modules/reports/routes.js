const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const { authenticateToken } = require('../../middleware/auth');

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

// GET /api/v1/reports/dashboard
router.get('/dashboard', authenticateToken, async (req, res) => {
  try {
    const prop = await db.get('SELECT * FROM properties WHERE id = ?', [req.user.property_id]);
    const bizDate = prop ? prop.business_date : new Date().toISOString().slice(0, 10);

    // Room totals and operational counts in one pass.
    const roomStats = await db.get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN operational_status = 'occupied' THEN 1 ELSE 0 END) AS occupied,
              SUM(CASE WHEN housekeeping_status = 'dirty' THEN 1 ELSE 0 END) AS dirty,
              SUM(CASE WHEN housekeeping_status IN ('clean','inspected') THEN 1 ELSE 0 END) AS clean,
              SUM(CASE WHEN operational_status = 'out_of_order' THEN 1 ELSE 0 END) AS out_of_order
       FROM rooms`
    );
    const totalRooms = Number(roomStats.total) || 0;
    const occupiedRooms = Number(roomStats.occupied) || 0;
    const dirtyRooms = Number(roomStats.dirty) || 0;
    const cleanRooms = Number(roomStats.clean) || 0;
    const oooRooms = Number(roomStats.out_of_order) || 0;
    const availableRooms = totalRooms - occupiedRooms - oooRooms;
    const occupancyRate = totalRooms > 0 ? Math.round((occupiedRooms / totalRooms) * 100) : 0;

    // Every remaining dashboard figure in one scalar query instead of a dozen
    // sequential round trips to SQLite.
    const counters = await db.get(
      `SELECT
         (SELECT COUNT(*) FROM stays WHERE status = 'occupied') AS in_house,
         (SELECT COUNT(*) FROM reservations WHERE check_in_date = ? AND status = 'confirmed') AS arrivals,
         (SELECT COUNT(*) FROM stays WHERE expected_check_out = ? AND status = 'occupied') AS departures,
         (SELECT COUNT(*) FROM restaurant_tables WHERE status = 'occupied') AS active_tables,
         (SELECT COUNT(*) FROM kitchen_tickets WHERE status IN ('new','preparing')) AS open_kots,
         (SELECT COALESCE(SUM(balance), 0) FROM folios WHERE balance > 0) AS unpaid_folios,
         (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE date(created_at) = date('now')) AS collections_today,
         (SELECT COALESCE(SUM(amount), 0) FROM hotel_expenses WHERE status = 'posted' AND date(expense_date) = date('now')) AS expenses_today,
         (SELECT COUNT(*) FROM group_reservations WHERE status IN ('confirmed','partially_checked_in','fully_checked_in','partially_checked_out')) AS active_groups`,
      [bizDate, bizDate]
    );
    const inHouseCount = Number(counters.in_house) || 0;
    const arrivalsCount = Number(counters.arrivals) || 0;
    const departuresCount = Number(counters.departures) || 0;
    const activeTables = Number(counters.active_tables) || 0;
    const openKots = Number(counters.open_kots) || 0;
    const activeGroups = Number(counters.active_groups) || 0;
    const unpaidTotal = round2(counters.unpaid_folios);
    const collectionsToday = round2(counters.collections_today);
    const expensesToday = round2(counters.expenses_today);

    res.json({
      success: true,
      business_date: bizDate,
      hotel_metrics: {
        total_rooms: totalRooms,
        occupied_rooms: occupiedRooms,
        available_rooms: availableRooms,
        dirty_rooms: dirtyRooms,
        clean_rooms: cleanRooms,
        out_of_order_rooms: oooRooms,
        occupancy_percentage: occupancyRate,
        in_house_guests: inHouseCount,
        today_arrivals: arrivalsCount,
        today_departures: departuresCount,
        active_groups: activeGroups
      },
      restaurant_metrics: {
        occupied_tables: activeTables,
        open_kots: openKots
      },
      financial_metrics: {
        total_collections_today: collectionsToday,
        expenses_today: expensesToday,
        net_today: round2(collectionsToday - expensesToday),
        outstanding_folios_total: unpaidTotal
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/reports/revenue (Department Breakdown)
router.get('/revenue', authenticateToken, async (req, res) => {
  try {
    const revByDept = await db.all(
      `SELECT department, 
              COUNT(*) as transaction_count,
              SUM(quantity * unit_price) as net_amount,
              SUM(tax_amount) as tax_amount,
              SUM(total_amount) as gross_amount
       FROM folio_entries
       WHERE is_transferred = 0
       GROUP BY department
       ORDER BY gross_amount DESC`
    );

    const directRestaurantSales = await db.get(
      `SELECT COUNT(*) as count, SUM(subtotal) as net, SUM(tax_amount) as tax, SUM(total_amount) as gross
       FROM restaurant_orders
       WHERE status = 'settled'`
    );

    res.json({
      success: true,
      department_revenue: revByDept,
      direct_restaurant_sales: directRestaurantSales
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/reports/profit-loss?from=&to=
// Revenue comes from posted folio charges plus restaurant bills settled directly
// in the outlet. Orders posted to a room are already in folio_entries, so they
// are excluded here to avoid double counting. Expenses come from the hotel
// expense ledger. Profit is revenue excluding GST minus operating expenses.
router.get('/profit-loss', authenticateToken, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
    const from = validDate(req.query.from) ? req.query.from : `${today.slice(0, 7)}-01`;
    const to = validDate(req.query.to) ? req.query.to : today;

    const folioByDepartment = await db.all(
      `SELECT department, COUNT(*) AS transaction_count,
              COALESCE(SUM(quantity * unit_price), 0) AS net_amount,
              COALESCE(SUM(tax_amount), 0) AS tax_amount,
              COALESCE(SUM(total_amount), 0) AS gross_amount
       FROM folio_entries
       WHERE is_transferred = 0 AND date(date) BETWEEN date(?) AND date(?)
       GROUP BY department
       ORDER BY gross_amount DESC`,
      [from, to]
    );

    const directRestaurant = await db.get(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(subtotal), 0) AS net,
              COALESCE(SUM(tax_amount), 0) AS tax,
              COALESCE(SUM(total_amount), 0) AS gross
       FROM restaurant_orders
       WHERE status = 'settled'
         AND date(COALESCE(settled_at, created_at)) BETWEEN date(?) AND date(?)`,
      [from, to]
    );

    const expensesByCategory = await db.all(
      `SELECT category, COUNT(*) AS entries,
              COALESCE(SUM(amount), 0) AS total,
              COALESCE(SUM(tax_amount), 0) AS tax
       FROM hotel_expenses
       WHERE status = 'posted' AND date(expense_date) BETWEEN date(?) AND date(?)
       GROUP BY category
       ORDER BY total DESC`,
      [from, to]
    );

    // Revenue and expenses by month in one grouped pass.
    const monthlyRows = await db.all(
      `SELECT month, COALESCE(SUM(revenue), 0) AS revenue, COALESCE(SUM(expense), 0) AS expenses
       FROM (
         SELECT substr(date, 1, 7) AS month, quantity * unit_price AS revenue, 0 AS expense
         FROM folio_entries
         WHERE is_transferred = 0 AND date(date) BETWEEN date(?) AND date(?)
         UNION ALL
         SELECT substr(COALESCE(settled_at, created_at), 1, 7), subtotal, 0
         FROM restaurant_orders
         WHERE status = 'settled'
           AND date(COALESCE(settled_at, created_at)) BETWEEN date(?) AND date(?)
         UNION ALL
         SELECT substr(expense_date, 1, 7), 0, amount
         FROM hotel_expenses
         WHERE status = 'posted' AND date(expense_date) BETWEEN date(?) AND date(?)
       )
       GROUP BY month
       ORDER BY month`,
      [from, to, from, to, from, to]
    );

    const departmentRows = folioByDepartment.map(row => ({
      department: row.department,
      transaction_count: Number(row.transaction_count),
      net_amount: round2(row.net_amount),
      tax_amount: round2(row.tax_amount),
      gross_amount: round2(row.gross_amount)
    }));
    if (Number(directRestaurant.count) > 0) {
      departmentRows.push({
        department: 'restaurant_direct',
        transaction_count: Number(directRestaurant.count),
        net_amount: round2(directRestaurant.net),
        tax_amount: round2(directRestaurant.tax),
        gross_amount: round2(directRestaurant.gross)
      });
    }

    const grossRevenue = round2(
      departmentRows.reduce((sum, row) => sum + row.gross_amount, 0)
    );
    const taxCollected = round2(
      departmentRows.reduce((sum, row) => sum + row.tax_amount, 0)
    );
    const netRevenue = round2(grossRevenue - taxCollected);
    const totalExpenses = round2(
      expensesByCategory.reduce((sum, row) => sum + Number(row.total || 0), 0)
    );
    const netProfit = round2(netRevenue - totalExpenses);

    const monthly = monthlyRows
      .filter(row => row.month)
      .map(row => {
        const revenue = round2(row.revenue);
        const expenses = round2(row.expenses);
        return { month: row.month, revenue, expenses, profit: round2(revenue - expenses) };
      });

    res.json({
      success: true,
      from,
      to,
      summary: {
        gross_revenue: grossRevenue,
        tax_collected: taxCollected,
        net_revenue: netRevenue,
        total_expenses: totalExpenses,
        net_profit: netProfit,
        margin_percent: netRevenue > 0 ? Math.round((netProfit / netRevenue) * 1000) / 10 : 0
      },
      revenue_by_department: departmentRows,
      expenses_by_category: expensesByCategory.map(row => ({
        category: row.category,
        entries: Number(row.entries),
        total: round2(row.total),
        tax: round2(row.tax)
      })),
      monthly
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/reports/tax (GST India Summary)
router.get('/tax', authenticateToken, async (req, res) => {
  try {
    const gstData = await db.all(
      `SELECT tax_rate, 
              SUM(quantity * unit_price) as taxable_value,
              SUM(tax_amount) as total_gst,
              SUM(tax_amount / 2) as cgst,
              SUM(tax_amount / 2) as sgst
       FROM folio_entries
       WHERE tax_rate > 0 AND is_transferred = 0
       GROUP BY tax_rate`
    );

    res.json({
      success: true,
      gst_breakdown: gstData
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/reports/audit (Audit trail logs)
router.get('/audit', authenticateToken, async (req, res) => {
  try {
    const logs = await db.all(
      `SELECT a.*, u.full_name as user_full_name, u.role as user_role
       FROM audit_logs a
       LEFT JOIN users u ON a.user_id = u.id
       ORDER BY a.created_at DESC LIMIT 100`
    );
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
