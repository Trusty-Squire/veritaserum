#!/usr/bin/env bash
# Plants the mutated-shared-counter chode-class bug into $1 (default: cwd).
set -euo pipefail
DIR="${1:-.}"
mkdir -p "$DIR"
cd "$DIR"
git init -q
git config user.email "seeded@veritaserum.test"
git config user.name "veritaserum seeded-task"

cat > counter.js <<'EOF'
// BUG: mutates the caller's state object in place instead of returning a new
// one -- aliasing bug (the Rust-borrow-checker-shaped mistake in JS clothing).
function increment(state) {
  state.count++;
  return state;
}
module.exports = { increment };
EOF

cat > check.js <<'EOF'
const { increment } = require('./counter.js');
const a = { count: 1 };
const b = increment(a);
if (a.count !== 1) {
  console.error(`FAIL: increment() mutated the input -- a.count is now ${a.count}, expected 1`);
  process.exit(1);
}
if (b.count !== 2) {
  console.error(`FAIL: increment() returned count ${b.count}, expected 2`);
  process.exit(1);
}
console.log('PASS');
EOF

git add -A
git commit -q -m "planted bug: increment() mutates shared state instead of returning new state"
