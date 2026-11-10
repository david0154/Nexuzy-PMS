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

    // Enable WAL mode & foreign keys for high performance and integrity
    dbInstance.run('PRAGMA journal_mode = WAL;');
    dbInstance.run('PRAGMA foreign_keys = ON;');
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

  // Transaction helper
  async transaction(callback) {
    await db.run('BEGIN TRANSACTION');
    try {
      const result = await callback(db);
      await db.run('COMMIT');
      return result;
    } catch (error) {
      await db.run('ROLLBACK');
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
