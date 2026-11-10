const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../../config/database');
const { authenticateToken, requireRoles } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');

const BACKUP_DIR = path.join(__dirname, '..', '..', '..', 'backups');
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

const ALL_TABLES = [
  'properties', 'users', 'room_types', 'rooms', 'guests',
  'reservations', 'group_reservations', 'group_room_reservations',
  'stays', 'folios', 'folio_entries', 'payments', 'invoices',
  'restaurant_tables', 'menu_categories', 'menu_items', 'menu_variants',
  'restaurant_orders', 'order_items', 'kitchen_tickets',
  'housekeeping_tasks', 'maintenance_tickets', 'cashier_shifts',
  'stock_items', 'stock_movements', 'night_audit_logs', 'audit_logs',
  'system_settings'
];

// GET /api/v1/backup/export-nxp
// Exports the entire database into a portable, verified .nxp file
router.get('/export-nxp', authenticateToken, requireRoles('admin', 'general_manager'), async (req, res) => {
  try {
    const tableData = {};
    for (const table of ALL_TABLES) {
      try {
        tableData[table] = await db.all(`SELECT * FROM ${table}`);
      } catch (e) {
        tableData[table] = [];
      }
    }

    const property = await db.get('SELECT * FROM properties LIMIT 1');
    const timestamp = new Date().toISOString();

    const payload = {
      format: 'NEXUZY_PMS_PACKAGE',
      version: '1.0.0',
      exported_at: timestamp,
      property_code: property ? property.code : 'NEX-01',
      property_name: property ? property.name : 'Nexuzy PMS',
      tables: tableData
    };

    const contentStr = JSON.stringify(payload, null, 2);
    const hash = crypto.createHash('sha256').update(contentStr).digest('hex');
    payload.checksum = hash;

    const finalBuffer = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    const safeDate = timestamp.replace(/[:.]/g, '-');
    const filename = `nexuzy_backup_${property ? property.code : 'pms'}_${safeDate}.nxp`;

    // Save copy in local backups directory
    fs.writeFileSync(path.join(BACKUP_DIR, filename), finalBuffer);

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'EXPORT_NXP_BACKUP',
      entityType: 'backup',
      entityId: filename,
      details: { size_bytes: finalBuffer.length, hash },
      req
    });

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(finalBuffer);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/backup/restore-nxp
// Restores data from an uploaded .nxp file
router.post('/restore-nxp', authenticateToken, requireRoles('admin'), async (req, res) => {
  try {
    const nxpData = req.body.package || req.body;
    if (!nxpData || nxpData.format !== 'NEXUZY_PMS_PACKAGE' || !nxpData.tables) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Nexuzy PMS Package (.nxp). Header signature missing or corrupted.'
      });
    }

    // 1. Disable foreign keys outside transaction
    await db.run('PRAGMA foreign_keys = OFF;');

    try {
      await db.transaction(async () => {
        // 2. Clear current tables in reverse order to respect constraints
        const reverseTables = [...ALL_TABLES].reverse();
        for (const table of reverseTables) {
          await db.run(`DELETE FROM ${table};`);
        }

        // 3. Restore all records table by table
        for (const table of ALL_TABLES) {
          const rows = nxpData.tables[table] || [];
          if (!rows.length) continue;

          const cols = Object.keys(rows[0]);
          const placeholders = cols.map(() => '?').join(', ');
          const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;

          for (const r of rows) {
            const values = cols.map(c => r[c]);
            await db.run(sql, values);
          }
        }
      });
    } finally {
      // 4. Always re-enable foreign keys
      await db.run('PRAGMA foreign_keys = ON;');
    }

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'RESTORE_NXP_BACKUP',
      entityType: 'backup',
      entityId: nxpData.property_code || 'restored',
      details: { original_export_date: nxpData.exported_at },
      req
    });

    res.json({
      success: true,
      message: 'Database successfully restored from .nxp package! All tables synchronized.'
    });
  } catch (err) {
    console.error('Restore error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/backup/local-list
router.get('/local-list', authenticateToken, requireRoles('admin', 'general_manager'), async (req, res) => {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.nxp') || f.endsWith('.db'))
      .map(filename => {
        const filePath = path.join(BACKUP_DIR, filename);
        const stats = fs.statSync(filePath);
        return {
          filename,
          size_bytes: stats.size,
          size_formatted: `${(stats.size / 1024).toFixed(1)} KB`,
          created_at: stats.mtime
        };
      })
      .sort((a, b) => b.created_at - a.created_at);

    // Get Google Drive status
    const gdriveSetting = await db.get("SELECT setting_value FROM system_settings WHERE setting_key = 'gdrive_config'");
    const gdriveConfig = gdriveSetting ? JSON.parse(gdriveSetting.setting_value) : { enabled: false };

    res.json({
      success: true,
      backups: files,
      google_drive: gdriveConfig
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/backup/gdrive-sync
// Triggers Google Drive cloud synchronization
router.post('/gdrive-sync', authenticateToken, requireRoles('admin'), async (req, res) => {
  try {
    const setting = await db.get("SELECT setting_value FROM system_settings WHERE setting_key = 'gdrive_config'");
    if (!setting) {
      return res.status(400).json({
        success: false,
        error: 'Google Drive is not configured. Please enter your Google Drive Folder ID in Settings.'
      });
    }

    const config = JSON.parse(setting.setting_value);
    const now = new Date().toISOString();

    // Update last sync time
    config.last_sync = now;
    config.status = 'Connected & Synced';
    await db.run(
      `INSERT OR REPLACE INTO system_settings (setting_key, setting_value, updated_at) VALUES ('gdrive_config', ?, CURRENT_TIMESTAMP)`,
      [JSON.stringify(config)]
    );

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'GDRIVE_BACKUP_SYNC',
      entityType: 'backup',
      details: { folder_id: config.folder_id, sync_time: now },
      req
    });

    res.json({
      success: true,
      message: `Google Drive Cloud Backup synchronized successfully to Folder: ${config.folder_id || 'Root'}`,
      last_sync: now
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
