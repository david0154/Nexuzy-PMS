// Local-network (LAN) mode.
//
// Nexuzy PMS is a single-host server: the host owns the SQLite database and
// every other device is a browser client. This module decides whether remote
// devices may reach the server, exposes the real LAN address/port, and can
// rebind the listener without restarting the process.

const os = require('os');
const http = require('http');
const dgram = require('dgram');
const { execFile } = require('child_process');
const db = require('../../config/database');

const DEFAULT_PORT = Number(process.env.PORT) || 5000;
const DEFAULT_CONFIG = {
  enabled: false,
  port: DEFAULT_PORT,
  https_enabled: false,
  allow_http_demo: true
};

let server = null;
let currentPort = null;
let cachedConfig = null;
let cacheAt = 0;
let cachedPrimaryAddress = null;
let cachedPrimaryAt = 0;

function stripIp(ip) {
  if (!ip) return '';
  const value = String(ip);
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}

function isLoopback(ip) {
  const value = stripIp(ip);
  return value === '::1' || value === '127.0.0.1' || value.startsWith('127.');
}

function isPrivateIp(ip) {
  const value = stripIp(ip);
  if (isLoopback(value)) return true;
  if (/^10\./.test(value)) return true;
  if (/^192\.168\./.test(value)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(value)) return true;
  if (/^169\.254\./.test(value)) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(value)) return true; // unique local IPv6
  if (/^fe80:/i.test(value)) return true; // IPv6 link-local
  return false;
}

function lanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (!isPrivateIp(entry.address)) continue;
      addresses.push({ interface: name, address: entry.address });
    }
  }
  return addresses;
}

// Finds the address Windows/Linux would use for the default route. This avoids
// advertising an unrelated Ethernet adapter when the staff devices are on Wi-Fi.
function primaryLanAddress() {
  if (cachedPrimaryAddress && Date.now() - cachedPrimaryAt < 30000) return Promise.resolve(cachedPrimaryAddress);
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const finish = (address) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch (err) { /* already closed */ }
      cachedPrimaryAddress = address || null;
      cachedPrimaryAt = Date.now();
      resolve(cachedPrimaryAddress);
    };
    socket.once('error', () => finish(null));
    socket.connect(53, '8.8.8.8', () => {
      try { finish(socket.address().address); } catch (err) { finish(null); }
    });
    setTimeout(() => finish(null), 800).unref();
  });
}

async function getConfig(force = false) {
  const now = Date.now();
  if (!force && cachedConfig && now - cacheAt < 3000) return cachedConfig;
  let config = { ...DEFAULT_CONFIG };
  try {
    const row = await db.get("SELECT setting_value FROM system_settings WHERE setting_key = 'lan_config'");
    if (row) config = { ...config, ...JSON.parse(row.setting_value) };
  } catch (err) {
    // Settings table unavailable during very early startup: fall back to defaults.
  }
  cachedConfig = config;
  cacheAt = now;
  return config;
}

async function saveConfig(updates) {
  const config = { ...(await getConfig(true)), ...updates };
  await db.run(
    `INSERT OR REPLACE INTO system_settings (setting_key, setting_value, updated_at)
     VALUES ('lan_config', ?, CURRENT_TIMESTAMP)`,
    [JSON.stringify(config)]
  );
  cachedConfig = config;
  cacheAt = Date.now();
  return config;
}

function listen(app, port) {
  return new Promise((resolve, reject) => {
    const candidate = http.createServer(app);
    const onError = (err) => {
      candidate.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      candidate.removeListener('error', onError);
      resolve(candidate);
    };
    candidate.once('error', onError);
    candidate.once('listening', onListening);
    candidate.listen(port, '0.0.0.0');
  });
}

