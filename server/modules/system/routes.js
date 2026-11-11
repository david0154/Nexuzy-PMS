const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const router = express.Router();
const db = require('../../config/database');
const { authenticateToken, requireRoles } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');
const { getSmtpConfig } = require('../../services/mailer');
const network = require('../network/service');

const pkg = require('../../../package.json');
const ROOT = path.join(__dirname, '..', '..', '..');
const DATA_DIR = path.dirname(process.env.DB_PATH || path.join(ROOT, 'data', 'nexuzy.db'));
const UPDATE_DIR = path.join(DATA_DIR, 'updates');
const BACKUP_DIR = path.join(ROOT, 'backups');
const startedAt = Date.now();
const MAX_UPDATE_BYTES = 350 * 1024 * 1024;
const RELEASE_CACHE_MS = 5 * 60 * 1000;
const DONATION_URL = process.env.NEXUZY_DONATION_URL || 'https://razorpay.me/@nexuzylab';
const DONATION_UPI = process.env.NEXUZY_DONATION_UPI || null;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.NEXUZY_GITHUB_TOKEN || '';

let releaseCache = { at: 0, release: null };

function safeStat(target) {
  try {
    return fs.statSync(target);
  } catch (err) {
    return null;
  }
}

function githubRepo() {
  const raw = pkg.repository && (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url);
  const match = raw && String(raw).match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
  if (!match) return null;
  return {
    owner: match[1],
    name: match[2],
    url: `https://github.com/${match[1]}/${match[2]}`
  };
}

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '').split(/[+-]/)[0];
}

function compareVersions(left, right) {
  const a = normalizeVersion(left).split('.').map(part => Number.parseInt(part, 10) || 0);
  const b = normalizeVersion(right).split('.').map(part => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const difference = (a[i] || 0) - (b[i] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function sameOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === req.get('host');
  } catch (err) {
    return false;
  }
}

function allowedReleaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (
      url.hostname === 'github.com' ||
      url.hostname.endsWith('.github.com') ||
      url.hostname === 'objects.githubusercontent.com' ||
      url.hostname.endsWith('.githubusercontent.com')
    );
  } catch (err) {
    return false;
  }
}

