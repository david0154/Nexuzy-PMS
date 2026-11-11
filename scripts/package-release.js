// Builds a clean, versioned release package without development data.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const version = pkg.version;
const distDir = path.join(root, 'dist');
const stageName = `nexuzy-pms-v${version}`;
const stageDir = path.join(distDir, stageName);

const INCLUDE = [
  'server', 'public', 'scripts', 'test', 'docs', 'deploy', '.github',
  'package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md', 'LICENSE',
  'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md', '.env.example',
  'docker-compose.yml', 'Dockerfile', 'install.bat', 'install.sh',
  'start.bat', 'start.sh', 'enable-lan-firewall.bat',
  'installer/README.md', 'installer/build-installer.js',
  'installer/build-cross-platform.js', 'installer/nexuzy-pms.iss',
  'installer/assets'
];

const EXCLUDE_NAMES = new Set(['node_modules', '.git', 'data', 'backups', 'dist', '.env', '.env.local']);

function copyFiltered(source) {
  const base = path.basename(source);
  const relative = path.relative(root, source).replace(/\\/g, '/');
  if (EXCLUDE_NAMES.has(base)) return false;
  if (base.endsWith('.db') || base.endsWith('.db-wal') || base.endsWith('.db-shm')) return false;
  return true;
}

fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

for (const entry of INCLUDE) {
  const source = path.join(root, entry);
  if (!fs.existsSync(source)) continue;
  const target = path.join(stageDir, entry);
  fs.cpSync(source, target, { recursive: true, filter: copyFiltered });
}

fs.writeFileSync(path.join(stageDir, 'VERSION'), `${version}\n`);
fs.writeFileSync(
  path.join(stageDir, 'RELEASE_INFO.txt'),
  [
    `Nexuzy PMS ${version}`,
    `Built: ${new Date().toISOString()}`,
    `Node requirement: ${pkg.engines ? pkg.engines.node : '>=18'}`,
    '',
    'This package contains application code only. It contains no hotel database,',
    'no .env credentials, no uploaded documents and no backups.',
    '',
    'Install: run install.bat (Windows) or ./install.sh (Linux/macOS).',
    'Launch:  run start.bat or ./start.sh. Persistent data stays in data/ and backups/.'
  ].join('\n')
);

const archiveBase = path.join(distDir, stageName);
let archivePath = `${archiveBase}.zip`;

const isWindows = process.platform === 'win32';
let result;
if (isWindows) {
  result = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -Path '${stageDir.replace(/'/g, "''")}\\*' -DestinationPath '${archivePath.replace(/'/g, "''")}' -Force`
  ], { stdio: 'inherit' });
} else {
  result = spawnSync('zip', ['-rq', archivePath, '.'], { cwd: stageDir, stdio: 'inherit' });
}

if (!result || result.status !== 0 || !fs.existsSync(archivePath)) {
  archivePath = `${archiveBase}.tar.gz`;
  const tar = spawnSync('tar', ['-czf', archivePath, '-C', stageDir, '.'], { stdio: 'inherit' });
  if (tar.status !== 0) {
    console.error('Could not create a zip or tar.gz archive. Install zip, or run this on a release runner.');
    process.exit(1);
  }
}

const buffer = fs.readFileSync(archivePath);
const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
fs.writeFileSync(`${archivePath}.sha256`, `${checksum}  ${path.basename(archivePath)}\n`);

console.log(`✓ Built ${path.relative(root, archivePath)} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
console.log(`✓ SHA-256 ${checksum}`);
console.log(`✓ Checksum file ${path.relative(root, archivePath)}.sha256`);
