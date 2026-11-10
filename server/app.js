const express = require('express');
const cors = require('cors');
const path = require('path');

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

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    product: 'Nexuzy PMS',
    version: '1.0.0',
    developer: 'Nexuzy Lab',
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

// Serve static frontend in production / build
const staticPath = path.join(__dirname, '..', 'public');
app.use(express.static(staticPath));

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

// Central error handler
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  res.status(500).json({
    success: false,
    error: err.message || 'Internal Server Error'
  });
});

module.exports = app;
