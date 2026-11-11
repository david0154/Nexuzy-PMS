// Collects the built Windows, Linux and macOS installers into one release ZIP.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const version = pkg.version;
const installerDir = path.join(root, 'dist', 'installer');
const stageDir = path.join(root, 'dist', 'installer-bundle');
const bundleName = `Nexuzy-PMS-${version}-all-platforms`;
const zipPath = path.join(installerDir, `${bundleName}.zip`);

const requiredArtifacts = [
  `Nexuzy-PMS-Setup-${version}.exe`,
  `Nexuzy-PMS-${version}-linux-x64.run`,
  `Nexuzy-PMS-${version}-linux-x64.tar.gz`,
  `Nexuzy-PMS-${version}-macos-arm64.tar.gz`,
  `Nexuzy-PMS-${version}-macos-x64.tar.gz`
];

function fail(message) {
  console.error(`[bundle] ${message}`);
  process.exit(1);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

if (!fs.existsSync(installerDir)) {
  fail(`Installer output folder does not exist: ${installerDir}. Run npm run build:installers first.`);
}

const missing = requiredArtifacts.filter(name => !fs.existsSync(path.join(installerDir, name)));
if (missing.length) {
  fail(`Missing built installer(s):\n  ${missing.join('\n  ')}\nRun npm run build:installers first.`);
}

fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

const included = [];
const sums = [];
for (const name of requiredArtifacts) {
  const source = path.join(installerDir, name);
  const target = path.join(stageDir, name);
  fs.copyFileSync(source, target);
  included.push(name);
  sums.push(`${sha256(source)}  ${name}`);

  const sidecar = `${source}.sha256`;
  if (fs.existsSync(sidecar)) {
    fs.copyFileSync(sidecar, path.join(stageDir, path.basename(sidecar)));
    included.push(path.basename(sidecar));
  }
}

fs.writeFileSync(path.join(stageDir, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
fs.writeFileSync(path.join(stageDir, 'INSTALL.txt'), [
  `Nexuzy PMS ${version} — all-platform installer bundle`,
  '',
  'Windows (64-bit):',
  `  1. Run Nexuzy-PMS-Setup-${version}.exe`,
  '  2. Keep the existing data folder when upgrading.',
  '  3. Uninstall from Settings > About, Support & Uninstall, or Windows Apps.',
  '',
  'Linux (64-bit glibc):',
  `  chmod +x Nexuzy-PMS-${version}-linux-x64.run`,
  `  ./Nexuzy-PMS-${version}-linux-x64.run`,
  '  Or extract the .tar.gz and run ./install.sh.',
  '  Uninstall from Settings > About, Support & Uninstall, or run uninstall.sh.',
  '',
  'macOS:',
  `  Apple Silicon: extract Nexuzy-PMS-${version}-macos-arm64.tar.gz.`,
  `  Intel:         extract Nexuzy-PMS-${version}-macos-x64.tar.gz.`,
  '  Double-click "Install Nexuzy PMS.command".',
  '  If Gatekeeper blocks it, right-click the app and choose Open.',
  '  Uninstall from Settings > About, Support & Uninstall.',
  '',
  'Hotel data is preserved on upgrade and uninstall. Take a backup before upgrading.',
  'Verify each installer against SHA256SUMS.txt before running it.',
  '',
  `Published files: ${included.length + 2}`,
  ''
].join('\n'));

const isWindows = process.platform === 'win32';
let result;
if (isWindows) {
  const quote = value => `'${value.replace(/'/g, "''")}'`;
  result = spawnSync('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Compress-Archive -Path ${quote(path.join(stageDir, '*'))} -DestinationPath ${quote(zipPath)} -Force`
  ], { stdio: 'inherit' });
} else {
  result = spawnSync('zip', ['-rq', zipPath, '.'], { cwd: stageDir, stdio: 'inherit' });
}

if (!result || result.status !== 0 || !fs.existsSync(zipPath)) {
  fail('Could not create the ZIP. On Linux, install the `zip` package and rerun npm run package:installers.');
}

const bundleBuffer = fs.readFileSync(zipPath);
const bundleHash = crypto.createHash('sha256').update(bundleBuffer).digest('hex');
fs.writeFileSync(`${zipPath}.sha256`, `${bundleHash}  ${path.basename(zipPath)}\n`);
fs.rmSync(stageDir, { recursive: true, force: true });

console.log(`✓ Bundle: ${path.relative(root, zipPath)} (${(bundleBuffer.length / 1024 / 1024).toFixed(1)} MB)`);
console.log(`✓ Contains: ${included.join(', ')}`);
console.log(`✓ Checksum: ${bundleHash}`);
console.log(`✓ Checksum file: ${path.relative(root, zipPath)}.sha256`);
