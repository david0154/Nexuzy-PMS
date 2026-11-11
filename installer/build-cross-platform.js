#!/usr/bin/env node
// Builds Linux x64 and macOS (x64 + arm64) installers from Windows, Linux or
// macOS. Each package carries the matching Node.js runtime and the matching
// prebuilt N-API SQLite binding, so the target PC needs no Node.js install.
//
// Linux:  Nexuzy-PMS-<version>-linux-x64.tar.gz and a self-extracting .run
// macOS:  Nexuzy-PMS-<version>-macos-<arch>.tar.gz containing
//         "Nexuzy PMS.app" and "Install Nexuzy PMS.command"
//
// macOS .dmg/.pkg creation and signing require macOS tooling; the .app bundle
// is the portable installer payload and can be zipped or placed in a DMG later.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const INSTALLER_DIR = __dirname;
const BUILD_DIR = path.join(INSTALLER_DIR, 'build-cross');
const COMMON_DIR = path.join(BUILD_DIR, 'common');
const DIST_DIR = path.join(ROOT, 'dist', 'installer');
const VENDOR_DIR = path.join(INSTALLER_DIR, 'vendor');
const ICON_SOURCE = path.join(INSTALLER_DIR, 'assets', 'nexuzy.ico');
const pkg = require(path.join(ROOT, 'package.json'));
const NODE_VERSION = process.version;
const NODE_DIST = `https://nodejs.org/dist/${NODE_VERSION}`;
const SQLITE_DIST = 'https://github.com/TryGhost/node-sqlite3/releases/download/v6.0.1';

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

const TARGETS = [
  {
    id: 'linux-x64',
    kind: 'linux',
    arch: 'x64',
    nodeArchive: `node-${NODE_VERSION}-linux-x64.tar.xz`,
    nodeDir: `node-${NODE_VERSION}-linux-x64`,
    sqliteArchive: 'sqlite3-v6.0.1-napi-v6-linux-x64.tar.gz'
  },
  {
    id: 'darwin-x64',
    kind: 'mac',
    arch: 'x64',
    nodeArchive: `node-${NODE_VERSION}-darwin-x64.tar.gz`,
    nodeDir: `node-${NODE_VERSION}-darwin-x64`,
    sqliteArchive: 'sqlite3-v6.0.1-napi-v6-darwin-x64.tar.gz'
  },
  {
    id: 'darwin-arm64',
    kind: 'mac',
    arch: 'arm64',
    nodeArchive: `node-${NODE_VERSION}-darwin-arm64.tar.gz`,
    nodeDir: `node-${NODE_VERSION}-darwin-arm64`,
    sqliteArchive: 'sqlite3-v6.0.1-napi-v6-darwin-arm64.tar.gz'
  }
];

