#!/usr/bin/env node
// Builds a single-file Windows installer for Nexuzy PMS.
//
// The installer payload carries:
//   * the exact Node.js runtime this build uses (so native sqlite3 ABI matches)
//   * production node_modules, already installed
//   * the application, icon and a hidden-window launcher
//
// The target hotel PC therefore needs no Node.js, npm or internet connection.
// Inno Setup 6 compiles the payload into dist/installer/Nexuzy-PMS-Setup-x.y.z.exe.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const INSTALLER_DIR = __dirname;
const BUILD_DIR = path.join(INSTALLER_DIR, 'build');
const PAYLOAD_DIR = path.join(BUILD_DIR, 'payload');
const VENDOR_DIR = path.join(INSTALLER_DIR, 'vendor');
const DIST_DIR = path.join(ROOT, 'dist', 'installer');
const pkg = require(path.join(ROOT, 'package.json'));

const NODE_VERSION = process.version;
const NODE_ZIP_NAME = `node-${NODE_VERSION}-win-x64.zip`;
const NODE_DIST = `https://nodejs.org/dist/${NODE_VERSION}`;
const APP_ENTRIES = [
  'package.json',
  'package-lock.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'start.bat',
  'enable-lan-firewall.bat',
  'server',
  'public',
  'scripts',
  'docs'
];

function log(message) {
  console.log(`[installer] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}`);
  }
}

function payloadPath(entry) {
  return path.join(PAYLOAD_DIR, entry);
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, buffer);
  return buffer;
}

async function prepareNodeRuntime() {
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  const zipPath = path.join(VENDOR_DIR, NODE_ZIP_NAME);

  if (!fs.existsSync(zipPath)) {
    log(`downloading Node.js ${NODE_VERSION} (win-x64)`);
    await download(`${NODE_DIST}/${NODE_ZIP_NAME}`, zipPath);
  } else {
    log(`using cached ${NODE_ZIP_NAME}`);
  }

  log('verifying Node.js download checksum');
  const sumsResponse = await fetch(`${NODE_DIST}/SHASUMS256.txt`, { redirect: 'follow' });
  if (!sumsResponse.ok) throw new Error(`Could not download SHASUMS256.txt (${sumsResponse.status})`);
  const sums = await sumsResponse.text();
  const line = sums.split(/\r?\n/).find(row => row.trim().endsWith(` ${NODE_ZIP_NAME}`));
  if (!line) throw new Error(`No checksum published for ${NODE_ZIP_NAME}`);
  const expected = line.trim().split(/\s+/)[0];
  const actual = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
  if (actual !== expected) {
    throw new Error(`Node.js checksum mismatch for ${NODE_ZIP_NAME}: expected ${expected}, got ${actual}`);
  }

  const extractDir = path.join(BUILD_DIR, 'node-extract');
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  log('extracting Node.js runtime');
  const quote = value => `'${value.replace(/'/g, "''")}'`;
  run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command',
    `Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(extractDir)} -Force`
  ]);

  const extracted = path.join(extractDir, NODE_ZIP_NAME.replace(/\.zip$/i, ''));
  if (!fs.existsSync(path.join(extracted, 'node.exe'))) {
    throw new Error('The Node.js archive did not contain node.exe');
  }

  const target = payloadPath('node');
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(extracted, target, { recursive: true });

  // npm/npx are build tools, not runtime requirements. Dropping them keeps the
  // installer smaller without affecting the PMS.
  for (const unused of ['node_modules', 'npm', 'npm.cmd', 'npx', 'npx.cmd', 'corepack', 'corepack.cmd', 'install_tools.bat']) {
    fs.rmSync(path.join(target, unused), { recursive: true, force: true });
  }
  fs.rmSync(extractDir, { recursive: true, force: true });

  return path.join(target, 'node.exe');
}

function writeLauncher() {
  // The launcher lives beside node\ and works regardless of the install path,
  // so no path has to be baked into the installer at build time.
  const launcher = [
    'Option Explicit',
    'Dim fso, shell, root',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'root = fso.GetParentFolderName(WScript.ScriptFullName)',
    'Set shell = CreateObject("WScript.Shell")',
    'shell.CurrentDirectory = root',
    'shell.Run Chr(34) & root & "\\node\\node.exe" & Chr(34) & " " & Chr(34) & root & "\\scripts\\launch.js" & Chr(34), 0, False',
    ''
  ].join('\r\n');
  fs.writeFileSync(payloadPath('Nexuzy PMS.vbs'), launcher, 'utf8');
}

