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
       FROM rooms WHERE property_id = ?`,
      [req.user.property_id]
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
         (SELECT COUNT(*) FROM stays WHERE status = 'occupied' AND property_id = ?) AS in_house,
         (SELECT COUNT(*) FROM reservations WHERE check_in_date = ? AND status = 'confirmed' AND property_id = ?) AS arrivals,
         (SELECT COUNT(*) FROM stays WHERE expected_check_out = ? AND status = 'occupied' AND property_id = ?) AS departures,
         (SELECT COUNT(*) FROM restaurant_tables WHERE status = 'occupied' AND property_id = ?) AS active_tables,
         (SELECT COUNT(*) FROM kitchen_tickets kt JOIN restaurant_orders o ON kt.order_id = o.id
          WHERE kt.status IN ('new','preparing') AND o.property_id = ?) AS open_kots,
         (SELECT COALESCE(SUM(balance), 0) FROM folios WHERE balance > 0 AND property_id = ?) AS unpaid_folios,
         (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE date(created_at) = date('now') AND property_id = ?) AS collections_today,
         (SELECT COALESCE(SUM(amount), 0) FROM hotel_expenses WHERE status = 'posted' AND date(expense_date) = date('now') AND property_id = ?) AS expenses_today,
         (SELECT COUNT(*) FROM group_reservations WHERE status IN ('confirmed','partially_checked_in','fully_checked_in','partially_checked_out') AND property_id = ?) AS active_groups,
         (SELECT COUNT(*) FROM guest_requests WHERE status IN ('pending','accepted','in_progress') AND property_id = ?) AS open_guest_requests,
         (SELECT COUNT(*) FROM room_qr_codes WHERE property_id = ? AND is_active = 1) AS active_room_qr`,
      [
        req.user.property_id, bizDate, req.user.property_id, bizDate, req.user.property_id,
        req.user.property_id, req.user.property_id, req.user.property_id, req.user.property_id,
        req.user.property_id, req.user.property_id, req.user.property_id
      ]
    );
    const inHouseCount = Number(counters.in_house) || 0;
    const arrivalsCount = Number(counters.arrivals) || 0;
    const departuresCount = Number(counters.departures) || 0;
    const activeTables = Number(counters.active_tables) || 0;
    const openKots = Number(counters.open_kots) || 0;
    const activeGroups = Number(counters.active_groups) || 0;
    const openGuestRequests = Number(counters.open_guest_requests) || 0;
    const activeRoomQr = Number(counters.active_room_qr) || 0;
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
        active_groups: activeGroups,
        open_guest_requests: openGuestRequests,
        active_room_qr: activeRoomQr
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
       FROM folio_entries fe
       JOIN folios f ON fe.folio_id = f.id
       WHERE fe.is_transferred = 0 AND f.property_id = ?
       GROUP BY fe.department
       ORDER BY gross_amount DESC`,
      [req.user.property_id]
    );

    const directRestaurantSales = await db.get(
      `SELECT COUNT(*) as count, SUM(subtotal) as net, SUM(tax_amount) as tax, SUM(total_amount) as gross
       FROM restaurant_orders
       WHERE status = 'settled' AND property_id = ?`,
      [req.user.property_id]
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
       FROM folio_entries fe
       JOIN folios f ON fe.folio_id = f.id
       WHERE fe.is_transferred = 0 AND f.property_id = ? AND date(fe.date) BETWEEN date(?) AND date(?)
       GROUP BY fe.department
       ORDER BY gross_amount DESC`,
      [req.user.property_id, from, to]
    );

    const directRestaurant = await db.get(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(subtotal), 0) AS net,
              COALESCE(SUM(tax_amount), 0) AS tax,
              COALESCE(SUM(total_amount), 0) AS gross
       FROM restaurant_orders
       WHERE status = 'settled' AND property_id = ?
         AND date(COALESCE(settled_at, created_at)) BETWEEN date(?) AND date(?)`,
      [req.user.property_id, from, to]
    );

    const expensesByCategory = await db.all(
      `SELECT category, COUNT(*) AS entries,
              COALESCE(SUM(amount), 0) AS total,
              COALESCE(SUM(tax_amount), 0) AS tax
       FROM hotel_expenses
       WHERE status = 'posted' AND property_id = ? AND date(expense_date) BETWEEN date(?) AND date(?)
       GROUP BY category
       ORDER BY total DESC`,
      [req.user.property_id, from, to]
    );

    // Revenue and expenses by month in one grouped pass.
    const monthlyRows = await db.all(
      `SELECT month, COALESCE(SUM(revenue), 0) AS revenue, COALESCE(SUM(expense), 0) AS expenses
       FROM (
         SELECT substr(fe.date, 1, 7) AS month, fe.quantity * fe.unit_price AS revenue, 0 AS expense
         FROM folio_entries fe
         JOIN folios f ON fe.folio_id = f.id
         WHERE fe.is_transferred = 0 AND f.property_id = ? AND date(fe.date) BETWEEN date(?) AND date(?)
         UNION ALL
         SELECT substr(COALESCE(settled_at, created_at), 1, 7), subtotal, 0
         FROM restaurant_orders
         WHERE status = 'settled' AND property_id = ?
           AND date(COALESCE(settled_at, created_at)) BETWEEN date(?) AND date(?)
         UNION ALL
         SELECT substr(expense_date, 1, 7), 0, amount
         FROM hotel_expenses
         WHERE status = 'posted' AND property_id = ? AND date(expense_date) BETWEEN date(?) AND date(?)
       )
       GROUP BY month
       ORDER BY month`,
      [req.user.property_id, from, to, req.user.property_id, from, to, req.user.property_id, from, to]
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
       FROM folio_entries fe
       JOIN folios f ON fe.folio_id = f.id
       WHERE fe.tax_rate > 0 AND fe.is_transferred = 0 AND f.property_id = ?
       GROUP BY fe.tax_rate`,
      [req.user.property_id]
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
       WHERE a.property_id = ?
       ORDER BY a.created_at DESC LIMIT 100`,
      [req.user.property_id]
    );
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/reports/performance?from=&to=&format=csv
// Occupancy, ADR, RevPAR, room-type performance, reservation conversion and
// housekeeping/restaurant throughput, all scoped to the authenticated property.
router.get('/performance', authenticateToken, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
    const from = validDate(req.query.from) ? req.query.from : `${today.slice(0, 7)}-01`;
    const to = validDate(req.query.to) ? req.query.to : today;
    const propertyId = req.user.property_id;
    const days = Math.max(1, Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1);

    const rooms = await db.get('SELECT COUNT(*) AS total FROM rooms WHERE property_id = ?', [propertyId]);
    const totalRooms = Number(rooms.total) || 0;

    const roomRevenue = await db.get(
      `SELECT COALESCE(SUM(fe.quantity * fe.unit_price), 0) AS net,
              COALESCE(SUM(fe.tax_amount), 0) AS tax,
              COALESCE(SUM(fe.total_amount), 0) AS gross
       FROM folio_entries fe
       JOIN folios f ON fe.folio_id = f.id
       WHERE f.property_id = ? AND fe.department = 'room_rent'
         AND date(fe.date) BETWEEN date(?) AND date(?)`,
      [propertyId, from, to]
    );

    const roomNights = await db.get(
      `SELECT COALESCE(SUM(
          MAX(0, MIN(julianday(date(s.expected_check_out)), julianday(date(?)) + 1)
                 - MAX(julianday(date(s.check_in_time)), julianday(date(?))))), 0) AS nights
       FROM stays s
       WHERE s.property_id = ?
         AND date(s.check_in_time) <= date(?)
         AND date(s.expected_check_out) >= date(?)`,
      [to, from, propertyId, to, from]
    );

    const restaurant = await db.get(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total_amount), 0) AS gross,
              COALESCE(SUM(subtotal), 0) AS net, COALESCE(SUM(tax_amount), 0) AS tax
       FROM restaurant_orders
       WHERE property_id = ? AND status IN ('settled','posted_to_room')
         AND date(COALESCE(settled_at, created_at)) BETWEEN date(?) AND date(?)`,
      [propertyId, from, to]
    );

    const reservations = await db.all(
      `SELECT status, COUNT(*) AS count FROM reservations
       WHERE property_id = ? AND date(created_at) BETWEEN date(?) AND date(?)
       GROUP BY status`,
      [propertyId, from, to]
    );
    const reservationTotal = reservations.reduce((sum, row) => sum + Number(row.count), 0) || 0;
    const reservationCount = (statuses) => reservations
      .filter(row => statuses.includes(row.status))
      .reduce((sum, row) => sum + Number(row.count), 0);

    const roomTypePerformance = await db.all(
      `SELECT rt.name AS room_type, COUNT(DISTINCT s.id) AS stays,
              COALESCE(SUM(fe.quantity * fe.unit_price), 0) AS net_revenue
       FROM stays s
       JOIN rooms r ON s.room_id = r.id
       JOIN room_types rt ON r.room_type_id = rt.id
       LEFT JOIN folios f ON f.stay_id = s.id
       LEFT JOIN folio_entries fe ON fe.folio_id = f.id AND fe.department = 'room_rent'
         AND date(fe.date) BETWEEN date(?) AND date(?)
       WHERE s.property_id = ?
         AND date(s.check_in_time) <= date(?) AND date(s.expected_check_out) >= date(?)
       GROUP BY rt.id, rt.name
       ORDER BY net_revenue DESC`,
      [from, to, propertyId, to, from]
    );

    const housekeeping = await db.get(
      `SELECT COUNT(*) AS tasks,
              SUM(CASE WHEN status IN ('cleaned','inspected','ready') THEN 1 ELSE 0 END) AS completed,
              AVG(CASE WHEN completed_at IS NOT NULL
                       THEN (julianday(completed_at) - julianday(created_at)) * 24 * 60 END) AS avg_minutes
       FROM housekeeping_tasks
       WHERE property_id = ? AND date(created_at) BETWEEN date(?) AND date(?)`,
      [propertyId, from, to]
    );

    const guestRequests = await db.get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
       FROM guest_requests
       WHERE property_id = ? AND date(created_at) BETWEEN date(?) AND date(?)`,
      [propertyId, from, to]
    );

    const availableRoomNights = totalRooms * days;
    const soldRoomNights = Math.max(0, Number(roomNights.nights) || 0);
    const netRoomRevenue = round2(roomRevenue.net);
    const occupancy = availableRoomNights > 0 ? soldRoomNights / availableRoomNights : 0;
    const adr = soldRoomNights > 0 ? netRoomRevenue / soldRoomNights : 0;
    const revpar = availableRoomNights > 0 ? netRoomRevenue / availableRoomNights : 0;
    const restaurantOrders = Number(restaurant.orders) || 0;

    const payload = {
      success: true,
      from,
      to,
      days,
      occupancy: {
        total_rooms: totalRooms,
        available_room_nights: availableRoomNights,
        occupied_room_nights: soldRoomNights,
        occupancy_percentage: round2(occupancy * 100)
      },
      rates: {
        adr: round2(adr),
        revpar: round2(revpar),
        room_revenue_net: netRoomRevenue,
        room_tax: round2(roomRevenue.tax),
        room_revenue_gross: round2(roomRevenue.gross)
      },
      restaurant: {
        orders: restaurantOrders,
        net_sales: round2(restaurant.net),
        tax: round2(restaurant.tax),
        gross_sales: round2(restaurant.gross),
        average_order_value: restaurantOrders ? round2(Number(restaurant.gross) / restaurantOrders) : 0
      },
      reservations: {
        created: reservationTotal,
        confirmed_or_stayed: reservationCount(['confirmed', 'partially_paid', 'fully_prepaid', 'checked_in', 'checked_out']),
        cancelled: reservationCount(['cancelled']),
        no_show: reservationCount(['no_show']),
        conversion_rate: reservationTotal ? round2((reservationCount(['checked_in', 'checked_out']) / reservationTotal) * 100) : 0,
        cancellation_rate: reservationTotal ? round2((reservationCount(['cancelled']) / reservationTotal) * 100) : 0,
        no_show_rate: reservationTotal ? round2((reservationCount(['no_show']) / reservationTotal) * 100) : 0
      },
      room_types: roomTypePerformance.map(row => ({
        room_type: row.room_type,
        stays: Number(row.stays),
        net_revenue: round2(row.net_revenue)
      })),
      housekeeping: {
        tasks: Number(housekeeping.tasks) || 0,
        completed: Number(housekeeping.completed) || 0,
        average_minutes: housekeeping.avg_minutes ? round2(housekeeping.avg_minutes) : null
      },
      guest_requests: {
        total: Number(guestRequests.total) || 0,
        completed: Number(guestRequests.completed) || 0
      },
      notes: ['Kitchen preparation time requires per-ticket ready timestamps and is not reported here.']
    };

    if (String(req.query.format || '').toLowerCase() === 'csv') {
      const lines = [
        'metric,value',
        `from,${from}`,
        `to,${to}`,
        `total_rooms,${totalRooms}`,
        `available_room_nights,${availableRoomNights}`,
        `occupied_room_nights,${soldRoomNights}`,
        `occupancy_percentage,${payload.occupancy.occupancy_percentage}`,
        `adr,${payload.rates.adr}`,
        `revpar,${payload.rates.revpar}`,
        `room_revenue_net,${payload.rates.room_revenue_net}`,
        `restaurant_orders,${restaurantOrders}`,
        `restaurant_gross_sales,${payload.restaurant.gross_sales}`,
        `housekeeping_tasks,${payload.housekeeping.tasks}`,
        `guest_requests,${payload.guest_requests.total}`
      ];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="hotel-performance-${from}-to-${to}.csv"`);
      return res.send(lines.join('\n'));
    }

    res.json(payload);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