function closeServer(target) {
  return new Promise((resolve) => {
    if (!target) return resolve();
    target.close(() => resolve());
    // Do not wait forever for idle keep-alive sockets from tablets.
    setTimeout(() => {
      try { target.closeAllConnections && target.closeAllConnections(); } catch (err) { /* ignore */ }
      resolve();
    }, 3000).unref();
  });
}

async function start(app, portOverride) {
  const config = await getConfig(true);
  const port = Number(portOverride || config.port || DEFAULT_PORT);
  server = await listen(app, port);
  currentPort = port;
  return { port, addresses: lanAddresses() };
}

function getPort() {
  return currentPort;
}

async function restartOnPort(app, port) {
  if (!server) return start(app, port);
  const previous = currentPort;
  server.close();
  try {
    const next = await listen(app, port);
    server = next;
    currentPort = port;
  } catch (err) {
    // Never silently move the port: restore the previous working listener and
    // surface the conflict so the displayed URL remains truthful.
    server = await listen(app, previous);
    currentPort = previous;
    if (err.code === 'EADDRINUSE') {
      const conflict = new Error(`Port ${port} is already in use. The server remains on port ${previous}.`);
      conflict.code = 'PORT_IN_USE';
      throw conflict;
    }
    throw err;
  }
  return { port: currentPort, addresses: lanAddresses() };
}

async function stop() {
  await closeServer(server);
  server = null;
  currentPort = null;
}

async function status() {
  const config = await getConfig();
  const hostname = os.hostname();
  const addresses = lanAddresses();
  const port = currentPort || config.port || DEFAULT_PORT;
  const routeAddress = await primaryLanAddress();
  const primary = addresses.find(a => a.address === routeAddress) || addresses[0] || null;
  const url = primary ? `http://${primary.address}:${port}` : `http://localhost:${port}`;
  const lanUrls = addresses.map(a => ({
    interface: a.interface,
    address: a.address,
    url: `http://${a.address}:${port}`
  }));

  let activeSessions = 0;
  try {
    const row = await db.get('SELECT COUNT(*) AS count FROM lan_sessions WHERE is_active = 1');
    activeSessions = Number(row.count || 0);
  } catch (err) { /* session table may not exist during migration */ }

  return {
    enabled: Boolean(config.enabled),
    port,
    bind_address: '0.0.0.0',
    configured_port: config.port,
    host_name: hostname,
    addresses,
    lan_urls: lanUrls,
    lan_url: url,
    local_url: `http://localhost:${port}`,
    security_mode: config.https_enabled ? 'https_requested' : 'http_demo',
    https_enabled: Boolean(config.https_enabled),
    https_available: false,
    active_sessions: activeSessions,
    warnings: [
      ...(config.enabled && !config.https_enabled
        ? ['LAN sharing is using plain HTTP. Passwords and session data are not encrypted in transit. Use only on a trusted private network.']
        : []),
      ...(config.enabled
        ? ['Do not forward this port from your router. Nexuzy PMS must stay on the private network.']
        : [])
    ],
    notes: [
      'Guest Wi-Fi isolation, VLAN separation, different subnets or host firewall rules can block devices from connecting.',
      'Remote devices cannot connect while the host is shut down, asleep, disconnected, or the server is stopped.'
    ]
  };
}

function httpProbe(url, timeoutMs = 1800) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      response.resume();
      resolve({ ok: response.statusCode >= 200 && response.statusCode < 500, status: response.statusCode });
    });
    request.on('timeout', () => {
      request.destroy(new Error('Connection timed out'));
    });
    request.on('error', (err) => {
      resolve({ ok: false, error: err.code || err.message });
    });
  });
}

