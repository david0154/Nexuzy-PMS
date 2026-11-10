const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const { authenticateToken } = require('../../middleware/auth');

// GET /api/v1/reports/dashboard
router.get('/dashboard', authenticateToken, async (req, res) => {
  try {
    const prop = await db.get('SELECT * FROM properties WHERE id = ?', [req.user.property_id]);
    const bizDate = prop ? prop.business_date : new Date().toISOString().slice(0, 10);

    // Total rooms count
    const totalRooms = (await db.get('SELECT COUNT(*) as count FROM rooms')).count;

    // Room status counts
    const roomCounts = await db.all(
      `SELECT operational_status, housekeeping_status, COUNT(*) as count 
       FROM rooms 
       GROUP BY operational_status, housekeeping_status`
    );

    const occupiedRooms = (await db.get("SELECT COUNT(*) as count FROM rooms WHERE operational_status = 'occupied'")).count;
    const dirtyRooms = (await db.get("SELECT COUNT(*) as count FROM rooms WHERE housekeeping_status = 'dirty'")).count;
    const cleanRooms = (await db.get("SELECT COUNT(*) as count FROM rooms WHERE housekeeping_status IN ('clean', 'inspected')")).count;
    const oooRooms = (await db.get("SELECT COUNT(*) as count FROM rooms WHERE operational_status = 'out_of_order'")).count;
    const availableRooms = totalRooms - occupiedRooms - oooRooms;

    const occupancyRate = totalRooms > 0 ? Math.round((occupiedRooms / totalRooms) * 100) : 0;

    // In-house guests
    const inHouseCount = (await db.get("SELECT COUNT(*) as count FROM stays WHERE status = 'occupied'")).count;

    // Today's arrivals & departures
    const arrivalsCount = (await db.get("SELECT COUNT(*) as count FROM reservations WHERE check_in_date = ? AND status = 'confirmed'", [bizDate])).count;
    const departuresCount = (await db.get("SELECT COUNT(*) as count FROM stays WHERE expected_check_out = ? AND status = 'occupied'", [bizDate])).count;

    // Restaurant active tables & open KOTs
    const activeTables = (await db.get("SELECT COUNT(*) as count FROM restaurant_tables WHERE status = 'occupied'")).count;
    const openKots = (await db.get("SELECT COUNT(*) as count FROM kitchen_tickets WHERE status IN ('new', 'preparing')")).count;

    // Unpaid Folios total
    const unpaidFolios = await db.get("SELECT SUM(balance) as total_unpaid FROM folios WHERE balance > 0");

    // Total Collections Today (Payments)
    const todayPayments = await db.get(
      "SELECT SUM(amount) as total FROM payments WHERE date(created_at) = date('now')"
    );

    // Active Groups
    const activeGroups = (await db.get("SELECT COUNT(*) as count FROM group_reservations WHERE status IN ('confirmed', 'partially_checked_in', 'fully_checked_in', 'partially_checked_out')")).count;

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
        total_collections_today: todayPayments.total || 0,
        outstanding_folios_total: unpaidFolios.total_unpaid || 0
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