function log(message) {
  console.log(`[cross] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}`);
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

async function download(url, destination) {
  log(`downloading ${path.basename(destination)}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, buffer);
  return buffer;
}

async function ensureDownload(url, destination) {
  ensureDirectory(path.dirname(destination));
  if (fs.existsSync(destination) && fs.statSync(destination).size > 0) return destination;
  await download(url, destination);
  return destination;
}

async function verifyNodeArchives() {
  const response = await fetch(`${NODE_DIST}/SHASUMS256.txt`, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Could not download Node checksums (${response.status})`);
  const sums = await response.text();
  for (const target of TARGETS) {
    const archive = path.join(VENDOR_DIR, target.nodeArchive);
    const line = sums.split(/\r?\n/).find(row => row.trim().endsWith(` ${target.nodeArchive}`));
    if (!line) throw new Error(`No published checksum for ${target.nodeArchive}`);
    const expected = line.trim().split(/\s+/)[0];
    const actual = sha256(archive);
    if (actual !== expected) throw new Error(`Checksum mismatch for ${target.nodeArchive}`);
    log(`verified ${target.nodeArchive}`);
  }
}

function copyApplication(destination) {
  for (const entry of APP_ENTRIES) {
    const source = path.join(ROOT, entry);
    if (!fs.existsSync(source)) {
      log(`skipping missing ${entry}`);
      continue;
    }
    fs.cpSync(source, path.join(destination, entry), {
      recursive: true,
      filter: src => !/(^|[\\/])(data|node_modules|\.git|dist|backups|installer)([\\/]|$)/.test(
        path.relative(ROOT, src)
      )
    });
  }
}

function relativeToRoot(target) {
  const relative = path.relative(ROOT, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path must stay inside the project: ${target}`);
  }
  return relative.replace(/\\/g, '/');
}

function extractArchive(archive, destination, xz = false) {
  ensureDirectory(destination);
  // --force-local keeps Windows GNU tar from treating "C:\..." as a remote host.
  run('tar', [xz ? '-xJf' : '-xzf', relativeToRoot(archive), '-C', relativeToRoot(destination)], {
    cwd: ROOT
  });
}

function stageNode(target, rootDir) {
  const archive = path.join(VENDOR_DIR, target.nodeArchive);
  const extractDir = path.join(BUILD_DIR, `node-${target.id}`);
  fs.rmSync(extractDir, { recursive: true, force: true });
  extractArchive(archive, extractDir, target.nodeArchive.endsWith('.xz'));

  const source = path.join(extractDir, target.nodeDir, 'bin', 'node');
  if (!fs.existsSync(source)) throw new Error(`node runtime missing in ${target.nodeArchive}`);
  const destination = path.join(rootDir, 'node', 'bin', 'node');
  ensureDirectory(path.dirname(destination));
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o755);

  const license = path.join(extractDir, target.nodeDir, 'LICENSE');
  if (fs.existsSync(license)) fs.copyFileSync(license, path.join(rootDir, 'node', 'LICENSE'));
  fs.rmSync(extractDir, { recursive: true, force: true });
}

function stageSqlite(target, appDir) {
  const archive = path.join(VENDOR_DIR, 'sqlite3', target.sqliteArchive);
  const extractDir = path.join(BUILD_DIR, `sqlite-${target.id}`);
  fs.rmSync(extractDir, { recursive: true, force: true });
  extractArchive(archive, extractDir, false);

  const source = path.join(extractDir, 'build', 'Release', 'node_sqlite3.node');
  if (!fs.existsSync(source)) throw new Error(`SQLite binding missing in ${target.sqliteArchive}`);
  const destination = path.join(appDir, 'node_modules', 'sqlite3', 'build', 'Release', 'node_sqlite3.node');
  ensureDirectory(path.dirname(destination));
  fs.copyFileSync(source, destination);
  if (fs.statSync(destination).size < 1024) throw new Error(`SQLite binding is unexpectedly small for ${target.id}`);
  fs.rmSync(extractDir, { recursive: true, force: true });
}

function copyCommon(destination) {
  ensureDirectory(destination);
  fs.cpSync(COMMON_DIR, destination, { recursive: true });
}

function writeFile(destination, content, mode) {
  ensureDirectory(path.dirname(destination));
  fs.writeFileSync(destination, content);
  if (mode) fs.chmodSync(destination, mode);
}

// ---------- ICO -> PNG / ICNS (no external image tools) ----------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let crcTable = null;

function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function readIcoFrame(icoPath, requestedSize) {
  const ico = fs.readFileSync(icoPath);
  const count = ico.readUInt16LE(4);
  let chosen = null;
  for (let i = 0; i < count; i += 1) {
    const offset = 6 + i * 16;
    const width = ico[offset] || 256;
    const height = ico[offset + 1] || 256;
    const bytes = ico.readUInt32LE(offset + 8);
    const dataOffset = ico.readUInt32LE(offset + 12);
    const candidate = { width, height, bytes, dataOffset };
    if (!chosen || width === requestedSize || (width > chosen.width && chosen.width !== requestedSize)) {
      chosen = candidate;
    }
  }
  if (!chosen) throw new Error(`No icon frames found in ${icoPath}`);

  const data = ico.subarray(chosen.dataOffset, chosen.dataOffset + chosen.bytes);
  if (data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { png: data, width: chosen.width };
  }

  // 32-bit DIB frame (BITMAPINFOHEADER + BGRA pixels + AND mask).
  const headerSize = data.readUInt32LE(0);
  const width = data.readInt32LE(4);
  const height = Math.abs(data.readInt32LE(8)) / 2;
  const bpp = data.readUInt16LE(14);
  if (bpp !== 32) throw new Error(`Unsupported ${bpp}-bit ICO frame`);

  const pixelOffset = headerSize;
  const maskOffset = pixelOffset + width * height * 4;
  const maskRowBytes = Math.ceil(width / 32) * 4;
  const rgba = Buffer.alloc(width * height * 4);
  let hasAlpha = false;
  for (let i = 3; i < width * height * 4; i += 4) {
    if (data[pixelOffset + i] !== 0) { hasAlpha = true; break; }
  }

  for (let y = 0; y < height; y += 1) {
    const sourceRow = pixelOffset + (height - 1 - y) * width * 4;
    const maskRow = maskOffset + (height - 1 - y) * maskRowBytes;
    for (let x = 0; x < width; x += 1) {
      const source = sourceRow + x * 4;
      const target = (y * width + x) * 4;
      rgba[target] = data[source + 2];
      rgba[target + 1] = data[source + 1];
      rgba[target + 2] = data[source];
      if (hasAlpha) {
        rgba[target + 3] = data[source + 3];
      } else {
        const transparent = (data[maskRow + (x >> 3)] >> (7 - (x & 7))) & 1;
        rgba[target + 3] = transparent ? 0 : 255;
      }
    }
  }
  return { png: encodePng(width, height, rgba), width };
}

function icnsType(width) {
  if (width >= 512) return 'ic09';
  if (width >= 256) return 'ic08';
  if (width >= 128) return 'ic07';
  if (width >= 64) return 'ic06';
  if (width >= 32) return 'ic05';
  return 'icp4';
}

function writeIcons(destination) {
  const frame = readIcoFrame(ICON_SOURCE, 256);
  writeFile(path.join(destination, 'nexuzy.png'), frame.png, 0o644);

  const entry = Buffer.alloc(8 + frame.png.length);
  entry.write(icnsType(frame.width), 0, 'ascii');
  entry.writeUInt32BE(entry.length, 4);
  frame.png.copy(entry, 8);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(header.length + entry.length, 4);
  writeFile(path.join(destination, 'nexuzy.icns'), Buffer.concat([header, entry]), 0o644);
}

// ---------- Linux ----------

const LINUX_LAUNCH = [
  '#!/bin/sh',
  'cd "$(dirname "$0")" || exit 1',
  'exec ./node/bin/node scripts/launch.js',
  ''
].join('\n');

const LINUX_INSTALL = [
  '#!/bin/sh',
  'set -e',
  'HERE=$(cd "$(dirname "$0")" && pwd)',
  'TARGET="${NEXUZY_INSTALL_DIR:-$HOME/.local/share/nexuzy-pms}"',
  'if [ "$HERE" = "$TARGET" ]; then',
  '  echo "Run install.sh from the extracted Nexuzy PMS package."',
  '  exit 1',
  'fi',
  'mkdir -p "$TARGET"',
  'cp -a "$HERE"/. "$TARGET"/',
  'chmod +x "$TARGET/node/bin/node" "$TARGET/launch.sh" "$TARGET/install.sh" "$TARGET/uninstall.sh"',
  'APPS="$HOME/.local/share/applications"',
  'mkdir -p "$APPS"',
  'DESKTOP="$APPS/nexuzy-pms.desktop"',
  'cat > "$DESKTOP" <<EOF',
  '[Desktop Entry]',
  'Version=1.0',
  'Type=Application',
  'Name=Nexuzy PMS',
  'Comment=Hotel, Restaurant and Property Management',
  'Exec="$TARGET/launch.sh"',
  'Path=$TARGET',
  'Icon=$TARGET/nexuzy.png',
  'Terminal=false',
  'StartupNotify=true',
  'Categories=Office;Finance;',
  'EOF',
  'chmod +x "$DESKTOP"',
  'if [ -d "$HOME/Desktop" ]; then',
  '  cp "$DESKTOP" "$HOME/Desktop/nexuzy-pms.desktop"',
  '  chmod +x "$HOME/Desktop/nexuzy-pms.desktop"',
  'fi',
  'echo "Nexuzy PMS installed to $TARGET"',
  'echo "Launch it from the application menu, the desktop shortcut, or $TARGET/launch.sh"',
  'if [ "$1" != "--no-launch" ]; then',
  '  (nohup "$TARGET/launch.sh" >/dev/null 2>&1 &)',
  'fi',
  ''
].join('\n');

const LINUX_UNINSTALL = [
  '#!/bin/sh',
  'set -e',
  'TARGET=$(cd "$(dirname "$0")" && pwd)',
  'if [ "$1" != "--run" ]; then',
  '  TMP="${TMPDIR:-/tmp}/nexuzy-uninstall-$$.sh"',
  '  cp "$0" "$TMP"',
  '  chmod +x "$TMP"',
  '  exec sh "$TMP" --run "$TARGET"',
  'fi',
  'TARGET="$2"',
  'rm -f "$HOME/.local/share/applications/nexuzy-pms.desktop"',
  'rm -f "$HOME/Desktop/nexuzy-pms.desktop"',
  'if [ -d "$TARGET/data" ]; then',
  '  find "$TARGET" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} +',
  '  echo "Nexuzy PMS removed. Hotel data is preserved in $TARGET/data"',
  'else',
  '  cd "$HOME"',
  '  rm -rf "$TARGET"',
  '  echo "Nexuzy PMS removed."',
  'fi',
  ''
].join('\n');

function buildLinux(target) {
  const folderName = 'Nexuzy-PMS-linux-x64';
  const packageRoot = path.join(BUILD_DIR, target.id, folderName);
  copyCommon(packageRoot);
  stageNode(target, packageRoot);
  stageSqlite(target, packageRoot);
  writeIcons(packageRoot);
  writeFile(path.join(packageRoot, 'launch.sh'), LINUX_LAUNCH, 0o755);
  writeFile(path.join(packageRoot, 'install.sh'), LINUX_INSTALL, 0o755);
  writeFile(path.join(packageRoot, 'uninstall.sh'), LINUX_UNINSTALL, 0o755);
  writeFile(path.join(packageRoot, 'README-LINUX.txt'), linuxReadme(), 0o644);

  const tarPath = path.join(DIST_DIR, `Nexuzy-PMS-${pkg.version}-linux-x64.tar.gz`);
  const runPath = path.join(DIST_DIR, `Nexuzy-PMS-${pkg.version}-linux-x64.run`);
  makeTar(path.join(BUILD_DIR, target.id), folderName, tarPath);
  makeSelfExtracting(tarPath, runPath, folderName);
  writeChecksum(tarPath);
  writeChecksum(runPath);
  log(`created ${tarPath}`);
  log(`created ${runPath}`);
}

function linuxReadme() {
  return [
    `Nexuzy PMS ${pkg.version} for Linux x64`,
    '',
    'This package already contains Node.js and SQLite; no Node.js install is needed.',
    '',
    'Easy install:',
    '  1. chmod +x Nexuzy-PMS-' + pkg.version + '-linux-x64.run',
    '  2. ./Nexuzy-PMS-' + pkg.version + '-linux-x64.run',
    '',
    'Or from the tar.gz:',
    '  tar -xzf Nexuzy-PMS-' + pkg.version + '-linux-x64.tar.gz',
    '  cd Nexuzy-PMS-linux-x64',
    '  ./install.sh',
    '',
    'Installs to ~/.local/share/nexuzy-pms and creates an application-menu',
    'entry plus a desktop shortcut. Use NEXUZY_INSTALL_DIR to choose another',
    'folder. Hotel data stays in the install folder and is preserved on upgrade.',
    '',
    'To uninstall, use Settings > About, Support & Uninstall inside the app.',
    'Hotel data is retained in the install folder. You can also run',
    '  ~/.local/share/nexuzy-pms/uninstall.sh',
    '',
    'The app window uses Chrome, Chromium, Edge or Brave when available;',
    'otherwise Nexuzy PMS opens in the default browser.',
    ''
  ].join('\n');
}

function makeTar(parent, entry, output) {
  ensureDirectory(path.dirname(output));
  run('tar', ['--mode=u+rwx,go+rx', '-czf', relativeToRoot(output), '-C', relativeToRoot(parent), entry], {
    cwd: ROOT
  });
}

function makeSelfExtracting(tarPath, output, folderName) {
  const header = [
    '#!/bin/sh',
    'set -e',
    'TMP=$(mktemp -d)',
    'trap \'rm -rf "$TMP"\' EXIT',
    'MARKER=__NEXUZY_ARCHIVE_BELOW__',
    'LINE=$(awk "/^$MARKER$/{print NR+1; exit}" "$0")',
    'tail -n +$LINE "$0" | tar -xz -C "$TMP"',
    'sh "$TMP/' + folderName + '/install.sh" "$@"',
    '__NEXUZY_ARCHIVE_BELOW__',
    ''
  ].join('\n');
  fs.writeFileSync(output, Buffer.concat([Buffer.from(header), fs.readFileSync(tarPath)]));
}

function writeChecksum(file) {
  fs.writeFileSync(`${file}.sha256`, `${sha256(file)}  ${path.basename(file)}\n`, 'utf8');
}

// ---------- macOS ----------

const MAC_LAUNCH = [
  '#!/bin/bash',
  'set -e',
  'RES="$(cd "$(dirname "$0")/../Resources" && pwd)"',
  'DATA="$HOME/Library/Application Support/Nexuzy PMS"',
  'mkdir -p "$DATA/data"',
  'export DB_PATH="$DATA/data/nexuzy.db"',
  'cd "$RES/app"',
  'exec "$RES/node/bin/node" "$RES/app/scripts/launch.js"',
  ''
].join('\n');

const MAC_UNINSTALL = [
  '#!/bin/bash',
  'set -e',
  'APP="$(cd "$(dirname "$0")/../.." && pwd)"',
  'rm -f "$HOME/Desktop/Nexuzy PMS.app"',
  'rm -rf "$APP"',
  'echo "Nexuzy PMS removed. Hotel data is preserved in $HOME/Library/Application Support/Nexuzy PMS"',
  ''
].join('\n');

const MAC_INSTALL = [
  '#!/bin/bash',
  'set -e',
  'HERE="$(cd "$(dirname "$0")" && pwd)"',
  'DEST="$HOME/Applications"',
  'mkdir -p "$DEST"',
  'rm -rf "$DEST/Nexuzy PMS.app"',
  'cp -R "$HERE/Nexuzy PMS.app" "$DEST/"',
  'xattr -dr com.apple.quarantine "$DEST/Nexuzy PMS.app" 2>/dev/null || true',
  'mkdir -p "$HOME/Desktop"',
  'ln -sfn "$DEST/Nexuzy PMS.app" "$HOME/Desktop/Nexuzy PMS.app" 2>/dev/null || true',
  'open "$DEST/Nexuzy PMS.app"',
  ''
].join('\n');

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Nexuzy PMS</string>
  <key>CFBundleDisplayName</key><string>Nexuzy PMS</string>
  <key>CFBundleExecutable</key><string>Nexuzy PMS</string>
  <key>CFBundleIdentifier</key><string>in.nexuzy.pms</string>
  <key>CFBundleIconFile</key><string>nexuzy.icns</string>
  <key>CFBundleVersion</key><string>${pkg.version}</string>
  <key>CFBundleShortVersionString</key><string>${pkg.version}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>10.15</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;
}

function buildMac(target) {
  const folderName = `Nexuzy-PMS-macos-${target.arch}`;
  const packageRoot = path.join(BUILD_DIR, target.id, folderName);
  const appRoot = path.join(packageRoot, 'Nexuzy PMS.app');
  const contents = path.join(appRoot, 'Contents');
  const macos = path.join(contents, 'MacOS');
  const resources = path.join(contents, 'Resources');

  ensureDirectory(macos);
  copyCommon(path.join(resources, 'app'));
  stageNode(target, resources);
  stageSqlite(target, path.join(resources, 'app'));
  writeIcons(resources);
  writeFile(path.join(macos, 'Nexuzy PMS'), MAC_LAUNCH, 0o755);
  writeFile(path.join(contents, 'Info.plist'), infoPlist(), 0o644);
  writeFile(path.join(resources, 'uninstall.sh'), MAC_UNINSTALL, 0o755);
  writeFile(path.join(packageRoot, 'Install Nexuzy PMS.command'), MAC_INSTALL, 0o755);
  writeFile(path.join(packageRoot, 'README-macOS.txt'), macReadme(target.arch), 0o644);

  const tarPath = path.join(DIST_DIR, `Nexuzy-PMS-${pkg.version}-macos-${target.arch}.tar.gz`);
  makeTar(path.join(BUILD_DIR, target.id), folderName, tarPath);
  writeChecksum(tarPath);
  log(`created ${tarPath}`);
}

function macReadme(arch) {
  return [
    `Nexuzy PMS ${pkg.version} for macOS ${arch}`,
    '',
    'This package already contains Node.js and SQLite; no Node.js install is needed.',
    '',
    '1. Double-click "Install Nexuzy PMS.command".',
    '2. If macOS blocks it, right-click it and choose Open.',
    '3. The app is copied to ~/Applications and a Desktop shortcut is created.',
    '',
    'Hotel data is stored in ~/Library/Application Support/Nexuzy PMS and',
    'is preserved across upgrades and uninstall.',
    '',
    'To uninstall, use Settings > About, Support & Uninstall inside the app.',
    '',
    'The app is not code-signed or notarized. Gatekeeper may warn on first',
    'launch; right-click the app and choose Open.',
    ''
  ].join('\n');
}

// ---------- build ----------

async function main() {
  if (!fs.existsSync(ICON_SOURCE)) throw new Error(`Missing icon: ${ICON_SOURCE}`);
  if (!['win32', 'linux', 'darwin'].includes(process.platform)) {
    throw new Error(`Unsupported build host: ${process.platform}`);
  }

  log(`building Linux and macOS installers for Nexuzy PMS ${pkg.version}`);
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  ensureDirectory(COMMON_DIR);
  ensureDirectory(DIST_DIR);

  for (const target of TARGETS) {
    await ensureDownload(`${NODE_DIST}/${target.nodeArchive}`, path.join(VENDOR_DIR, target.nodeArchive));
    await ensureDownload(`${SQLITE_DIST}/${target.sqliteArchive}`, path.join(VENDOR_DIR, 'sqlite3', target.sqliteArchive));
  }
  await verifyNodeArchives();

  log('preparing shared application files');
  copyApplication(COMMON_DIR);
  log('installing production dependencies into the shared payload');
  run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: COMMON_DIR,
    shell: true
  });

  for (const target of TARGETS) {
    log(`building ${target.id}`);
    if (target.kind === 'linux') buildLinux(target);
    else buildMac(target);
  }

  log('cross-platform installers complete');
}

main().catch(err => {
  console.error(`[cross] ${err.message}`);
  process.exitCode = 1;
});
