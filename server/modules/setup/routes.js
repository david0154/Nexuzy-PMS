const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const { JWT_SECRET } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');

// GET /api/v1/setup/status
// Checks if the PMS is initialized or needs first-time setup
router.get('/status', async (req, res) => {
  try {
    const propCount = await db.get('SELECT COUNT(*) as count FROM properties');
    const initialized = propCount && propCount.count > 0;

    let property = null;
    if (initialized) {
      property = await db.get('SELECT id, name, code, gstin, address, phone, email, currency, currency_symbol, business_date, logo_url, bank_name, upi_id FROM properties LIMIT 1');
    }

    res.json({
      success: true,
      initialized,
      property
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/setup/initialize
// First-time production setup (No demo data)
router.post('/initialize', async (req, res) => {
  try {
    const existing = await db.get('SELECT COUNT(*) as count FROM properties');
    if (existing && existing.count > 0) {
      return res.status(400).json({
        success: false,
        error: 'System is already initialized. Please log in or use the Settings module.'
      });
    }

    const {
      hotel_name,
      hotel_code,
      gstin,
      address,
      city,
      state,
      country = 'India',
      phone,
      email,
      currency = 'INR',
      currency_symbol = '₹',
      timezone = 'Asia/Kolkata',
      bank_name,
      bank_account_number,
      bank_ifsc,
      bank_branch,
      upi_id,
      upi_name,
      default_room_tax_rate = 12.0,
      default_restaurant_tax_rate = 5.0,
      admin_full_name,
      admin_username,
      admin_email,
      admin_password
    } = req.body;

    if (!hotel_name || !phone || !admin_username || !admin_password || !admin_full_name) {
      return res.status(400).json({
        success: false,
        error: 'Hotel name, contact phone, admin full name, username and password are required.'
      });
    }

    const propId = `prop-${uuidv4().slice(0, 8)}`;
    const propCode = hotel_code ? hotel_code.toUpperCase().trim() : hotel_name.slice(0, 3).toUpperCase() + '-01';
    const today = new Date().toISOString().slice(0, 10);

    const adminId = uuidv4();
    const passwordHash = await bcrypt.hash(admin_password, 10);

    await db.transaction(async () => {
      // 1. Insert Property
      await db.run(
        `INSERT INTO properties 
         (id, name, code, gstin, address, city, state, country, phone, email, currency, currency_symbol, timezone, business_date, bank_name, bank_account_number, bank_ifsc, bank_branch, upi_id, upi_name, default_room_tax_rate, default_restaurant_tax_rate, logo_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '/logo.png')`,
        [
          propId,
          hotel_name,
          propCode,
          gstin || null,
          address || null,
          city || null,
          state || null,
          country,
          phone,
          email || null,
          currency,
          currency_symbol,
          timezone,
          today,
          bank_name || null,
          bank_account_number || null,
          bank_ifsc || null,
          bank_branch || null,
          upi_id || null,
          upi_name || null,
          Number(default_room_tax_rate) || 12.0,
          Number(default_restaurant_tax_rate) || 5.0
        ]
      );

      // 2. Insert Super Admin User
      await db.run(
        `INSERT INTO users (id, property_id, username, password_hash, full_name, email, role, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 'admin', 1)`,
        [adminId, propId, admin_username, passwordHash, admin_full_name, admin_email || email || null]
      );

      // 3. Insert baseline starter room types
      const rt1 = uuidv4();
      const rt2 = uuidv4();
      await db.run(
        `INSERT INTO room_types (id, property_id, name, code, base_rate, max_occupancy, extra_adult_rate, tax_rate, hsn_sac)
         VALUES 
         (?, ?, 'Standard Room', 'STD', 2000, 2, 500, ?, '996311'),
         (?, ?, 'Deluxe Suite', 'DLX', 3500, 3, 750, ?, '996311')`,
        [rt1, propId, Number(default_room_tax_rate) || 12.0, rt2, propId, Number(default_room_tax_rate) || 12.0]
      );

      // 4. Insert baseline starter restaurant categories
      const cat1 = uuidv4();
      const cat2 = uuidv4();
      await db.run(
        `INSERT INTO menu_categories (id, property_id, name, display_order)
         VALUES (?, ?, 'Food & Dining', 1), (?, ?, 'Beverages', 2)`,
        [cat1, propId, cat2, propId]
      );

      // 5. Insert starter tables
      await db.run(
        `INSERT INTO restaurant_tables (id, property_id, table_number, capacity, section, status)
         VALUES 
         (?, ?, 'T-01', 4, 'Main Hall', 'available'),
         (?, ?, 'T-02', 4, 'Main Hall', 'available'),
         (?, ?, 'T-03', 2, 'Main Hall', 'available')`,
        [uuidv4(), propId, uuidv4(), propId, uuidv4(), propId]
      );
    });

    const token = jwt.sign(
      { id: adminId, username: admin_username, full_name: admin_full_name, role: 'admin', property_id: propId },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    await logAudit({
      propertyId: propId,
      userId: adminId,
      action: 'FIRST_TIME_SETUP_INITIALIZED',
      entityType: 'property',
      entityId: propId,
      details: { hotel_name, admin_username }
    });

    res.json({
      success: true,
      message: 'Nexuzy PMS initialized successfully! Welcome to your property.',
      token,
      user: {
        id: adminId,
        username: admin_username,
        full_name: admin_full_name,
        role: 'admin',
        property_id: propId
      },
      property: {
        id: propId,
        name: hotel_name,
        code: propCode,
        business_date: today,
        currency,
        currency_symbol
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
