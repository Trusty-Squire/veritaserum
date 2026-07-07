# veritaserum

The truth serum for confabulating coding agents. A portable ground-truth layer:
veritaserum turns a goal into checkable "done" conditions, refuses to let an agent
end a turn on a false claim, and remembers your corrections — riding the harness's
existing hooks. The command is `veritaserum`.
See [DESIGN.md](https://github.com/Trusty-Squire/veritaserum/blob/main/DESIGN.md).

**It runs free.** Authoring uses your `claude` subscription; the cross-vendor judge uses
`codex`↔`claude`; nothing metered unless you opt into OpenRouter.

## Quick start — the sentinel

One command wires veritaserum into your agent as a **confabulation sentinel**: on
every turn-end, a fresh cross-vendor judge checks the agent's "done" claim against
the actual repo state and flags anything unsupported ("claims tests pass but nothing
ran", "claims implemented X but the diff is empty").

```
npx veritaserum install claude-code   # also: goose, codex   (--global for ~/.claude)
export VS_ADVISORY=1                  # week 1: watch + log, never block
# ...work normally...
veritaserum telemetry                 # catches, would-blocks, false-flags, by harness
unset VS_ADVISORY                    # then turn on real blocking
```

Judge-primary, no contract setup needed. **Fail-open**: no judge / LLM error /
unparseable reply never blocks — only an explicit contradiction does.

## How it works

Your agent finishes a turn and claims "done." veritaserum's Stop hook fires and
hands that claim — plus the actual repo state (`git diff`, `git status`) — to a
**fresh, cross-vendor judge**: a different LLM vendor than the one that wrote the
code. It answers one question — *is this claim supported by what actually
happened?* — and blocks the turn only on a clear contradiction.

- **Cross-vendor on purpose.** A model grading its own family's output is biased
  toward passing it, and it shares the same blind spots. A fresh external judge
  with no stake in the work catches what self-review structurally can't.
- **Fail-open.** No judge, an LLM error, or an unparseable reply never blocks —
  only a named, unsupported claim does. veritaserum never halts your agent over
  its own hiccup.
- **Two layers.** The judge is semantic and needs zero setup. For hard, runnable
  checks you can also seal a `contract` of deterministic gates (shell exit codes,
  run from their *committed* version so a tampered gate is inert) — the judge
  rides on top.

## Why

Frontier agents confabulate: they confidently report "done," "tests pass,"
"implemented X" when it isn't true — most often in long sessions where they've
drifted from ground truth. It isn't rare (one 2026 study found ~11% of "solved"
SWE-bench issues are actually wrong) and it's exactly what forces you to babysit a
loop. A model can't reliably catch its *own* confabulation — the grader and the
generator share the blind spot. An external, fresh, cross-vendor check can.
veritaserum makes that check automatic on your existing harness, with a telemetry
trail — so "done" means done, and you can let the loop run.

## Install from source
```
pnpm install && pnpm build && npm link   # puts `veritaserum` and `veritaserum-mcp` on PATH
```

## Use it as an MCP harness (the ground-truth layer)
Register the stdio server with any MCP host (Claude Code, Codex, …):
```json
{ "mcpServers": { "veritaserum": { "command": "veritaserum-mcp" } } }
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
`veritaserum hook-stop` blocks a turn iff the agent claimed done while a gate is red
(honest incompleteness passes). `veritaserum hook-prompt` ratchets a correction.
Adapters bundle these:
- **Claude Code** (`adapters/claude-code`) — hard-block today
- **Codex** (`adapters/codex`) — hard-block today
- **goose** (`adapters/goose`) — hard-block once aaif-goose/goose#10296 merges

One `veritaserum hook-stop` binary serves all three; the CLI normalizes each harness's payload.

## CLI
```
veritaserum install <claude-code|goose|codex> [--global]   wire the sentinel into a harness
veritaserum telemetry     catches / would-blocks / by harness — the in-the-wild measurement
veritaserum seed <goal>   author + seal a contract (Knight)
veritaserum verify [--full]   run gates from pristine graders; exit 1 on a false "done"
veritaserum ratchet <text>    append a gate from a correction (monotonic)
veritaserum amend --retire --match <s> --as <s> [--confirm]   the only weakening path
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
