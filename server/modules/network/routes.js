const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { authenticateToken, requireRoles } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');
const network = require('./service');

// GET /api/v1/network/status
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const status = await network.status();
    res.json({ success: true, ...status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/network/diagnostics — actionable LAN troubleshooting
router.get('/diagnostics', authenticateToken, requireRoles('admin', 'general_manager'), async (req, res) => {
  try {
    const result = await network.diagnostics();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/v1/network/config — explicit LAN enable/disable and port
router.patch('/config', authenticateToken, requireRoles('admin'), async (req, res) => {
  try {
    const updates = {};
    if (req.body.enabled !== undefined) updates.enabled = Boolean(req.body.enabled);

    if (req.body.port !== undefined) {
      const port = Number(req.body.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        return res.status(400).json({ success: false, error: 'Port must be an integer between 1024 and 65535' });
      }
      updates.port = port;
    }

    if (req.body.https_enabled !== undefined && req.body.https_enabled) {
      return res.status(400).json({
        success: false,
        error: 'HTTPS mode is not available in this build. Keep LAN sharing on a trusted private network or place a reviewed reverse proxy with a trusted certificate in front of the host.'
      });
    }
    updates.https_enabled = false;

    const before = await network.getConfig(true);
    const config = await network.saveConfig(updates);

    let rebind = null;
    if (updates.port && updates.port !== network.getPort()) {
      try {
        rebind = await network.restartOnPort(req.app, updates.port);
      } catch (err) {
        await network.saveConfig({ port: before.port });
        return res.status(err.code === 'PORT_IN_USE' ? 409 : 500).json({
          success: false,
          error: err.message,
          port: network.getPort()
        });
      }
    }

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: updates.enabled === false ? 'DISABLE_LAN_ACCESS' : 'UPDATE_LAN_CONFIG',
      entityType: 'network',
      beforeValue: { enabled: before.enabled, port: before.port },
      afterValue: { enabled: config.enabled, port: network.getPort() },
      req
    });

    const status = await network.status();
    res.json({
      success: true,
      message: config.enabled
        ? `Local network access enabled on port ${network.getPort()}.`
        : 'Local network access disabled. Only this computer can connect.',
      ...status,
      rebound: Boolean(rebind)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/network/qr — QR for the selected/advertised LAN URL
router.get('/qr', authenticateToken, async (req, res) => {
  try {
    const status = await network.status();
    let target = status.lan_url;
    if (req.query.address) {
      const advertised = status.addresses.find(a => a.address === String(req.query.address));
      if (!advertised) {
        return res.status(400).json({ success: false, error: 'That address is not an advertised private LAN address' });
      }
      target = `http://${advertised.address}:${status.port}`;
    }
    const dataUrl = await QRCode.toDataURL(target, {
      margin: 1,
      width: 260,
      color: { dark: '#0f172a', light: '#ffffff' }
    });
    res.json({ success: true, url: target, data_url: dataUrl });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
