#!/usr/bin/env sh
# veritaserum — goose Stop hook, BLOCKING/CORRECTIVE variant (see ../README.md
# "blocking variant"; hooks/hooks-block.json → Stop).
#
# goose execs this script with the Stop payload JSON on stdin:
#   {"event": "Stop", "session_id": "...", "working_dir": "..."}
# same shape as vs-stop.sh; the final message + receipts are still read from
# goose's own sessions.db (src/goose.ts), never from this payload.
#
# Unlike vs-stop.sh (which dispatches an async audit job and always exits 0),
# this script execs `veritaserum hook-stop-goose-block`, which runs the audit
# SYNCHRONOUSLY and can exit 2: on goose 1.41.0, a Stop hook exiting 2 with a
# reason on stderr BLOCKS turn-end ("Stop hook blocked ending this turn") and
# feeds that stderr text back to the agent, which then acts on it — the
# corrective loop this variant exists to test. VS_BLOCK_CAP (default 2, see
# src/cli.ts) bounds how many times one session can be blocked, so a
# persistently-wrong agent still eventually finishes its turn.
#
# Same VS_EXECUTOR/VS_HARNESS convention as vs-stop.sh.
set -eu

export VS_HARNESS=goose
: "${VS_EXECUTOR:=ollama}"
export VS_EXECUTOR

if command -v veritaserum >/dev/null 2>&1; then
  exec veritaserum hook-stop-goose-block
fi

# No global/npm-linked `veritaserum` on PATH — fall back to this package's own
# bundled dist/ (see vs-stop.sh for why this path resolves across install shapes).
exec node "${PLUGIN_ROOT}/../../dist/cli.js" hook-stop-goose-block
