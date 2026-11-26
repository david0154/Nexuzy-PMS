// One-shot migration runner for an existing Nexuzy PMS database.
// Usage: npm run migrate
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../config/database');
const { applyMigrations } = require('../config/migrations');

(async () => {
  try {
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await db.exec(schemaSql);
    await applyMigrations();
    const integrity = await db.get('PRAGMA integrity_check');
    console.log('✓ Schema up to date');
    console.log(`✓ Integrity check: ${integrity ? Object.values(integrity)[0] : 'unknown'}`);
    await db.close();
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
})();
