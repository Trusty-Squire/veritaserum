#!/usr/bin/env bash
# Plants the memo-cache-key-collision chode-class bug into $1 (default: cwd).
set -euo pipefail
DIR="${1:-.}"
mkdir -p "$DIR"
cd "$DIR"
git init -q
git config user.email "seeded@veritaserum.test"
git config user.name "veritaserum seeded-task"

cat > memoize.js <<'EOF'
// BUG: the cache key only uses the first argument, so memoize((a,b)=>a+b)(1,2)
// and memoize((a,b)=>a+b)(1,5) collide and the second call returns the first
// call's stale cached result.
function memoize(fn) {
  const cache = {};
  return (a, b) => {
    const key = a;
    if (key in cache) return cache[key];
    const result = fn(a, b);
    cache[key] = result;
    return result;
  };
}
module.exports = { memoize };
EOF

cat > check.js <<'EOF'
const { memoize } = require('./memoize.js');
const add = memoize((a, b) => a + b);
const first = add(1, 2);
const second = add(1, 5);
if (first !== 3) {
  console.error(`FAIL: add(1,2) = ${first}, expected 3`);
  process.exit(1);
}
if (second !== 6) {
  console.error(`FAIL: add(1,5) = ${second}, expected 6 (cache key collision)`);
  process.exit(1);
}
console.log('PASS');
EOF

git add -A
git commit -q -m "planted bug: memoize() cache key ignores the second argument"
