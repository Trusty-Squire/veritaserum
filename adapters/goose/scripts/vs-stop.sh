#!/usr/bin/env sh
# veritaserum — goose Stop hook (Open Plugins spec; hooks/hooks.json → Stop).
#
# goose execs this script with the Stop payload JSON on stdin:
#   {"event": "Stop", "session_id": "...", "working_dir": "..."}
# (no message content — SPEC.md §3: the final message + receipts are read
# from goose's own sessions.db, see ../README.md and src/goose.ts).
#
# This script only resolves the CLI and passes stdin straight through to
# `veritaserum hook-stop`, which does all the work (SPEC §2 sync path).
#
# VS_EXECUTOR / VS_HARNESS follow the same env convention src/install.ts's
# hookCommand() sets for the other harnesses: VS_HARNESS names the calling
# harness (telemetry, `veritaserum telemetry`); VS_EXECUTOR names the
# executor's model family for the auditor's cross-family resolution (SPEC §2
# "Auditor resolution"). goose's executor is whatever model is configured
# (SPEC §3 targets local ollama models first) — override per setup, e.g.
# `VS_EXECUTOR=ollama:qwen2.5:3b`.
set -eu

export VS_HARNESS=goose
: "${VS_EXECUTOR:=ollama}"
export VS_EXECUTOR

if command -v veritaserum-hook >/dev/null 2>&1; then
  exec veritaserum-hook
fi
if command -v veritaserum >/dev/null 2>&1; then
  exec veritaserum hook-stop
fi

# `npx`'s bin shim disappears after installation, so the installer copies the
# package and its runtime dependency layout into the durable Goose plugin.
if [ -f "${PLUGIN_ROOT}/runtime/node_modules/veritaserum/dist/hook-cli.cjs" ]; then
  exec node "${PLUGIN_ROOT}/runtime/node_modules/veritaserum/dist/hook-cli.cjs"
fi

# Checkout-linked plugin (PLUGIN_ROOT = <checkout>/adapters/goose): fall back
# to the checkout's own compiled entry point.
if [ -f "${PLUGIN_ROOT}/../../dist/hook-cli.cjs" ]; then
  exec node "${PLUGIN_ROOT}/../../dist/hook-cli.cjs"
fi

# No resolvable runtime — fail open (R8): never break goose's turn-end.
exit 0
