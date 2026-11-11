require('dotenv').config();
const fs = require('fs');
const path = require('path');
const app = require('./app');
const db = require('./config/database');
const { applyMigrations } = require('./config/migrations');
const network = require('./modules/network/service');
const pkg = require('../package.json');

const DEFAULT_PORT = Number(process.env.PORT) || 5000;
const RUNTIME_FILE = path.join(__dirname, '..', 'data', 'runtime.json');

async function startWithPortFallback(app, requestedPort) {
  const firstPort = Number(requestedPort) > 0 ? Number(requestedPort) : DEFAULT_PORT;
  let lastError = null;
  // A source checkout or another PMS installation may already own the default
  // port. Keep the installed app usable by trying the next few private ports
  // instead of failing before the window opens.
  for (let port = firstPort; port < firstPort + 10; port += 1) {
    try {
      const started = await network.start(app, port);
      if (port !== firstPort) {
        console.warn(`Port ${firstPort} is already in use; starting Nexuzy PMS on port ${port}.`);
      }
      return started;
    } catch (err) {
      lastError = err;
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw lastError || new Error(`No free port found between ${firstPort} and ${firstPort + 9}.`);
}

async function bootstrap() {
  try {
    console.log('Starting Nexuzy PMS Server...');

    // 1. Ensure schema exists, then apply additive migrations for an existing
    //    hotel database. No destructive statements run here.
    const schemaPath = path.join(__dirname, 'db', 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await db.exec(schemaSql);
    await applyMigrations();

    // 2. Check if property is initialized
    const prop = await db.get('SELECT name, code FROM properties LIMIT 1');
    const lanConfig = await network.getConfig(true);
    const requestedPort = Number(process.env.PORT || lanConfig.port || DEFAULT_PORT);

    const started = await startWithPortFallback(app, requestedPort);
    const status = await network.status();

    fs.mkdirSync(path.dirname(RUNTIME_FILE), { recursive: true });
    fs.writeFileSync(RUNTIME_FILE, JSON.stringify({
      port: started.port,
      local_url: `http://localhost:${started.port}`,
      lan_url: status.lan_url,
      lan_enabled: status.enabled,
      version: pkg.version,
      started_at: new Date().toISOString(),
      pid: process.pid
    }, null, 2));

    console.log('=======================================================');
    console.log(`  Nexuzy PMS v${pkg.version} is running`);
    console.log(`  Local:  http://localhost:${started.port}`);
    if (status.enabled) {
      console.log(`  LAN:    ${status.lan_url}`);
      console.log(`  LAN mode is ON. Private-network devices can sign in.`);
      if (status.security_mode === 'http_demo') {
        console.log(`  WARNING: plain HTTP — use only on a trusted private network.`);
      }
      console.log(`  If phones cannot connect, run enable-lan-firewall.bat as Administrator.`);
    } else {
      console.log(`  LAN mode is OFF. Only this computer can connect.`);
      console.log(`  Enable it under Settings > Local Network.`);
    }
    console.log(`  API Base: http://localhost:${started.port}/api/v1`);
    if (prop) {
      console.log(`  Active Property: ${prop.name} (${prop.code})`);
    } else {
      console.log(`  Status: FIRST-TIME SETUP REQUIRED`);
      console.log(`  Open http://localhost:${started.port} to configure your hotel`);
    }
    console.log('=======================================================');

    const shutdown = async (signal) => {
      console.log(`\n${signal} received. Shutting down Nexuzy PMS...`);
      try {
        // The listener is owned by the network module; closing the DB after it
        // ensures in-flight writes finish before the process exits.
        await network.stop();
        await db.close();
        fs.rmSync(RUNTIME_FILE, { force: true });
      } catch (err) {
        console.error('Shutdown warning:', err.message);
      }
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`Fatal: port ${process.env.PORT || DEFAULT_PORT} is already in use.`);
      console.error('Close the other program, or set a different port in Settings > Local Network (data is preserved).');
    } else {
      console.error('Fatal initialization error:', err);
    }
    process.exit(1);
  }
}

bootstrap();
