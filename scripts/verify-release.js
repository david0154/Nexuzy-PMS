// Release verification. Runs the checks that must pass before an artefact is
// published: version/tag consistency, forbidden files, syntax and tests.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const problems = [];

const tag = process.env.GITHUB_REF_NAME || process.env.RELEASE_TAG;
if (tag && tag !== `v${pkg.version}`) {
  problems.push(`Tag ${tag} does not match package.json version v${pkg.version}`);
}

const required = ['server/index.js', 'server/app.js', 'public/index.html', 'install.bat', 'start.bat', 'README.md'];
for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) problems.push(`Missing release file: ${file}`);
}

// Check the built package, not the working tree: a developer's machine has a
// live database and local .env by design.
const packageDir = path.join(root, 'dist', `nexuzy-pms-v${pkg.version}`);
if (fs.existsSync(packageDir)) {
  const versionFile = path.join(packageDir, 'VERSION');
  if (!fs.existsSync(versionFile) || fs.readFileSync(versionFile, 'utf8').trim() !== pkg.version) {
    problems.push('Packaged VERSION does not match package.json');
  }
  for (const requiredDoc of ['CHANGELOG.md', 'docs/GAP_ANALYSIS.md', 'docs/LAN_SETUP.md']) {
    if (!fs.existsSync(path.join(packageDir, requiredDoc))) {
      problems.push(`Release package is missing ${requiredDoc}`);
    }
  }

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(packageDir, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (['node_modules', 'data', 'backups', '.git'].includes(entry.name)) {
          problems.push(`Forbidden release directory: ${relative}`);
          continue;
        }
        walk(full);
        continue;
      }
      if (entry.name === '.env' || entry.name.startsWith('.env.')) {
        if (entry.name !== '.env.example') problems.push(`Forbidden credential file: ${relative}`);
      }
      if (/\.(db|db-wal|db-shm|nxp)$/i.test(entry.name)) {
        problems.push(`Forbidden data file: ${relative}`);
      }
    }
  };
  walk(packageDir);
}

try {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'lint.js')], { stdio: 'inherit' });
} catch (err) {
  problems.push('Syntax check failed');
}

const checksumFiles = fs.existsSync(path.join(root, 'dist'))
  ? fs.readdirSync(path.join(root, 'dist')).filter(f => f.endsWith('.zip'))
  : [];
for (const file of checksumFiles) {
  const buffer = fs.readFileSync(path.join(root, 'dist', file));
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  const checksumPath = path.join(root, 'dist', `${file}.sha256`);
  if (fs.existsSync(checksumPath)) {
    const expected = fs.readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0].toLowerCase();
    if (expected !== digest) problems.push(`Checksum mismatch for ${file}`);
  } else {
    problems.push(`Missing checksum file for ${file}`);
  }
  console.log(`${digest}  ${file}`);
}

if (problems.length) {
  console.error('Release verification failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`✓ Release verification passed for v${pkg.version}`);
