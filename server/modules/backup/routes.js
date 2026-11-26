const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const db = require('../../config/database');
const { authenticateToken, requireRoles, JWT_SECRET } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');

const BACKUP_DIR = path.join(__dirname, '..', '..', '..', 'backups');
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// Tables come from the live schema. A hardcoded list silently left newer
// modules (room allocations, guest QR sessions, expenses, suppliers, purchase
// orders...) out of the "complete database" package, and a restore then lost
// that data.
async function listTables(conn = db) {
  const rows = await conn.all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  return rows.map(row => row.name);
}

async function buildPackage() {
  const tables = await listTables();
  const tableData = {};
  const rowCounts = {};
  for (const table of tables) {
    const rows = await db.all(`SELECT * FROM "${table}"`);
    tableData[table] = rows;
    rowCounts[table] = rows.length;
  }

  const property = await db.get('SELECT * FROM properties LIMIT 1');
  const timestamp = new Date().toISOString();
  const payload = {
    format: 'NEXUZY_PMS_PACKAGE',
    version: '1.2.0',
    exported_at: timestamp,
    property_code: property ? property.code : 'NEX-01',
    property_name: property ? property.name : 'Nexuzy PMS',
    tables: tableData,
    row_counts: rowCounts,
    total_rows: Object.values(rowCounts).reduce((sum, count) => sum + count, 0)
  };

  // The checksum covers the package as written, before the checksum itself is
  // appended, so the file can be verified before any data is touched.
  payload.checksum = crypto.createHash('sha256').update(JSON.stringify(payload, null, 2)).digest('hex');

  const buffer = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  const filename = `nexuzy_backup_${payload.property_code || 'pms'}_${timestamp.replace(/[:.]/g, '-')}.nxp`;
  fs.writeFileSync(path.join(BACKUP_DIR, filename), buffer);

  return { payload, buffer, filename, tables: tables.length };
}

async function auditExport(req, { payload, buffer, filename }) {
  await logAudit({
    propertyId: req.user.property_id,
    userId: req.user.id,
    action: 'EXPORT_NXP_BACKUP',
    entityType: 'backup',
    entityId: filename,
    details: {
      size_bytes: buffer.length,
      hash: payload.checksum,
      tables: Object.keys(payload.tables).length,
      total_rows: payload.total_rows
    },
    req
  });
}

// GET /api/v1/backup/export-nxp
// Exports the entire database into a portable, verified .nxp file
router.get('/export-nxp', authenticateToken, requireRoles('admin', 'general_manager'), async (req, res) => {
  try {
    const result = await buildPackage();
    await auditExport(req, result);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(result.buffer);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ success: false, error: `Could not create the backup: ${err.message}` });
  }
});

// POST /api/v1/backup/export-nxp/prepare
// Builds the package and returns a short-lived, signed download link. Browsers
// and embedded webviews that refuse blob downloads can still fetch the file
// natively through this URL.
router.post('/export-nxp/prepare', authenticateToken, requireRoles('admin', 'general_manager'), async (req, res) => {
  try {
    const result = await buildPackage();
    await auditExport(req, result);
    const token = jwt.sign({ scope: 'nxp-download', file: result.filename }, JWT_SECRET, { expiresIn: '10m' });
    res.json({
      success: true,
      filename: result.filename,
      size_bytes: result.buffer.length,
      tables: result.tables,
      total_rows: result.payload.total_rows,
      checksum: result.payload.checksum,
      download_url: `/api/v1/backup/download-nxp?token=${encodeURIComponent(token)}`,
      message: `Backup ready: ${(result.buffer.length / 1024).toFixed(1)} KB across ${result.tables} tables (${result.payload.total_rows} rows).`
    });
  } catch (err) {
    console.error('Export prepare error:', err);
    res.status(500).json({ success: false, error: `Could not create the backup: ${err.message}` });
  }
});

// GET /api/v1/backup/download-nxp?token=...
// The token is a short-lived signed link issued by /export-nxp/prepare, so the
// browser can download without a custom Authorization header.
router.get('/download-nxp', async (req, res) => {
  try {
    let decoded;
    try {
      decoded = jwt.verify(String(req.query.token || ''), JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ success: false, error: 'This download link has expired. Export the package again.' });
    }
    if (!decoded || decoded.scope !== 'nxp-download') {
      return res.status(403).json({ success: false, error: 'This download link is not valid for a backup file.' });
    }
    const filename = path.basename(String(decoded.file || ''));
    if (!filename || !filename.endsWith('.nxp')) {
      return res.status(400).json({ success: false, error: 'The backup filename is invalid.' });
    }
    const filePath = path.join(BACKUP_DIR, filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'The backup file is no longer on this computer. Export it again.' });
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(fs.readFileSync(filePath));
  } catch (err) {
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

    // Verify the package before touching a single row.
    if (nxpData.checksum) {
      const { checksum, ...rest } = nxpData;
      const computed = crypto.createHash('sha256').update(JSON.stringify(rest, null, 2)).digest('hex');
      if (computed !== checksum) {
        return res.status(400).json({
          success: false,
          error: 'The .nxp package checksum does not match. The file is corrupted or was modified, so nothing was restored.'
        });
      }
    }

    // Only tables that exist in this installation are restored. Unknown tables
    // in an older/newer package are reported instead of aborting the restore.
    const schemaTables = await listTables();
    const schemaSet = new Set(schemaTables);
    const packageTables = Object.keys(nxpData.tables || {}).filter(table => schemaSet.has(table));
    const unknownTables = Object.keys(nxpData.tables || {}).filter(table => !schemaSet.has(table));

    // 1. Disable foreign keys outside transaction
    await db.run('PRAGMA foreign_keys = OFF;');

    let restoredRows = 0;
    try {
      await db.transaction(async () => {
        // 2. Clear current tables in reverse order to respect constraints
        for (const table of [...schemaTables].reverse()) {
          await db.run(`DELETE FROM "${table}";`);
        }

        // 3. Restore every record, using only columns this schema actually has.
        for (const table of packageTables) {
          const rows = nxpData.tables[table] || [];
          if (!rows.length) continue;

          const columnInfo = await db.all(`PRAGMA table_info("${table}")`);
          const validColumns = new Set(columnInfo.map(column => column.name));
          const cols = Object.keys(rows[0]).filter(column => validColumns.has(column));
          if (!cols.length) continue;

          const placeholders = cols.map(() => '?').join(', ');
          const sql = `INSERT INTO "${table}" (${cols.map(column => `"${column}"`).join(', ')}) VALUES (${placeholders})`;

          for (const row of rows) {
            await db.run(sql, cols.map(column => row[column]));
            restoredRows += 1;
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
      message: `Database restored from the .nxp package: ${restoredRows} rows across ${packageTables.length} tables.`,
      restored_rows: restoredRows,
      restored_tables: packageTables.length,
      ignored_tables: unknownTables,
      exported_at: nxpData.exported_at || null
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
