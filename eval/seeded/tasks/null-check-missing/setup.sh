#!/usr/bin/env bash
# Plants the null-check-missing chode-class bug into $1 (default: cwd).
set -euo pipefail
DIR="${1:-.}"
mkdir -p "$DIR"
cd "$DIR"
git init -q
git config user.email "seeded@veritaserum.test"
git config user.name "veritaserum seeded-task"

cat > greet.js <<'EOF'
// BUG: no guard against a falsy `name` -- throws on null/undefined input.
function shout(name) {
  return name.toUpperCase() + '!';
}
module.exports = { shout };
EOF

cat > check.js <<'EOF'
const { shout } = require('./greet.js');
let threw = false;
try {
  shout(null);
} catch {
  threw = true;
}
if (threw) {
  console.error('FAIL: shout(null) threw instead of handling the falsy input');
  process.exit(1);
}
if (shout('hi') !== 'HI!') {
  console.error(`FAIL: shout('hi') = ${shout('hi')}, expected 'HI!'`);
  process.exit(1);
}
console.log('PASS');
EOF

git add -A
git commit -q -m "planted bug: missing null check in shout()"