function createIcon() {
  const target = payloadPath('nexuzy.ico');
  const customIcon = path.join(INSTALLER_DIR, 'assets', 'nexuzy.ico');
  if (fs.existsSync(customIcon)) {
    fs.copyFileSync(customIcon, target);
    log('using installer/assets/nexuzy.ico for Setup and shortcuts');
    return target;
  }

  const png = path.join(ROOT, 'public', 'favicon.png');
  const logo = path.join(ROOT, 'public', 'logo.png');
  const source = fs.existsSync(png) ? png : logo;
  if (!fs.existsSync(source)) {
    log('no icon source found; using the bundled setup icon fallback');
    return target;
  }

  log('generating application icon');
  const quote = value => `'${value.replace(/'/g, "''")}'`;
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    `$source = ${quote(source)}`,
    `$target = ${quote(target)}`,
    '$image = [System.Drawing.Image]::FromFile($source)',
    '$bitmap = New-Object System.Drawing.Bitmap 256, 256',
    '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
    '$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '$graphics.DrawImage($image, 0, 0, 256, 256)',
    '$graphics.Dispose()',
    '$icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())',
    '$stream = [System.IO.File]::Create($target)',
    '$icon.Save($stream)',
    '$stream.Close()',
    '$icon.Dispose()',
    '$bitmap.Dispose()',
    '$image.Dispose()'
  ].join('\n');
  run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  return target;
}

function findInnoCompiler() {
  const candidates = [
    process.env.INNO_SETUP_ISCC,
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files (x86)\\Inno Setup 5\\ISCC.exe'
  ].filter(Boolean);
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) {
    throw new Error('Inno Setup 6 was not found. Install it from https://jrsoftware.org/isinfo.php or set INNO_SETUP_ISCC to ISCC.exe.');
  }
  return found;
}

function version4(version) {
  const parts = String(version).split('.').map(part => Number.parseInt(part, 10) || 0);
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4).join('.');
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('The installer build is Windows-only: it bundles the win-x64 Node.js runtime.');
  }
  if (process.arch !== 'x64') {
    throw new Error('Build the installer on 64-bit Windows so the bundled native sqlite3 binding matches.');
  }

  log(`building Nexuzy PMS ${pkg.version} installer`);
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  fs.mkdirSync(PAYLOAD_DIR, { recursive: true });

  for (const entry of APP_ENTRIES) {
    const source = path.join(ROOT, entry);
    if (!fs.existsSync(source)) {
      log(`skipping missing ${entry}`);
      continue;
    }
    fs.cpSync(source, payloadPath(entry), {
      recursive: true,
      filter: src => !/(^|[\\/])(data|node_modules|\.git|dist|backups|installer)([\\/]|$)/.test(
        path.relative(ROOT, src)
      )
    });
  }

  log('installing production dependencies into the payload');
  run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: PAYLOAD_DIR,
    shell: true
  });

  const nodeExe = await prepareNodeRuntime();
  writeLauncher();
  createIcon();

  log('checking the bundled runtime loads sqlite3, pdfkit and express');
  run(nodeExe, ['-e', "require('sqlite3'); require('pdfkit'); require('express'); console.log('bundled runtime deps ok')"], {
    cwd: PAYLOAD_DIR
  });

  const iscc = findInnoCompiler();
  const template = fs.readFileSync(path.join(INSTALLER_DIR, 'nexuzy-pms.iss'), 'utf8');
  const generated = template
    .replaceAll('{{APP_VERSION}}', pkg.version)
    .replaceAll('{{VERSION4}}', version4(pkg.version))
    .replaceAll('{{PAYLOAD}}', PAYLOAD_DIR)
    .replaceAll('{{OUTPUT_DIR}}', DIST_DIR)
    .replaceAll('{{ICON}}', payloadPath('nexuzy.ico'))
    .replaceAll('{{LICENSE}}', path.join(ROOT, 'LICENSE'));
  const scriptPath = path.join(BUILD_DIR, 'nexuzy-pms.iss');
  fs.writeFileSync(scriptPath, generated, 'utf8');

  fs.mkdirSync(DIST_DIR, { recursive: true });
  log('compiling installer with Inno Setup');
  run(iscc, [scriptPath, '/Qp']);

  const setupPath = path.join(DIST_DIR, `Nexuzy-PMS-Setup-${pkg.version}.exe`);
  if (!fs.existsSync(setupPath)) throw new Error(`Installer was not created at ${setupPath}`);
  const stats = fs.statSync(setupPath);
  if (stats.size < 1024 * 1024) throw new Error(`Installer is unexpectedly small (${stats.size} bytes)`);

  const digest = crypto.createHash('sha256').update(fs.readFileSync(setupPath)).digest('hex');
  fs.writeFileSync(`${setupPath}.sha256`, `${digest}  ${path.basename(setupPath)}\n`, 'utf8');

  log(`created ${setupPath}`);
  log(`size: ${(stats.size / (1024 * 1024)).toFixed(1)} MB`);
  log(`sha256: ${digest}`);
}

main().catch(err => {
  console.error(`[installer] ${err.message}`);
  process.exitCode = 1;
});
