const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'nexuzy.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let dbInstance = null;

function getDb() {
  if (!dbInstance) {
    dbInstance = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error('Failed to connect to SQLite database:', err.message);
      } else {
        console.log(`Connected to SQLite database at ${DB_PATH}`);
      }
    });

    // Enable WAL mode, foreign keys and a busy timeout so concurrent LAN
    // clients queue for the single SQLite writer instead of failing.
    dbInstance.run('PRAGMA journal_mode = WAL;');
    dbInstance.run('PRAGMA foreign_keys = ON;');
    dbInstance.run('PRAGMA busy_timeout = 5000;');
  }
  return dbInstance;
}

// Async promise helpers
const db = {
  get: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      getDb().get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  },

  all: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      getDb().all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  },

  run: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      getDb().run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  },

  exec: (sql) => {
    return new Promise((resolve, reject) => {
      getDb().exec(sql, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  },

  // Transaction helper. BEGIN IMMEDIATE takes the write lock up front, which
  // prevents two LAN devices from both reading a sequence/balance and then
  // racing to write inconsistent financial records.
  async transaction(callback) {
    await db.run('BEGIN IMMEDIATE TRANSACTION');
    try {
      const result = await callback(db);
      await db.run('COMMIT');
      return result;
    } catch (error) {
      try {
        await db.run('ROLLBACK');
      } catch (rollbackError) {
        console.error('Transaction rollback failed:', rollbackError.message);
      }
      throw error;
    }
  },

  close: () => {
    return new Promise((resolve, reject) => {
      if (dbInstance) {
        dbInstance.close((err) => {
          if (err) reject(err);
          else {
            dbInstance = null;
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }
};

module.exports = db;
