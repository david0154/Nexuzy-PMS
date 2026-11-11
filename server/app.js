const express = require('express');
const cors = require('cors');
const path = require('path');
const pkg = require('../package.json');
const db = require('./config/database');
const network = require('./modules/network/service');

const authRoutes = require('./modules/auth/routes');
const propertyRoutes = require('./modules/properties/routes');
const roomRoutes = require('./modules/rooms/routes');
const reservationRoutes = require('./modules/reservations/routes');
const groupRoutes = require('./modules/groups/routes');
const stayRoutes = require('./modules/stays/routes');
const folioRoutes = require('./modules/folios/routes');
const restaurantRoutes = require('./modules/restaurant/routes');
const housekeepingRoutes = require('./modules/housekeeping/routes');
const maintenanceRoutes = require('./modules/maintenance/routes');
const cashierRoutes = require('./modules/cashier/routes');
const inventoryRoutes = require('./modules/inventory/routes');
const nightAuditRoutes = require('./modules/night-audit/routes');
const reportRoutes = require('./modules/reports/routes');
const setupRoutes = require('./modules/setup/routes');
const backupRoutes = require('./modules/backup/routes');
const settingsRoutes = require('./modules/settings/routes');
const networkRoutes = require('./modules/network/routes');
const systemRoutes = require('./modules/system/routes');
const expenseRoutes = require('./modules/expenses/routes');

const app = express();
app.disable('x-powered-by');

// The UI is served by this same server. Only enable CORS for an explicitly
// configured origin; a wildcard is not an access-control mechanism.
if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN.split(',').map(o => o.trim()), credentials: true }));
}

// Logos arrive as base64 data URLs, which add roughly 33% overhead. A 1.5 MB
// image therefore needs a little over 2 MB of JSON; 8 MB leaves room for the
// rest of the setup payload without rejecting a valid logo.
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// Reject public/non-private clients and remote clients while LAN mode is off.
app.use(network.lanGuard);

// Health Check
app.get('/api/health', async (req, res) => {
  let database = 'ok';
  try {
    await db.get('SELECT 1 AS ok');
  } catch (err) {
    database = 'failed';
  }
  res.status(database === 'ok' ? 200 : 503).json({
    status: database === 'ok' ? 'healthy' : 'degraded',
    product: 'Nexuzy PMS',
    version: pkg.version,
    developer: 'Nexuzy Lab',
    database,
    timestamp: new Date().toISOString()
  });
});

// Mount API v1 Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/properties', propertyRoutes);
app.use('/api/v1/rooms', roomRoutes);
app.use('/api/v1/reservations', reservationRoutes);
app.use('/api/v1/groups', groupRoutes);
app.use('/api/v1/stays', stayRoutes);
app.use('/api/v1/folios', folioRoutes);
app.use('/api/v1/restaurant', restaurantRoutes);
app.use('/api/v1/housekeeping', housekeepingRoutes);
app.use('/api/v1/maintenance', maintenanceRoutes);
app.use('/api/v1/cashier', cashierRoutes);
app.use('/api/v1/inventory', inventoryRoutes);
app.use('/api/v1/night-audit', nightAuditRoutes);
app.use('/api/v1/reports', reportRoutes);
app.use('/api/v1/setup', setupRoutes);
app.use('/api/v1/backup', backupRoutes);
app.use('/api/v1/settings', settingsRoutes);
app.use('/api/v1/network', networkRoutes);
app.use('/api/v1/system', systemRoutes);
app.use('/api/v1/expenses', expenseRoutes);

// Hotel logo uploads live beside the database so .nxp backups and data moves
// keep the branding with the property.
const dataPath = process.env.DB_PATH
  ? path.dirname(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data');
app.use('/uploads', express.static(path.join(dataPath, 'uploads'), { index: false, dotfiles: 'deny', maxAge: '1h' }));

// Serve static frontend in production / build
const staticPath = path.join(__dirname, '..', 'public');
app.use(express.static(staticPath, {
  setHeaders(res, filePath) {
    // HTML must always be fresh after an update; static assets can be reused
    // briefly instead of re-downloaded on every screen.
    if (String(filePath).endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=3600');
  }
}));

// Fallback to index.html for SPA client navigation
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, error: 'Endpoint not found' });
  }
  const indexPath = path.join(staticPath, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) next();
  });
});

// Central error handler. Body-parser errors must return JSON too, otherwise the
// browser reports a confusing "Unexpected token '<'" instead of the real cause.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      error: 'The uploaded image is too large. Use a PNG, JPG or WebP under 1.5 MB.'
    });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'Invalid request body.' });
  }
  console.error('Unhandled Server Error:', err);
  res.status(500).json({
    success: false,
    error: err.message || 'Internal Server Error'
  });
});

module.exports = app;
