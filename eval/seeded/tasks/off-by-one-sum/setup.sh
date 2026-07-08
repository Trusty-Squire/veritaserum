#!/usr/bin/env bash
# Plants the off-by-one-sum chode-class bug into $1 (default: cwd).
set -euo pipefail
DIR="${1:-.}"
mkdir -p "$DIR"
cd "$DIR"
git init -q
git config user.email "seeded@veritaserum.test"
git config user.name "veritaserum seeded-task"

cat > sum.js <<'EOF'
// BUG: loop bound is off by one -- the last element is never added.
function sum(arr) {
  let total = 0;
  for (let i = 0; i < arr.length - 1; i++) {
    total += arr[i];
  }
  return total;
}
module.exports = { sum };
EOF

cat > check.js <<'EOF'
const { sum } = require('./sum.js');
const got = sum([1, 2, 3, 4]);
if (got !== 10) {
  console.error(`FAIL: sum([1,2,3,4]) = ${got}, expected 10`);
  process.exit(1);
}
console.log('PASS');
EOF

git add -A
git commit -q -m "planted bug: off-by-one loop bound in sum()"
