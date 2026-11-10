require('dotenv').config();
const fs = require('fs');
const path = require('path');
const app = require('./app');
const db = require('./config/database');

const PORT = process.env.PORT || 5000;

async function bootstrap() {
  try {
    console.log('Starting Nexuzy PMS Server...');

    // 1. Ensure database schema is initialized
    const schemaPath = path.join(__dirname, 'db', 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await db.exec(schemaSql);

    // 2. Check if property is initialized
    const prop = await db.get('SELECT name, code FROM properties LIMIT 1');

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`=======================================================`);
      console.log(`  Nexuzy PMS is running at http://localhost:${PORT}`);
      console.log(`  Local Network Access: http://0.0.0.0:${PORT}`);
      console.log(`  API Base: http://localhost:${PORT}/api/v1`);
      if (prop) {
        console.log(`  Active Property: ${prop.name} (${prop.code})`);
      } else {
        console.log(`  Status: FIRST-TIME SETUP REQUIRED`);
        console.log(`  Open http://localhost:${PORT} to configure your hotel`);
      }
      console.log(`=======================================================`);
    });
  } catch (err) {
    console.error('Fatal initialization error:', err);
    process.exit(1);
  }
}

bootstrap();
