#!/usr/bin/env bash
# Overnight seeded-task suite (SPEC §6.6), two-arm (docs/DEMANDS.md experiment):
#   arm "urge":   the audit's demand is an instruction only (gap+remedy+accept
#                 in the correction feedback) — the executor writes its own test.
#   arm "script": instruction PLUS the auditor's materialized failing script
#                 (phase-1 default behavior).
# Every run: fresh planted repo, isolated state dir + telemetry, qwen2.5:3b under
# goose, testbed mode, correction cycle of 3 turns, real cross-family auditor.
# Results append to eval/seeded/results-overnight-<stamp>.jsonl one line per run
# (partial nights still yield usable data). NEVER run by tests or CI.
set -uo pipefail
shopt -s nullglob
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$REPO/eval/seeded/results-overnight-$STAMP.jsonl"
LOG="$REPO/eval/seeded/overnight-$STAMP.log"
MODEL="${OVERNIGHT_MODEL:-qwen2.5:3b}"
REPS="${OVERNIGHT_REPS:-2}"
MAX_TURNS="${OVERNIGHT_MAX_TURNS:-3}"
SCRATCH="$(mktemp -d /tmp/vs-overnight-XXXXXX)"

echo "overnight suite: model=$MODEL reps=$REPS max-turns=$MAX_TURNS out=$OUT" | tee -a "$LOG"

for rep in $(seq 1 "$REPS"); do
  for taskdir in "$REPO"/eval/seeded/tasks/*/; do
    task="$(basename "$taskdir")"
    for arm in urge script; do
      run_id="$task--$arm--r$rep"
      W="$SCRATCH/$run_id"
      mkdir -p "$W"
      echo "[$(date +%H:%M:%S)] START $run_id" | tee -a "$LOG"
      if ! bash "$taskdir/setup.sh" "$W/repo" >>"$LOG" 2>&1; then
        echo "{\"task\":\"$task\",\"arm\":\"$arm\",\"rep\":$rep,\"error\":\"setup failed\"}" >> "$OUT"
        rm -rf "$W"
        continue
      fi
      RESULT="$W/result.json"
      if VS_QUEUE_ROOT="$W/state" \
         VS_TELEMETRY_PATH="$W/telemetry.jsonl" \
         VS_DEMAND_MODE="$arm" \
         VS_SCHEDULING_MODE=testbed \
         VS_EXECUTOR="ollama:$MODEL" \
         timeout 2400 npx tsx "$REPO/eval/seeded/runner.ts" \
           --task "$taskdir" --driver goose --dir "$W/repo" \
           --goose-model "$MODEL" --max-turns "$MAX_TURNS" \
           >"$RESULT" 2>>"$LOG"; then
        node -e "
          const fs = require('fs');
          const r = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
          const line = { task: process.argv[2], arm: process.argv[3], rep: Number(process.argv[4]),
            scorecard: r.scorecard, outcome: r.correctionOutcome,
            turns: r.results.map(t => ({ groundTruth: t.groundTruth, claims: t.claims, demands: t.demands, unaccountable: t.unaccountable })) };
          fs.appendFileSync(process.argv[5], JSON.stringify(line) + '\n');
        " "$RESULT" "$task" "$arm" "$rep" "$OUT"
        echo "[$(date +%H:%M:%S)] DONE  $run_id $(node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(JSON.stringify(r.scorecard)+' '+r.correctionOutcome)" "$RESULT")" | tee -a "$LOG"
      else
        echo "{\"task\":\"$task\",\"arm\":\"$arm\",\"rep\":$rep,\"error\":\"runner failed or timed out\"}" >> "$OUT"
        echo "[$(date +%H:%M:%S)] FAIL  $run_id" | tee -a "$LOG"
      fi
      rm -rf "$W"
    done
  done
done

rm -rf "$SCRATCH"

echo "[$(date +%H:%M:%S)] suite complete → $OUT" | tee -a "$LOG"
# Tally: per-arm catches / false flags / fixed-rate.
if [ ! -s "$OUT" ]; then
  echo "no results recorded — nothing to tally" | tee -a "$LOG"
  exit 0
fi
node -e "
const fs = require('fs');
const lines = fs.readFileSync(process.argv[1], 'utf8').trim().split('\n').map(l => JSON.parse(l));
for (const arm of ['urge', 'script']) {
  const runs = lines.filter(r => r.arm === arm && !r.error);
  const s = runs.reduce((a, r) => ({ turns: a.turns + r.scorecard.turns, catches: a.catches + r.scorecard.catches,
    falseFlags: a.falseFlags + r.scorecard.falseFlags, vague: a.vague + r.scorecard.vagueTurns,
    fixed: a.fixed + (r.outcome === 'fixed' ? 1 : 0) }), { turns: 0, catches: 0, falseFlags: 0, vague: 0, fixed: 0 });
  console.log(arm.toUpperCase() + ': runs=' + runs.length + ' turns=' + s.turns + ' catches=' + s.catches +
    ' falseFlags=' + s.falseFlags + ' vague=' + s.vague + ' fixedRate=' + (runs.length ? (s.fixed / runs.length).toFixed(2) : 'n/a'));
}
const errs = lines.filter(r => r.error).length;
if (errs) console.log('errors: ' + errs);
" "$OUT" | tee -a "$LOG"
