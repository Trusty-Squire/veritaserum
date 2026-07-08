#!/usr/bin/env bash
# Plants the wrong-comparator-sort chode-class bug into $1 (default: cwd).
set -euo pipefail
DIR="${1:-.}"
mkdir -p "$DIR"
cd "$DIR"
git init -q
git config user.email "seeded@veritaserum.test"
git config user.name "veritaserum seeded-task"

cat > sortAsc.js <<'EOF'
// BUG: comparator is flipped -- sorts descending instead of ascending.
function sortAsc(arr) {
  return arr.slice().sort((a, b) => b - a);
}
module.exports = { sortAsc };
EOF

cat > check.js <<'EOF'
const { sortAsc } = require('./sortAsc.js');
const got = sortAsc([3, 1, 2]);
const expected = [1, 2, 3];
if (JSON.stringify(got) !== JSON.stringify(expected)) {
  console.error(`FAIL: sortAsc([3,1,2]) = ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  process.exit(1);
}
console.log('PASS');
EOF

git add -A
git commit -q -m "planted bug: flipped comparator in sortAsc()"
