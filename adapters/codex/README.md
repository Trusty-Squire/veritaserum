# ser — Codex adapter (Archetype A, hard-block today)

Codex CLI is a full hard-block target now: its `Stop` hook force-continues the turn
(`{"decision":"block","reason":…}` becomes the next prompt, or exit 2 + stderr), it
passes `last_assistant_message` (the completion claim — ser reads it directly), and
`UserPromptSubmit` fires on the human message. No upstream change needed.

## Install
One command: `veritaserum install codex` (or `npx veritaserum install codex`) wires BOTH
halves — the Stop hook into `~/.codex/hooks.json` and the MCP server (contract tools) as
`[mcp_servers.veritaserum]` in `~/.codex/config.toml`. Idempotent, `.vs-bak` backups.
Then steps 3–4 below still apply. Manual route:
1. `ser` on PATH: `cd <repo> && pnpm build && npm link`.
2. Add the hooks — either paste `config-snippet.toml` into `~/.codex/config.toml`, or
   install as a plugin from a marketplace (`codex plugin add …`) that bundles
   `hooks/hooks.json`. Register the MCP server too: `codex mcp add veritaserum -- node
   <repo>/dist/mcp.js`.
3. Grant **hook trust** (Codex reviews command hooks before running them): approve on
   first use, or ship as a *managed* hook (`requirements.toml`) so it is trusted by
   policy, or `--dangerously-bypass-hook-trust` for vetted automation.
4. `ser seed "<goal>"` once. Codex then cannot end a turn claiming done over a red gate.

## Payload
Codex Stop → `last_assistant_message` + working dir → `ser hook-stop` (claim-gated block).
Codex UserPromptSubmit → the human message → `ser hook-prompt` (ratchet a correction).
One `ser hook-stop` binary serves Codex, Claude Code, and goose; the CLI normalizes the
payload differences.

Version note: hook config schema is codex-version-specific (validated shape here: v0.142).
