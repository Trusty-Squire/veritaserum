# ser

A portable ground-truth layer for coding agents. ser turns a goal into checkable
"done" conditions, refuses to let an agent end a turn on a false claim, and remembers
your corrections — riding the harness's existing hooks. See [DESIGN.md](./DESIGN.md).

**It runs free.** Authoring uses your `claude` subscription; the cross-vendor judge uses
`codex`↔`claude`; nothing metered unless you opt into OpenRouter.

## Install
```
pnpm install && pnpm build && npm link      # puts `ser` and `ser-mcp` on PATH
```

## Use it as an MCP harness (the ground-truth layer)
Register the stdio server with any MCP host (Claude Code, Codex, …):
```json
{ "mcpServers": { "ser": { "command": "ser-mcp" } } }
```
Tools (the split API, DESIGN §4):

| Tool | Effect |
|---|---|
| `contract_seed(goal, dir?)` | Knight authors + seals a fresh contract |
| `contract_verify(dir?)` | run gates from **committed** graders (R2) vs the working tree; `isError` on a false "done"; semantic gates judged cross-vendor; abstain → human |
| `contract_ratchet(complaint, dir?)` | turn a correction into a permanent gate (monotonic) |
| `contract_amend(match, as, confirm, dir?)` | retire gates (the only weakening path; needs confirm) |
| `contract_status(dir?)` | read-only summary |

MCP is pull-only, so it is **not** the enforcement path — for hard-block enforcement,
wire the CLI into the harness Stop hook (below).

## Use it as an enforcement hook (hard-block)
`ser hook-stop` blocks a turn iff the agent claimed done while a gate is red (honest
incompleteness passes). `ser hook-prompt` ratchets a correction. Adapters bundle these:
- **Claude Code** (`adapters/claude-code`) — hard-block today
- **Codex** (`adapters/codex`) — hard-block today
- **goose** (`adapters/goose`) — hard-block once aaif-goose/goose#10296 merges

One `ser hook-stop` binary serves all three; the CLI normalizes each harness's payload.

## CLI
```
ser seed <goal>        author + seal a contract (Knight)
ser verify [--full]    run gates from pristine graders; exit 1 on a false "done"
ser ratchet <text>     append a gate from a correction (monotonic)
ser amend --retire --match <s> --as <s> [--confirm]   the only weakening path
```

## Guarantees
- **R2 grader integrity** — gates run from their committed version; a tampered grader is
  inert and flagged.
- **Cross-vendor judge** — a semantic claim is judged by a vendor ≠ the executor
  (self-preference bias); no cross-vendor sub → abstain to human, never a silent pass.
- **Honest by construction** — a judge outage abstains; a malformed contract is a hard
  error; corrections never regress.

## Dev
```
pnpm test        # hermetic vitest (MockLlmClient — no network)
pnpm typecheck
pnpm demo        # R2 proof · pnpm tsx scripts/{judge,knight,e2e-loop,mcp-smoke}.ts
```

Status: P0–P3 complete. Knight/Judge/Transcriber are LLM-backed on free local
subscriptions; the only metered piece is the visual VLM judge over filmstrips
(opt-in, approval-gated), which abstains to human until configured.
