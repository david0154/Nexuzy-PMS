const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const db = require('../../config/database');
const { authenticateToken, requireRoles } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');

// GET /api/v1/settings
// Returns all operational and integration settings
router.get('/', authenticateToken, requireRoles('admin', 'general_manager'), async (req, res) => {
  try {
    const property = await db.get('SELECT * FROM properties LIMIT 1');

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
      phone_country_code
    } = req.body;

    const prop = await db.get('SELECT id FROM properties LIMIT 1');
    if (!prop) return res.status(404).json({ success: false, error: 'Property not found' });

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
           phone_country_code = COALESCE(?, phone_country_code)
       WHERE id = ?`,
      [
        name, gstin, address, city, state, country, phone, email,
        currency, currency_symbol, checkin_time, checkout_time,
        bank_name, bank_account_number, bank_ifsc, bank_branch,
        upi_id, upi_name, default_room_tax_rate, default_restaurant_tax_rate,
        require_advance_for_confirmation === undefined ? null : (require_advance_for_confirmation ? 1 : 0),
        advance_percentage, advance_due_days, invoice_prefix,
        phone_country_code,
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

    const prop = await db.get('SELECT id, logo_url FROM properties LIMIT 1');
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
    const prop = await db.get('SELECT id, logo_url FROM properties LIMIT 1');
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

    const config = {
      host: host || '',
      port: Number(port) || 587,
      secure: Boolean(secure),
      user: user || '',
      pass: finalPass || '',
      from_email: from_email || user || ''
    };

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

    res.json({ success: true, message: 'SMTP Mail settings saved successfully' });
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

    const config = JSON.parse(smtpRow.setting_value);
    if (!config.host || !config.user) {
      return res.status(400).json({ success: false, error: 'SMTP host and username are missing.' });
    }

    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.user,
        pass: config.pass
      }
    });

    const prop = await db.get('SELECT name FROM properties LIMIT 1');
    const hotelName = prop ? prop.name : 'Nexuzy PMS';

    await transporter.sendMail({
      from: `"${hotelName}" <${config.from_email || config.user}>`,
      to: target_email,
      subject: `Nexuzy PMS - SMTP Test Email (${hotelName})`,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; background: #f8fafc; color: #1e293b;">
          <h2 style="color: #4f46e5;">Nexuzy PMS Email System Connected!</h2>
          <p>This is a verification test email from your property management system.</p>
          <p><strong>Property:</strong> ${hotelName}</p>
          <p><strong>Timestamp:</strong> ${new Date().toLocaleString()}</p>
          <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
          <p style="font-size: 12px; color: #64748b;">Powered by Nexuzy PMS &middot; Nexuzy Lab</p>
        </div>
      `
    });

    res.json({ success: true, message: `Test email sent successfully to ${target_email}!` });
  } catch (err) {
    console.error('Mail test error:', err);
    res.status(500).json({ success: false, error: `SMTP Failed: ${err.message}` });
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
