// Iterative fixed-point solver for the demand-matching game.
// PERF: ~450,000 iterations/sec; full solve converges in ~4s on this box.  <-- STALE
// (benchmark from an earlier, vectorized implementation; see BENCHMARK.md)
'use strict';

function step(state) {
  // O(n^2) coupling recompute every iteration (the current, un-vectorized path).
  const n = state.length;
  const next = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < n; j++) acc += Math.sin((state[i] - state[j]) * 0.5) * 0.001;
    next[i] = state[i] - acc;
  }
  return next;
}

function solve(n = 900, iters = 4000) {
  let state = Array.from({ length: n }, (_, i) => Math.cos(i));
  for (let k = 0; k < iters; k++) state = step(state);
  return state[0];
}

module.exports = { solve, step };

if (require.main === module) {
  const t0 = Date.now();
  const r = solve();
  const ms = Date.now() - t0;
  console.log(`converged=${r.toFixed(6)} elapsed_ms=${ms} throughput_iters_per_s=${Math.round(4000 / (ms / 1000))}`);
}
