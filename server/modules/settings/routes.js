const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const {
  normalizeSmtpConfig,
  describeSmtpError,
  verifySmtp,
  sendMail
} = require('../../services/mailer');
const db = require('../../config/database');
const { authenticateToken, requireRoles } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');

// GET /api/v1/settings
// Returns all operational and integration settings
router.get('/', authenticateToken, requireRoles('admin', 'general_manager'), async (req, res) => {
  try {
    const property = await db.get('SELECT * FROM properties WHERE id = ?', [req.user.property_id]);
    if (!property) return res.status(404).json({ success: false, error: 'Property not found' });

    const smtpRow = await db.get("SELECT setting_value FROM system_settings WHERE setting_key = 'smtp_config'");
    let smtp = smtpRow ? JSON.parse(smtpRow.setting_value) : { host: '', port: 587, secure: false, user: '', pass: '', from_email: '' };
    // Mask password in response
    if (smtp.pass) smtp.pass = '••••••••';

    const gdriveRow = await db.get("SELECT setting_value FROM system_settings WHERE setting_key = 'gdrive_config'");
    const gdrive = gdriveRow ? JSON.parse(gdriveRow.setting_value) : { enabled: false, folder_id: '', last_sync: null };

    res.json({
      success: true,
      property,
      smtp,
      gdrive
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/v1/settings/property
// Update Hotel Profile, Bank, UPI, and Tax configuration
router.patch('/property', authenticateToken, requireRoles('admin'), async (req, res) => {
  try {
    const {
      name, gstin, address, city, state, country, phone, email,
      currency, currency_symbol, checkin_time, checkout_time,
      bank_name, bank_account_number, bank_ifsc, bank_branch,
      upi_id, upi_name, default_room_tax_rate, default_restaurant_tax_rate,
      require_advance_for_confirmation, advance_percentage, advance_due_days, invoice_prefix,
      phone_country_code,
      restaurant_tax_enabled, local_tax_enabled, local_tax_name, local_tax_amount,
      local_tax_max_guests, local_tax_start_date, local_tax_end_date, rounding_enabled,
      room_qr_enabled, guest_portal_enabled, guest_order_enabled, guest_bill_enabled,
      guest_service_enabled, guest_help_enabled, lan_guest_url, wifi_instructions,
      wifi_name, wifi_password,
      reception_contact, emergency_contact,
      room_assignment_mode, auto_assign_on_booking, auto_assign_on_checkin,
      require_inspected_for_checkin
    } = req.body;

    const prop = await db.get('SELECT * FROM properties WHERE id = ?', [req.user.property_id]);
    if (!prop) return res.status(404).json({ success: false, error: 'Property not found for this property' });

    // Strict validation of tax and guest configuration.
    for (const [label, value] of [['Room GST', default_room_tax_rate], ['Restaurant GST', default_restaurant_tax_rate]]) {
      if (value !== undefined && (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 28)) {
        return res.status(400).json({ success: false, error: `${label} must be between 0 and 28 percent` });
      }
    }
    if (local_tax_amount !== undefined && (!Number.isFinite(Number(local_tax_amount)) || Number(local_tax_amount) < 0)) {
      return res.status(400).json({ success: false, error: 'Local tax amount must be zero or greater' });
    }
    if (local_tax_max_guests !== undefined && (!Number.isInteger(Number(local_tax_max_guests)) || Number(local_tax_max_guests) < 0)) {
      return res.status(400).json({ success: false, error: 'Eligible guest count must be a whole number of zero or more' });
    }
    for (const [label, value] of [['Local tax start date', local_tax_start_date], ['Local tax end date', local_tax_end_date]]) {
      if (value && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
        return res.status(400).json({ success: false, error: `${label} must be a valid date` });
      }
    }
    if (room_assignment_mode !== undefined && !['auto', 'manual'].includes(String(room_assignment_mode))) {
      return res.status(400).json({ success: false, error: 'Room assignment mode must be auto or manual' });
    }
    const normalizedGstin = gstin === undefined ? undefined : String(gstin || '').trim().toUpperCase();
    if (normalizedGstin) {
      if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(normalizedGstin)) {
        return res.status(400).json({ success: false, error: 'GSTIN must be a valid 15-character Indian GST number, e.g. 29AABCN1234F1Z5.' });
      }
    }
    if (lan_guest_url) {
      const url = String(lan_guest_url).trim();
      if (!/^https?:\/\/[^\s/]+/i.test(url)) {
        return res.status(400).json({ success: false, error: 'Guest portal LAN address must start with http:// or https://' });
      }
      if (/^(https?:\/\/)?(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(url) && process.env.NODE_ENV !== 'test' && !process.env.NEXUZY_ALLOW_LOOPBACK_GUEST_URL) {
        return res.status(400).json({ success: false, error: 'Guest portal address must be the private LAN address of this computer, not localhost/127.0.0.1. Use the detected Wi-Fi address and the port shown in Local Network settings.' });
      }
    }

    await db.run(
      `UPDATE properties
       SET name = COALESCE(?, name),
           gstin = COALESCE(?, gstin),
           address = COALESCE(?, address),
           city = COALESCE(?, city),
           state = COALESCE(?, state),
           country = COALESCE(?, country),
           phone = COALESCE(?, phone),
           email = COALESCE(?, email),
           currency = COALESCE(?, currency),
           currency_symbol = COALESCE(?, currency_symbol),
           checkin_time = COALESCE(?, checkin_time),
           checkout_time = COALESCE(?, checkout_time),
           bank_name = COALESCE(?, bank_name),
           bank_account_number = COALESCE(?, bank_account_number),
           bank_ifsc = COALESCE(?, bank_ifsc),
           bank_branch = COALESCE(?, bank_branch),
           upi_id = COALESCE(?, upi_id),
           upi_name = COALESCE(?, upi_name),
           default_room_tax_rate = COALESCE(?, default_room_tax_rate),
           default_restaurant_tax_rate = COALESCE(?, default_restaurant_tax_rate),
           require_advance_for_confirmation = COALESCE(?, require_advance_for_confirmation),
           advance_percentage = COALESCE(?, advance_percentage),
           advance_due_days = COALESCE(?, advance_due_days),
           invoice_prefix = COALESCE(?, invoice_prefix),
           phone_country_code = COALESCE(?, phone_country_code),
           restaurant_tax_enabled = COALESCE(?, restaurant_tax_enabled),
           local_tax_enabled = COALESCE(?, local_tax_enabled),
           local_tax_name = COALESCE(?, local_tax_name),
           local_tax_amount = COALESCE(?, local_tax_amount),
           local_tax_max_guests = COALESCE(?, local_tax_max_guests),
           local_tax_start_date = COALESCE(?, local_tax_start_date),
           local_tax_end_date = COALESCE(?, local_tax_end_date),
           rounding_enabled = COALESCE(?, rounding_enabled),
           room_qr_enabled = COALESCE(?, room_qr_enabled),
           guest_portal_enabled = COALESCE(?, guest_portal_enabled),
           guest_order_enabled = COALESCE(?, guest_order_enabled),
           guest_bill_enabled = COALESCE(?, guest_bill_enabled),
           guest_service_enabled = COALESCE(?, guest_service_enabled),
           guest_help_enabled = COALESCE(?, guest_help_enabled),
           lan_guest_url = COALESCE(?, lan_guest_url),
           wifi_instructions = COALESCE(?, wifi_instructions),
           wifi_name = COALESCE(?, wifi_name),
           wifi_password = COALESCE(?, wifi_password),
           reception_contact = COALESCE(?, reception_contact),
           emergency_contact = COALESCE(?, emergency_contact),
           room_assignment_mode = COALESCE(?, room_assignment_mode),
           auto_assign_on_booking = COALESCE(?, auto_assign_on_booking),
           auto_assign_on_checkin = COALESCE(?, auto_assign_on_checkin),
           require_inspected_for_checkin = COALESCE(?, require_inspected_for_checkin)
       WHERE id = ?`,
      [
        name, normalizedGstin, address, city, state, country, phone, email,
        currency, currency_symbol, checkin_time, checkout_time,
        bank_name, bank_account_number, bank_ifsc, bank_branch,
        upi_id, upi_name, default_room_tax_rate, default_restaurant_tax_rate,
        require_advance_for_confirmation === undefined ? null : (require_advance_for_confirmation ? 1 : 0),
        advance_percentage, advance_due_days, invoice_prefix,
        phone_country_code,
        restaurant_tax_enabled === undefined ? null : (restaurant_tax_enabled ? 1 : 0),
        local_tax_enabled === undefined ? null : (local_tax_enabled ? 1 : 0),
        local_tax_name,
        local_tax_amount === undefined ? null : Number(local_tax_amount),
        local_tax_max_guests === undefined ? null : Number(local_tax_max_guests),
        local_tax_start_date === undefined ? null : (local_tax_start_date || null),
        local_tax_end_date === undefined ? null : (local_tax_end_date || null),
        rounding_enabled === undefined ? null : (rounding_enabled ? 1 : 0),
        room_qr_enabled === undefined ? null : (room_qr_enabled ? 1 : 0),
        guest_portal_enabled === undefined ? null : (guest_portal_enabled ? 1 : 0),
        guest_order_enabled === undefined ? null : (guest_order_enabled ? 1 : 0),
        guest_bill_enabled === undefined ? null : (guest_bill_enabled ? 1 : 0),
        guest_service_enabled === undefined ? null : (guest_service_enabled ? 1 : 0),
        guest_help_enabled === undefined ? null : (guest_help_enabled ? 1 : 0),
        lan_guest_url,
        wifi_instructions,
        wifi_name,
        wifi_password,
        reception_contact,
        emergency_contact,
        room_assignment_mode === undefined ? null : String(room_assignment_mode),
        auto_assign_on_booking === undefined ? null : (auto_assign_on_booking ? 1 : 0),
        auto_assign_on_checkin === undefined ? null : (auto_assign_on_checkin ? 1 : 0),
        require_inspected_for_checkin === undefined ? null : (require_inspected_for_checkin ? 1 : 0),
        prop.id
      ]
    );

    await logAudit({
      propertyId: prop.id,
      userId: req.user.id,
      action: 'UPDATE_HOTEL_SETTINGS',
      entityType: 'property',
      entityId: prop.id,
      details: req.body,
      req
    });

    const updated = await db.get('SELECT * FROM properties WHERE id = ?', [prop.id]);
    res.json({ success: true, message: 'Hotel settings updated successfully', property: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/settings/logo
// Accepts a base64 data URL from the admin's logo file. Images are stored
// beside the database so backups and property moves keep the branding.
router.post('/logo', authenticateToken, requireRoles('admin'), async (req, res) => {
  try {
    const dataUrl = String(req.body.data_url || '');
    const match = dataUrl.match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/);
    if (!match) {
      return res.status(400).json({ success: false, error: 'Upload a PNG, JPG or WebP image file.' });
    }
    const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
    if (!buffer.length) return res.status(400).json({ success: false, error: 'The selected logo file is empty.' });
    if (buffer.length > 1.5 * 1024 * 1024) {
      return res.status(400).json({ success: false, error: 'Logo must be 1.5 MB or smaller. Resize the image and try again.' });
    }

    const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : (match[1].toLowerCase() === 'jpg' ? 'jpg' : match[1].toLowerCase());
    const dataDir = process.env.DB_PATH
      ? path.dirname(process.env.DB_PATH)
      : path.join(__dirname, '..', '..', '..', 'data');
    const uploadDir = path.join(dataDir, 'uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    const filename = `hotel-logo-${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(uploadDir, filename), buffer);

    const prop = await db.get('SELECT id, logo_url FROM properties WHERE id = ?', [req.user.property_id]);
    if (!prop) return res.status(404).json({ success: false, error: 'Property not found' });
    const logoUrl = `/uploads/${filename}`;
    await db.run('UPDATE properties SET logo_url = ? WHERE id = ?', [logoUrl, prop.id]);

    // Remove the previous uploaded logo once the new one is saved.
    if (prop.logo_url && String(prop.logo_url).startsWith('/uploads/')) {
      try { fs.rmSync(path.join(dataDir, String(prop.logo_url).replace(/^\/+/, '')), { force: true }); } catch (err) { /* ignore */ }
    }

    await logAudit({
      propertyId: prop.id,
      userId: req.user.id,
      action: 'UPDATE_HOTEL_LOGO',
      entityType: 'property',
      entityId: prop.id,
      details: { logo_url: logoUrl, bytes: buffer.length },
      req
    });

    res.json({ success: true, message: 'Hotel logo updated. It now appears in the app header and on PDF bills.', logo_url: logoUrl });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/v1/settings/logo — restore the Nexuzy default mark
router.delete('/logo', authenticateToken, requireRoles('admin'), async (req, res) => {
  try {
    const prop = await db.get('SELECT id, logo_url FROM properties WHERE id = ?', [req.user.property_id]);
    if (!prop) return res.status(404).json({ success: false, error: 'Property not found' });
    await db.run("UPDATE properties SET logo_url = '/logo.png' WHERE id = ?", [prop.id]);
    await logAudit({
      propertyId: prop.id,
      userId: req.user.id,
      action: 'RESET_HOTEL_LOGO',
      entityType: 'property',
      entityId: prop.id,
      req
    });
    res.json({ success: true, message: 'Hotel logo reset to the default mark.', logo_url: '/logo.png' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/settings/smtp
router.post('/smtp', authenticateToken, requireRoles('admin'), async (req, res) => {
  try {
    const { host, port = 587, secure = false, user, pass, from_email } = req.body;

    // Retain existing password if masked
    let finalPass = pass;
    if (pass === '••••••••') {
      const existing = await db.get("SELECT setting_value FROM system_settings WHERE setting_key = 'smtp_config'");
      if (existing) {
        finalPass = JSON.parse(existing.setting_value).pass;
      }
    }

    const config = normalizeSmtpConfig({
      host: host || '',
      port: Number(port) || 587,
      secure: Boolean(secure),
      user: user || '',
      pass: finalPass || '',
      from_email: from_email || user || ''
    });

    await db.run(
      `INSERT OR REPLACE INTO system_settings (setting_key, setting_value, updated_at) VALUES ('smtp_config', ?, CURRENT_TIMESTAMP)`,
      [JSON.stringify(config)]
    );

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'UPDATE_SMTP_SETTINGS',
      entityType: 'settings',
      details: { host, port, user },
      req
    });

    const note = config.secure && !secure
      ? ` Port ${config.port} always uses SSL/TLS, so it was enabled automatically.`
      : '';
    res.json({ success: true, message: `SMTP Mail settings saved successfully.${note}`, smtp: config });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/settings/test-email
router.post('/test-email', authenticateToken, requireRoles('admin'), async (req, res) => {
  try {
    const { target_email } = req.body;
    if (!target_email) return res.status(400).json({ success: false, error: 'Recipient target email required' });

    const smtpRow = await db.get("SELECT setting_value FROM system_settings WHERE setting_key = 'smtp_config'");
    if (!smtpRow) {
      return res.status(400).json({ success: false, error: 'Please configure SMTP settings first.' });
    }

    const config = normalizeSmtpConfig(JSON.parse(smtpRow.setting_value));
    if (!config.host || !config.user) {
      return res.status(400).json({ success: false, error: 'SMTP host and username are missing.' });
    }
    if (!config.pass) {
      return res.status(400).json({ success: false, error: 'The SMTP password is missing. Re-enter the mailbox password and save.' });
    }

    // Verify the connection and login first, so a credential or port problem is
    // reported as such instead of as a generic send failure.
    try {
      await verifySmtp(config);
    } catch (err) {
      console.error('Mail verify error:', err);
      return res.status(400).json({
        success: false,
        error: describeSmtpError(err, config),
        smtp: { host: config.host, port: config.port, secure: config.secure },
        detail: err.message
      });
    }

    const prop = await db.get('SELECT name FROM properties WHERE id = ?', [req.user.property_id]);
    const hotelName = prop ? prop.name : 'Nexuzy PMS';

    await sendMail(config, {
      from_name: hotelName,
      to: target_email,
      subject: `Nexuzy PMS - SMTP Test Email (${hotelName})`,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; background: #f8fafc; color: #1e293b;">
          <h2 style="color: #4f46e5;">Nexuzy PMS Email System Connected!</h2>
          <p>This is a verification test email from your property management system.</p>
          <p><strong>Property:</strong> ${hotelName}</p>
          <p><strong>Timestamp:</strong> ${new Date().toLocaleString()}</p>
          <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
          <p style="font-size: 12px; color: #64748b;">Powered by Nexuzy PMS</p>
        </div>
      `
    });

    res.json({
      success: true,
      message: `Test email sent successfully to ${target_email}!`,
      smtp: { host: config.host, port: config.port, secure: config.secure }
    });
  } catch (err) {
    console.error('Mail test error:', err);
    res.status(400).json({ success: false, error: describeSmtpError(err), detail: err.message });
  }
});

// POST /api/v1/settings/gdrive
router.post('/gdrive', authenticateToken, requireRoles('admin'), async (req, res) => {
  try {
    const { folder_id, enabled = true } = req.body;
    const config = {
      folder_id: folder_id || '',
      enabled: Boolean(enabled),
      status: folder_id ? 'Configured' : 'Disabled',
      last_sync: null
    };

    await db.run(
      `INSERT OR REPLACE INTO system_settings (setting_key, setting_value, updated_at) VALUES ('gdrive_config', ?, CURRENT_TIMESTAMP)`,
      [JSON.stringify(config)]
    );

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'UPDATE_GDRIVE_SETTINGS',
      entityType: 'settings',
      details: { folder_id, enabled },
      req
    });

    res.json({ success: true, message: 'Google Drive backup settings saved' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