function githubHeaders() {
  const headers = {
    'User-Agent': 'Nexuzy-PMS-Update',
    Accept: 'application/vnd.github+json'
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return headers;
}

function assetForThisComputer(assets) {
  const list = Array.isArray(assets) ? assets : [];
  let matcher;
  if (process.platform === 'win32') matcher = /^Nexuzy-PMS-Setup-.*\.exe$/i;
  else if (process.platform === 'linux') matcher = /^Nexuzy-PMS-.*linux-x64\.(run|tar\.gz)$/i;
  else if (process.platform === 'darwin') {
    matcher = new RegExp(`^Nexuzy-PMS-.*macos-${process.arch === 'arm64' ? 'arm64' : 'x64'}\\.tar\\.gz$`, 'i');
  }
  if (!matcher) return null;
  const candidates = list.filter(asset => matcher.test(asset.name || ''));
  candidates.sort((a, b) => {
    const aRun = /\.run$/i.test(a.name) ? 0 : 1;
    const bRun = /\.run$/i.test(b.name) ? 0 : 1;
    return aRun - bRun;
  });
  return candidates[0] || null;
}

async function latestRelease(force = false) {
  const repo = githubRepo();
  if (!repo) return { error: 'No GitHub repository is configured for update checks.' };

  if (!force && releaseCache.release && Date.now() - releaseCache.at < RELEASE_CACHE_MS) {
    return releaseCache.release;
  }

  let response;
  try {
    response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/releases/latest`, {
      headers: githubHeaders()
    });
  } catch (err) {
    return { error: `Could not reach GitHub: ${err.message}` };
  }

  if (response.status === 404) {
    return { error: 'No published GitHub release was found for this repository.' };
  }
  if (!response.ok) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    const hint = remaining === '0' ? ' GitHub API rate limit reached; try again later.' : '';
    return { error: `GitHub returned HTTP ${response.status}.${hint}` };
  }

  let release;
  try {
    release = await response.json();
  } catch (err) {
    return { error: 'GitHub returned an unreadable release response.' };
  }

  releaseCache = { at: Date.now(), release };
  return release;
}

function installationInfo() {
  const info = {
    installed: false,
    uninstall_available: false,
    kind: 'source',
    install_dir: ROOT,
    data_dir: DATA_DIR,
    platform: process.platform,
    arch: process.arch
  };

  if (process.platform === 'win32') {
    const uninstaller = path.join(ROOT, 'unins000.exe');
    if (fs.existsSync(uninstaller)) {
      info.installed = true;
      info.uninstall_available = true;
      info.kind = 'inno';
      info.uninstaller = uninstaller;
    }
  } else if (process.platform === 'darwin') {
    const uninstaller = path.join(ROOT, '..', 'uninstall.sh');
    if (ROOT.includes('.app/Contents/Resources/app') && fs.existsSync(uninstaller)) {
      info.installed = true;
      info.uninstall_available = true;
      info.kind = 'script';
      info.uninstaller = uninstaller;
    }
  } else if (process.platform === 'linux') {
    const uninstaller = path.join(ROOT, 'uninstall.sh');
    if (fs.existsSync(uninstaller)) {
      info.installed = true;
      info.uninstall_available = true;
      info.kind = 'script';
      info.uninstaller = uninstaller;
    }
  }

  return info;
}

function publicInstallationInfo() {
  const info = installationInfo();
  return {
    installed: info.installed,
    uninstall_available: info.uninstall_available,
    kind: info.kind,
    install_dir: info.install_dir,
    data_dir: info.data_dir,
    platform: info.platform,
    arch: info.arch
  };
}

// GET /api/v1/system/version
router.get('/version', (req, res) => {
  res.json({
    success: true,
    product: 'Nexuzy PMS',
    version: pkg.version,
    developer: pkg.author,
    homepage: pkg.homepage,
    repository: pkg.repository || null,
    node: process.version
  });
});

// GET /api/v1/system/about — app, developer, support and installation details
router.get('/about', authenticateToken, (req, res) => {
  const repo = githubRepo();
  res.json({
    success: true,
    product: 'Nexuzy PMS',
    version: pkg.version,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    license: pkg.license || 'MIT',
    developer: {
      name: 'Nexuzy Lab',
      lead: 'David',
      email: 'david@nexuzy.in',
      website: 'https://nexuzy.in'
    },
    repository: repo ? { label: 'GitHub', url: repo.url } : null,
    donation: {
      url: DONATION_URL,
      upi: DONATION_UPI,
      note: 'Support ongoing Nexuzy PMS development, hosting and documentation.'
    },
    installation: publicInstallationInfo()
  });
});

// GET /api/v1/system/health — admin operations view
router.get('/health', authenticateToken, async (req, res) => {
  const checks = {};
  let healthy = true;

  const dbStart = Date.now();
  try {
    const row = await db.get('SELECT 1 AS ok');
    checks.database = {
      status: row && row.ok === 1 ? 'ok' : 'degraded',
      latency_ms: Date.now() - dbStart
    };
    if (checks.database.status !== 'ok') healthy = false;
  } catch (err) {
    checks.database = { status: 'failed', error: 'Database is not reachable' };
    healthy = false;
  }

  try {
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
    checks.storage = { status: 'ok', data_directory: DATA_DIR };
  } catch (err) {
    checks.storage = { status: 'failed', error: 'Data directory is not writable', data_directory: DATA_DIR };
    healthy = false;
  }

  const backups = fs.existsSync(BACKUP_DIR)
    ? fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.nxp')).map(f => {
        const stat = safeStat(path.join(BACKUP_DIR, f));
        return { filename: f, size: stat ? stat.size : 0, modified_at: stat ? stat.mtime.toISOString() : null };
      }).sort((a, b) => String(b.modified_at).localeCompare(String(a.modified_at)))
    : [];
  checks.backups = {
    status: backups.length ? 'ok' : 'none',
    count: backups.length,
    latest: backups[0] || null
  };

  try {
    const smtp = await getSmtpConfig();
    checks.email = { status: smtp ? 'configured' : 'not_configured', host: smtp ? smtp.host : null };
  } catch (err) {
    checks.email = { status: 'unknown' };
  }

  try {
    const lan = await network.status();
    checks.network = {
      status: lan.enabled ? 'lan_enabled' : 'local_only',
      port: lan.port,
      lan_url: lan.lan_url,
      security_mode: lan.security_mode,
      active_sessions: lan.active_sessions
    };
  } catch (err) {
    checks.network = { status: 'unknown' };
  }

  checks.background_jobs = {
    status: 'not_configured',
    note: 'No background job runner is installed in this build.'
  };

  const mem = process.memoryUsage();
  res.json({
    success: true,
    status: healthy ? 'healthy' : 'degraded',
    product: 'Nexuzy PMS',
    version: pkg.version,
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    node: process.version,
    checked_at: new Date().toISOString(),
    checks,
    memory_mb: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heap_used: Math.round(mem.heapUsed / 1024 / 1024)
    }
  });
});

// GET /api/v1/system/update-check — GitHub release check
router.get('/update-check', authenticateToken, requireRoles('admin'), async (req, res) => {
  try {
    const repo = githubRepo();
    if (!repo) {
      return res.json({
        success: true,
        configured: false,
        current_version: pkg.version,
        message: 'No GitHub repository is configured for update checks.'
      });
    }

    const release = await latestRelease(req.query.force === '1');
    if (!release || release.error) {
      return res.json({
        success: true,
        configured: true,
        checked: false,
        current_version: pkg.version,
        message: (release && release.error) || 'The release service could not be reached.'
      });
    }

    const latest = normalizeVersion(release.tag_name || release.name || '');
    const recommended = assetForThisComputer(release.assets || []);
    return res.json({
      success: true,
      configured: true,
      checked: true,
      current_version: normalizeVersion(pkg.version),
      latest_version: latest,
      update_available: compareVersions(latest, pkg.version) > 0,
      release_url: release.html_url,
      release_name: release.name,
      published_at: release.published_at,
      notes: release.body ? String(release.body).slice(0, 6000) : null,
      recommended_asset: recommended ? {
        name: recommended.name,
        size: recommended.size,
        download_url: recommended.browser_download_url
      } : null,
      assets: (release.assets || []).map(asset => ({
        name: asset.name,
        size: asset.size,
        download_url: asset.browser_download_url,
        recommended: Boolean(recommended && asset.name === recommended.name)
      }))
    });
  } catch (err) {
    return res.json({
      success: true,
      configured: true,
      checked: false,
      current_version: pkg.version,
      message: `Could not check for updates: ${err.message}`
    });
  }
});

// POST /api/v1/system/update/download — download the matching installer
router.post('/update/download', authenticateToken, requireRoles('admin'), async (req, res) => {
  try {
    if (!sameOrigin(req)) return res.status(403).json({ success: false, error: 'This action must come from the Nexuzy PMS window.' });

    const release = await latestRelease(true);
    if (!release || release.error) {
      return res.status(400).json({ success: false, error: (release && release.error) || 'No release is available.' });
    }
    const latest = normalizeVersion(release.tag_name || '');
    if (compareVersions(latest, pkg.version) <= 0) {
      return res.status(400).json({ success: false, error: 'This copy is already up to date.' });
    }

    const asset = assetForThisComputer(release.assets || []);
    if (!asset || !allowedReleaseUrl(asset.browser_download_url)) {
      return res.status(404).json({
        success: false,
        error: 'No downloadable installer is published for this platform. Open the GitHub release page instead.'
      });
    }

    fs.mkdirSync(UPDATE_DIR, { recursive: true });
    const filename = path.basename(asset.name);
    const destination = path.join(UPDATE_DIR, filename);

    const response = await fetch(asset.browser_download_url, { headers: githubHeaders() });
    if (!response.ok) {
      return res.status(400).json({ success: false, error: `Update download returned HTTP ${response.status}.` });
    }
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > MAX_UPDATE_BYTES) {
      return res.status(413).json({ success: false, error: 'The published installer is larger than the safe download limit.' });
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_UPDATE_BYTES) {
      return res.status(413).json({ success: false, error: 'The published installer is larger than the safe download limit.' });
    }

    let checksumVerified = false;
    const checksumAsset = (release.assets || []).find(item => item.name === `${asset.name}.sha256`);
    if (checksumAsset && allowedReleaseUrl(checksumAsset.browser_download_url)) {
      try {
        const checksumResponse = await fetch(checksumAsset.browser_download_url, { headers: githubHeaders() });
        if (checksumResponse.ok) {
          const checksumText = await checksumResponse.text();
          const expected = String(checksumText).trim().split(/\s+/)[0].toLowerCase();
          const actual = crypto.createHash('sha256').update(buffer).digest('hex');
          if (expected && expected !== actual) {
            return res.status(400).json({ success: false, error: 'The downloaded update failed its SHA-256 verification.' });
          }
          checksumVerified = Boolean(expected);
        }
      } catch (err) {
        // A missing checksum sidecar is not fatal; report that it was not verified.
      }
    }

    fs.writeFileSync(destination, buffer);
    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'DOWNLOAD_APP_UPDATE',
      entityType: 'system',
      entityId: null,
      details: { version: latest, asset: filename, bytes: buffer.length, checksum_verified: checksumVerified },
      req
    });

    return res.json({
      success: true,
      message: checksumVerified
        ? 'Update downloaded and verified.'
        : 'Update downloaded. No published checksum was available.',
      version: latest,
      asset_name: filename,
      bytes: buffer.length,
      checksum_verified: checksumVerified,
      release_url: release.html_url
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: `Could not download the update: ${err.message}` });
  }
});

// POST /api/v1/system/update/install — launch the downloaded installer where safe
router.post('/update/install', authenticateToken, requireRoles('admin'), async (req, res) => {
  try {
    if (!sameOrigin(req)) return res.status(403).json({ success: false, error: 'This action must come from the Nexuzy PMS window.' });

    const release = await latestRelease(false);
    if (!release || release.error) {
      return res.status(400).json({ success: false, error: (release && release.error) || 'No release is available.' });
    }
    const asset = assetForThisComputer(release.assets || []);
    if (!asset) return res.status(404).json({ success: false, error: 'No installer is published for this platform.' });

    const destination = path.join(UPDATE_DIR, path.basename(asset.name));
    if (!fs.existsSync(destination)) {
      return res.status(400).json({ success: false, error: 'Download the update first.' });
    }

    const info = installationInfo();
    const canAutoInstall =
      (process.platform === 'win32' && info.kind === 'inno' && destination.toLowerCase().endsWith('.exe')) ||
      (process.platform === 'linux' && info.kind === 'script' && destination.endsWith('.run'));

    if (!canAutoInstall) {
      const opener = process.platform === 'win32'
        ? ['explorer.exe', ['/select,', destination]]
        : (process.platform === 'darwin' ? ['open', ['-R', destination]] : ['xdg-open', [UPDATE_DIR]]);
      try {
        const child = spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' });
        child.unref();
      } catch (err) { /* The user can still open the folder manually. */ }
      return res.json({
        success: true,
        manual: true,
        message: `Update downloaded to ${destination}. Close Nexuzy PMS, run the installer, then reopen the app.`
      });
    }

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'INSTALL_APP_UPDATE',
      entityType: 'system',
      entityId: null,
      details: { version: normalizeVersion(release.tag_name), asset: asset.name },
      req
    });

    res.json({
      success: true,
      manual: false,
      message: process.platform === 'win32'
        ? 'The installer is starting. Nexuzy PMS will close and reopen when the update finishes.'
        : 'The update installer is starting. Nexuzy PMS will close while files are replaced.'
    });

    setTimeout(() => {
      try {
        if (process.platform === 'win32') {
          const child = spawn(destination, ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], {
            detached: true,
            stdio: 'ignore'
          });
          child.unref();
        } else {
          // Linux installs without auto-launch so the old server has time to exit
          // before the new copy claims the port.
          const child = spawn('sh', [destination, '--no-launch'], { detached: true, stdio: 'ignore' });
          child.unref();
        }
      } catch (err) {
        console.error('Update installer could not start:', err.message);
      }
      setTimeout(() => process.exit(0), 1500);
    }, 700);
  } catch (err) {
    return res.status(500).json({ success: false, error: `Could not start the update: ${err.message}` });
  }
});

// POST /api/v1/system/uninstall — remove this installed copy, preserving hotel data
router.post('/uninstall', authenticateToken, requireRoles('admin'), async (req, res) => {
  try {
    if (!sameOrigin(req)) return res.status(403).json({ success: false, error: 'This action must come from the Nexuzy PMS window.' });
    if (String((req.body && req.body.confirm) || '') !== 'UNINSTALL') {
      return res.status(400).json({ success: false, error: 'Type UNINSTALL exactly to confirm removal.' });
    }

    const info = installationInfo();
    if (!info.uninstall_available) {
      return res.status(400).json({
        success: false,
        error: 'Uninstall is available only in an installed Nexuzy PMS build, not when running from source.'
      });
    }

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'UNINSTALL_APP',
      entityType: 'system',
      entityId: null,
      details: { kind: info.kind, install_dir: info.install_dir, data_dir: info.data_dir },
      req
    });

    res.json({
      success: true,
      message: info.kind === 'inno'
        ? 'Uninstalling Nexuzy PMS. The app will close; hotel data stays in the data folder.'
        : 'Uninstalling Nexuzy PMS. Hotel data is preserved in the stated data folder.'
    });

    setTimeout(() => {
      try {
        const child = process.platform === 'win32'
          ? spawn(info.uninstaller, ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { detached: true, stdio: 'ignore' })
          : spawn('sh', [info.uninstaller, '--yes'], { detached: true, stdio: 'ignore' });
        child.unref();
      } catch (err) {
        console.error('Uninstaller could not start:', err.message);
      }
      setTimeout(() => process.exit(0), 1800);
    }, 800);
  } catch (err) {
    return res.status(500).json({ success: false, error: `Uninstall could not start: ${err.message}` });
  }
});

module.exports = router;
