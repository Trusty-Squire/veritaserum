# veritaserum

The truth serum for confabulating coding agents.

Agents confidently report "done," "tests pass," "implemented X" when it isn't true — most
often deep in a long session, where they've drifted from ground truth and nobody is reading
every line. That is what forces you to babysit the loop.

It survives careful benchmarking, too. An empirical study of SWE-bench Verified found that
**7.8% of patches count as correct while failing the developer's own test suite**, and that
29.6% of accepted patches behave differently from the human fix — inflating reported
resolution rates by **6.2 absolute percentage points**.[^1] Passing the tests you were given
is not the same as being right.

[^1]: [Are "Solved Issues" in SWE-bench Really Solved Correctly? An Empirical Study](https://arxiv.org/abs/2503.15223) (arXiv:2503.15223).

A model cannot reliably catch its *own* confabulation: the grader and the generator share
the blind spot. veritaserum puts an external check on your existing harness, automatically,
at every turn-end.

```
npx veritaserum install claude-code     # also: goose, codex   (--global for ~/.claude)
```

That's the whole install: two hooks in one config file. Nothing to approve, no server, no
API key.

## What it does

When your agent ends a turn, veritaserum's Stop hook fires and hands the turn to an
**async, cross-family auditor** — a fresh model from a *different family* than the one that
wrote the code, with no stake in it. The auditor picks out the load-bearing claims in what
the agent just said and checks them against the only two sources of truth:

- **read-only git probes computed right now** (`git log`, `git status`, `git diff`) — what
  the repo actually says, not what anyone remembers; and
- **the harness's own record** of what actually ran (the receipts).

Each claim comes back **supported**, **unsupported** (nothing backs it), or **contradicted**
(the evidence says it's false). The verdict arrives as a single line at your next prompt.

Honest uncertainty is never punished. "I'd need to benchmark this" asserts nothing and is
left alone — only a *confident, unbacked* assertion is the confabulation it's hunting.

**Nothing blocks.** The audit is warn-primary: it flags, it never halts your agent — not on
a false claim, not on its own outage. Blocking is earned per standing-law entry, on
evidence, and promoted by a human. It is never a flag you flip.

## Standing law: a demand is a failing test

A claim that needed an oracle that doesn't exist gets one **demanded**. The auditor doesn't
nag — it *writes the failing check itself*, and that demand persists as **case law**
(`veritaserum.law.yaml`, git-tracked): a standing expectation, re-checked mechanically from
then on, no LLM required. The first demand costs one auditor judgment; every later claim in
its scope is settled by running a script. Precedent amortizes.

Two properties make this safe rather than annoying:

- **Demands are inert until you commit them.** The auditor writes to your working tree but
  reads law from **git HEAD** — so a demand binds only once a human commits it. The law-file
  commit *is* the veto moment: review the diff, drop what you reject. Consent by commit.
- **The oracle is not the agent's to edit.** The demand's test file lives in veritaserum's
  own state dir, never in your repo, so the executor can *run* the check but cannot read or
  rewrite it. It has to fix the code, not the test.

Law is a git-tracked file, so it branches with your code like everything else.

## Why cross-family, and why after the fact

**Cross-family on purpose.** Different checkpoints of one lineage share blind spots, and a
model grading its own family's output is biased toward passing it. The auditor resolves to a
different family than the executor; a same-family auditor is only ever a fallback, and is
tagged as such so you can trust it less.

**After the fact, not before.** No upfront contract, no claim regexes, no phase detection —
one mechanism, firing at turn-end, where the claim actually gets made.

**Push, not pull — which is why there is no MCP server.** MCP is a *pull* surface: the
executor decides whether to call it. Ground truth cannot be opt-in. An agent skips a
self-check exactly when it is confabulating, because a confabulating agent doesn't
experience itself as guessing — it feels done. A voluntary "audit me" tool is therefore
adversely selected: its cleanest green stamps arrive precisely when they are worth least. So
the audit is **pushed** by the harness and the executor cannot decline it. For the genuinely
voluntary surface — run my demands, show me what got caught — the executor already has a
shell, and those are CLI commands (below).

**It runs free.** The auditor uses your existing `claude`/`codex` subscriptions, or local
ollama models. Nothing is metered unless you opt into OpenRouter yourself.

**Fail-open.** No auditor, an LLM error, an unparseable reply, a corrupt law file — none of
it stalls or blocks your agent. veritaserum never halts your work over its own hiccup.

## CLI

```
veritaserum install <claude-code|goose|codex> [--global]   wire the auditor into a harness
veritaserum telemetry                      what got caught — verdicts, by harness
veritaserum demands                        run the failing checks the auditor authored
veritaserum retire <law-id> "<reason>"     retire a standing law entry (recorded, never deleted)
veritaserum doctor                         which auditor rule fired, and why
```

The executor learns that `veritaserum demands` exists exactly when it needs to: a demand's
feedback line names the command. No standing instruction in your `CLAUDE.md`, no tool list
burning context on every turn.

## Install from source
```
pnpm install && pnpm build && npm link   # puts `veritaserum` on PATH
```

## Docs
- [SPEC.md](./SPEC.md) — the mechanism, the rules it must not break, and what v3 deleted.
- [docs/DEMANDS.md](./docs/DEMANDS.md) — a demand is a failing test: authoring, materialization, lifecycle.
- [docs/DISTRIBUTION.md](./docs/DISTRIBUTION.md) — npm package + Claude Code plugin, from one repo.
- [DESIGN.md](./DESIGN.md), [ASSUMPTIONS.md](./ASSUMPTIONS.md) — design *history*, superseded in part. SPEC.md wins.

## Dev
```
pnpm test        # hermetic vitest — no network
pnpm typecheck
```

**Status.** One role, not four. The Knight (authored gates from a goal), the Transcriber
(authored gates from complaints), and the semantic Judge (ruled on gates) are deleted — they
were special cases of the auditor, which already rules on a claim *and* authors the check
when the evidence is missing (SPEC §4.1). One evaluator, one mechanism, one hook.
