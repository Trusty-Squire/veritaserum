# veritaserum

The truth serum for confabulating coding agents. A portable ground-truth layer:
veritaserum turns a goal into checkable "done" conditions, refuses to let an agent
end a turn on a false claim, and remembers your corrections — riding the harness's
existing hooks. The command is `veritaserum`.
See [DESIGN.md](https://github.com/Trusty-Squire/veritaserum/blob/main/DESIGN.md).

**It runs free.** Authoring uses your `claude` subscription; the cross-vendor judge uses
`codex`↔`claude`; nothing metered unless you opt into OpenRouter.

## v3 (current)

One mechanism: when a turn ends, an async **case-law auditor** — a fresh model from a
different family than the executor — checks the load-bearing claims in what the agent
just said against the only two sources of truth: read-only git probes computed now, and
the harness's own record of what ran. A claim that needed an oracle that doesn't exist
gets one **demanded**, and that demand persists as **case law** (`veritaserum.law.yaml`,
git-tracked) — a standing, mechanically re-checked expectation from then on. No upfront
contract, no claim regexes, no phase detection. See [SPEC.md](./SPEC.md).

It proves out on the cheapest executor first — **goose + local ollama models**
(`qwen2.5:3b`), the ollama testbed where confabulation reproduces overnight — before
shipping to **Claude Code as the final target**, as a plugin (hooks + MCP + a skill, one
manifest; see [docs/DISTRIBUTION.md](./docs/DISTRIBUTION.md)).

## Quick start — the sentinel

_The section below documents the v1 synchronous judge-primary mechanism, kept for
existing installs; v3's case-law auditor (above) is async and needs no contract setup._

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
pnpm install && pnpm build && npm link   # puts `veritaserum` on PATH
```

## Why there is no MCP server (deliberate)
MCP is **pull**: the executor decides whether to call. Ground truth cannot be opt-in — an
agent skips the check exactly when it is confabulating, so a voluntary "audit me" tool is
adversely selected. The audit is **pushed** by the harness at turn-end and the executor
cannot decline it. For the genuinely voluntary surface (run my demands, show me the law,
show me what got caught) the executor already has a shell: see the CLI below.

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
veritaserum demands       run the failing checks the auditor authored
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
```

Status: P0–P3 complete. One role, not four: the Knight, Judge, and Transcriber are
deleted (SPEC §4.1) — the auditor already ruled on claims AND authored the checks.
The auditor runs cross-family on free local subscriptions; nothing is metered.