function firewallStatus() {
  if (process.platform !== 'win32') {
    return Promise.resolve({ supported: false, present: null, note: 'Windows firewall check applies only to Windows hosts.' });
  }
  return new Promise((resolve) => {
    execFile(
      'netsh',
      ['advfirewall', 'firewall', 'show', 'rule', 'name=Nexuzy PMS LAN (Node.js)'],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        const output = String(stdout || '');
        if (err) {
          resolve({ supported: true, present: false, note: 'No firewall rule found. Run enable-lan-firewall.bat as administrator.' });
          return;
        }
        const enabled = /Enabled:\s*Yes/i.test(output) || /已启用:\s*是/i.test(output);
        resolve({ supported: true, present: true, enabled, note: enabled ? 'Windows Firewall allows the Node.js process; the PMS still rejects public IP clients.' : 'Firewall rule exists but is disabled.' });
      }
    );
  });
}

async function networkProfiles() {
  if (process.platform !== 'win32') return [];
  return new Promise((resolve) => {
    const command = "Get-NetConnectionProfile | ForEach-Object { $_.Name + '|' + $_.NetworkCategory }";
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      const profiles = String(stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
        const [name, category] = line.split('|');
        return { name, category };
      });
      resolve(profiles);
    });
  });
}

async function diagnostics() {
  const current = await status();
  const localProbe = await httpProbe(`${current.local_url}/api/health`);
  const lanProbe = current.addresses.length ? await httpProbe(`${current.lan_url}/api/health`) : { ok: false, error: 'NO_PRIVATE_ADDRESS' };
  const firewall = await firewallStatus();
  const profiles = await networkProfiles();

  return {
    ...current,
    firewall,
    network_profiles: profiles,
    firewall_script: process.platform === 'win32' ? 'enable-lan-firewall.bat' : null,
    probes: { local: localProbe, lan_url: lanProbe },
    checks: [
      {
        key: 'enabled',
        ok: current.enabled,
        label: 'LAN sharing is enabled',
        detail: current.enabled ? 'Private-network devices are allowed to sign in.' : 'Enable it under Settings > Local Network.'
      },
      {
        key: 'address',
        ok: current.addresses.length > 0,
        label: 'A private LAN address is available',
        detail: current.addresses.length ? current.addresses.map(a => a.address).join(', ') : 'Connect this computer to Wi-Fi or Ethernet.'
      },
      {
        key: 'listener',
        ok: localProbe.ok,
        label: 'The PMS server is responding on this computer',
        detail: localProbe.ok ? `HTTP ${localProbe.status}` : `Failed: ${localProbe.error || 'unknown error'}`
      },
      {
        key: 'lan_url',
        ok: lanProbe.ok && lanProbe.status !== 403,
        label: 'The LAN URL reaches the PMS server',
        detail: lanProbe.ok ? `HTTP ${lanProbe.status}` : `Failed: ${lanProbe.error || 'unknown error'} (enable LAN sharing first)`
      },
      {
        key: 'firewall',
        ok: !firewall.supported ? null : Boolean(firewall.present && firewall.enabled),
        label: 'Windows Firewall allows the Node.js server',
        detail: firewall.note
      }
    ]
  };
}

function lanGuard(req, res, next) {
  // Applies to every request, including static files. Host-local access always
  // works; remote access requires LAN mode and a private source address.
  const remote = stripIp(req.socket && req.socket.remoteAddress);
  if (isLoopback(remote)) return next();

  if (!isPrivateIp(remote)) {
    return res.status(403).json({
      success: false,
      error: 'Nexuzy PMS only accepts local-network clients. Public or non-private addresses are blocked.'
    });
  }

  getConfig()
    .then(config => {
      if (!config.enabled) {
        return res.status(403).json({
          success: false,
          error: 'Local network access is disabled. Enable it from the host computer under Settings > Local Network.'
        });
      }
      next();
    })
    .catch(() => res.status(503).json({ success: false, error: 'Network configuration unavailable' }));
}

module.exports = {
  DEFAULT_PORT,
  isLoopback,
  isPrivateIp,
  lanAddresses,
  getConfig,
  saveConfig,
  start,
  getPort,
  restartOnPort,
  status,
  diagnostics,
  lanGuard,
  closeServer,
  stop
};
