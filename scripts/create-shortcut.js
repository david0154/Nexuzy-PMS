#!/usr/bin/env node
// Creates a native-feeling desktop launcher for Nexuzy PMS.
// Windows: a hidden-console .lnk that runs the app-window launcher.
// macOS:   a minimal .app bundle in ~/Applications with a Desktop alias.
// Linux:   a .desktop entry (Terminal=false) plus a Desktop copy when present.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LAUNCH_SCRIPT = path.join(ROOT, 'scripts', 'launch.js');
const APP_NAME = 'Nexuzy PMS';

function quotePowerShell(value) {
  return String(value).replace(/'/g, "''");
}

function windowsDesktop() {
  try {
    const resolved = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"],
      { encoding: 'utf8' }
    ).trim();
    if (resolved) return resolved;
  } catch (err) {
    // Fall back to the conventional path below.
  }
  return path.join(os.homedir(), 'Desktop');
}

function createWindowsShortcut() {
  const desktop = windowsDesktop();
  fs.mkdirSync(desktop, { recursive: true });

  // A tiny VBScript starts Node without a console window, so the PMS behaves
  // like a desktop app rather than a command prompt plus website.
  const dataDir = path.join(ROOT, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const vbsPath = path.join(dataDir, 'launch-hidden.vbs');
  const vbs = [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = "${ROOT.replace(/"/g, '""')}"`,
    `shell.Run Chr(34) & "${process.execPath.replace(/"/g, '""')}" & Chr(34) & " " & Chr(34) & "${LAUNCH_SCRIPT.replace(/"/g, '""')}" & Chr(34), 0, False`
  ].join('\r\n');
  fs.writeFileSync(vbsPath, `${vbs}\r\n`);

  const target = path.join(desktop, `${APP_NAME}.lnk`);
  const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
  const script = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$s = $ws.CreateShortcut('${quotePowerShell(target)}')`,
    `$s.TargetPath = '${quotePowerShell(wscript)}'`,
    `$s.Arguments = '"${quotePowerShell(vbsPath)}"'`,
    `$s.WorkingDirectory = '${quotePowerShell(ROOT)}'`,
    `$s.Description = '${APP_NAME} - Hotel, Restaurant & Property Management'`,
    `$s.IconLocation = '${quotePowerShell(path.join(ROOT, 'public', 'nexuzy.ico'))}'`,
    '$s.WindowStyle = 7',
    '$s.Save()'
  ].join('\n');

  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: 'ignore' });
  return target;
}

function linuxEntry() {
  return [
    '[Desktop Entry]',
    'Version=1.0',
    'Type=Application',
    'Name=Nexuzy PMS',
    'Comment=Hotel, Restaurant and Property Management',
    `Exec="${process.execPath}" "${LAUNCH_SCRIPT}"`,
    `Path=${ROOT}`,
    `Icon=${path.join(ROOT, 'public', 'logo.png')}`,
    'Terminal=false',
    'StartupNotify=true',
    'Categories=Office;Finance;',
    ''
  ].join('\n');
}

function createLinuxShortcut() {
  const home = os.homedir();
  const content = linuxEntry();
  const appDir = path.join(home, '.local', 'share', 'applications');
  fs.mkdirSync(appDir, { recursive: true });
  const appFile = path.join(appDir, 'nexuzy-pms.desktop');
  fs.writeFileSync(appFile, content, { mode: 0o755 });

  const desktop = path.join(home, 'Desktop');
  if (fs.existsSync(desktop)) {
    const desktopFile = path.join(desktop, 'Nexuzy PMS.desktop');
    fs.writeFileSync(desktopFile, content, { mode: 0o755 });
    try { fs.chmodSync(desktopFile, 0o755); } catch (err) { /* managed desktop */ }
    return desktopFile;
  }
  return appFile;
}

function createMacShortcut() {
  const appsDir = path.join(os.homedir(), 'Applications');
  const bundle = path.join(appsDir, `${APP_NAME}.app`);
  const contents = path.join(bundle, 'Contents');
  const macos = path.join(contents, 'MacOS');
  const resources = path.join(contents, 'Resources');
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });

  const executable = path.join(macos, APP_NAME);
  fs.writeFileSync(
    executable,
    `#!/bin/bash\ncd "${ROOT}"\nexec "${process.execPath}" "${LAUNCH_SCRIPT}"\n`,
    { mode: 0o755 }
  );
  try { fs.chmodSync(executable, 0o755); } catch (err) { /* ignore */ }

  fs.writeFileSync(path.join(contents, 'Info.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>CFBundleName</key><string>Nexuzy PMS</string>',
    '  <key>CFBundleDisplayName</key><string>Nexuzy PMS</string>',
    `  <key>CFBundleExecutable</key><string>${APP_NAME}</string>`,
    '  <key>CFBundleIdentifier</key><string>in.nexuzy.pms</string>',
    '  <key>CFBundleVersion</key><string>1.0</string>',
    '  <key>CFBundleShortVersionString</key><string>1.0</string>',
    '  <key>CFBundlePackageType</key><string>APPL</string>',
    '  <key>LSMinimumSystemVersion</key><string>10.13</string>',
    '  <key>NSHighResolutionCapable</key><true/>',
    '</dict>',
    '</plist>',
    ''
  ].join('\n'));

  const desktop = path.join(os.homedir(), 'Desktop');
  fs.mkdirSync(desktop, { recursive: true });
  const alias = path.join(desktop, `${APP_NAME}.app`);
  try {
    fs.rmSync(alias, { recursive: true, force: true });
    fs.symlinkSync(bundle, alias);
    return alias;
  } catch (err) {
    return bundle;
  }
}

function createShortcut() {
  if (process.platform === 'win32') return createWindowsShortcut();
  if (process.platform === 'darwin') return createMacShortcut();
  if (process.platform === 'linux') return createLinuxShortcut();
  throw new Error(`Desktop shortcuts are not supported on ${process.platform}`);
}

if (require.main === module) {
  try {
    const created = createShortcut();
    console.log(`Desktop app shortcut created: ${created}`);
    console.log('It opens Nexuzy PMS in its own window and starts the local server automatically.');
  } catch (err) {
    console.error(`Shortcut could not be created: ${err.message}`);
    console.error('The PMS still runs normally with start.bat / ./start.sh / npm start.');
    process.exitCode = 1;
  }
}

module.exports = { createShortcut };
