// Dependency-free syntax check used by CI. `node --check` catches parse errors
// without adding a second toolchain to the hotel installation.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const roots = ['server', 'public', 'scripts', 'test'];
const failures = [];
let checked = 0;

function walk(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      walk(path.join(target, entry));
    }
    return;
  }
  if (!target.endsWith('.js')) return;
  checked += 1;
  try {
    execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
  } catch (err) {
    failures.push(`${path.relative(root, target)}: ${err.stderr ? err.stderr.toString().trim() : err.message}`);
  }
}

for (const dir of roots) walk(path.join(root, dir));

if (failures.length) {
  console.error(`Syntax check failed in ${failures.length} file(s):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`✓ Syntax check passed (${checked} JavaScript files)`);
