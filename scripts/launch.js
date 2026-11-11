// Desktop launcher: starts the PMS and opens it in its own application window
// (Chrome/Edge/Brave/Chromium --app mode) instead of a normal browser tab, so
// staff see a native-feeling app without an address bar. Falls back to the
// default browser when no Chromium-based browser is installed.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const runtimeFile = path.join(root, 'data', 'runtime.json');
const LOG_FILE = path.join(root, 'data', 'launcher.log');
const WINDOW_SIZE = '1440,900';

function appendLog(message) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`);
  } catch (err) {
    // Logging must never stop the launcher.
  }
}

function log(message) {
  appendLog(message);
  console.log(message);
}

// A hidden-console launch that fails otherwise looks like nothing happened.
// Show a native message box with the log path so staff can report the cause.
function showFailure(message) {
  if (process.env.NO_OPEN === '1' || process.platform !== 'win32') return;
  try {
    const safe = String(message).replace(/'/g, "''").replace(/\r?\n/g, ' ');
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-WindowStyle', 'Hidden',
      '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${safe}', 'Nexuzy PMS')`
    ], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    // The log still records the failure.
  }
}

function exists(target) {
  try { return fs.existsSync(target); } catch (err) { return false; }
}

function findCommand(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

function findBrowser() {
  if (process.platform === 'win32') {
    const bases = [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
      process.env.PROGRAMW6432
    ].filter(Boolean);
    const relatives = [
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
      ['Chromium', 'Application', 'chrome.exe']
    ];
    for (const base of bases) {
      for (const relative of relatives) {
        const candidate = path.join(base, ...relative);
        if (exists(candidate)) return candidate;
      }
    }
    return null;
  }

  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ].find(exists) || null;
  }

  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']
    .map(findCommand)
    .find(Boolean) || null;
}

function openInDefaultBrowser(url) {
  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    // Opening a window is a convenience; startup never fails because of it.
  }
}

function openAppWindow(url) {
  if (process.env.NO_OPEN === '1') return;
  const browser = findBrowser();
  if (browser) {
    try {
      const child = spawn(
        browser,
        [`--app=${url}`, `--window-size=${WINDOW_SIZE}`, '--no-first-run', '--no-default-browser-check'],
        { detached: true, stdio: 'ignore' }
      );
      child.unref();
      return;
    } catch (err) {
      // Fall through to the default browser.
    }
  }
  openInDefaultBrowser(url);
}

function readRuntime() {
  try {
    return JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
  } catch (err) {
    return null;
  }
}

async function serverIsRunning(runtime) {
  if (!runtime || !runtime.local_url) return false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(`${runtime.local_url}/api/health`, { signal: controller.signal });
    clearTimeout(timeout);
    return response.ok;
  } catch (err) {
    return false;
  }
}

async function main() {
  const existing = readRuntime();
  if (await serverIsRunning(existing)) {
    log(`Nexuzy PMS is already running. Opening ${existing.local_url}`);
    openAppWindow(existing.local_url);
    return;
  }

  try {
    fs.rmSync(runtimeFile, { force: true });
  } catch (err) { /* ignore */ }

  log('Starting Nexuzy PMS...');
  const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  });

  child.stdout.on('data', chunk => {
    process.stdout.write(chunk);
    appendLog(chunk.toString().trimEnd());
  });
  child.stderr.on('data', chunk => {
    process.stderr.write(chunk);
    appendLog(chunk.toString().trimEnd());
  });

  let opened = false;
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (opened) return;
    const runtime = readRuntime();
    if (runtime && runtime.local_url) {
      opened = true;
      clearInterval(timer);
      log(`Opening Nexuzy PMS in its own window: ${runtime.local_url}`);
      openAppWindow(runtime.local_url);
    } else if (Date.now() - startedAt > 30000) {
      clearInterval(timer);
      log('Server did not report a URL in time.');
      showFailure(`Nexuzy PMS could not start within 30 seconds. Details: ${LOG_FILE}`);
    }
  }, 400);

  const forward = (signal) => {
    try { child.kill(signal); } catch (err) { /* ignore */ }
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  child.on('exit', (code) => {
    clearInterval(timer);
    if (!opened && code) {
      log(`Server exited with code ${code} before the app window opened.`);
      showFailure(`Nexuzy PMS could not start (exit code ${code}). Details: ${LOG_FILE}`);
    }
    process.exit(code == null ? 0 : code);
  });
}

main();
