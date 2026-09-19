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

That's the whole install: two hooks in one config file. Nothing to approve, no server.
The classifier is Jev. Set `TYPESAFE_API_KEY` (the key is a header, never argv).
Without it, veritaserum still installs and reports that Jev did not run — it does
not reach for a coding-agent CLI or a local model.

Blocking (captain override): export `VS_BLOCK=1` in the sessions you want to test.
Off without editing code: `VS_BLOCK=0` or unset. See [docs/BLOCKING.md](./docs/BLOCKING.md).

## What it does

When your agent ends a turn, veritaserum's Stop hook fires. A **deterministic
filter** (`src/jev-input.ts`) finds load-bearing claims in the final message.
If none survive, Jev is not called. If they do, **Jev** (typesafe.ai System One)
answers one Choice against the session's own receipts. **Code-owned templates**
write the warning — the classifier does not author prose.

Each catch comes back **unsupported** (nothing backs it) or **contradicted**
(the evidence says it's false). The verdict arrives as a single line at your next prompt.

Honest uncertainty is never punished. "I'd need to benchmark this" asserts nothing and is
left alone — only a *confident, unbacked* assertion is the confabulation it's hunting.

**Blocking is a captain override of a stated invariant, not a missing feature.** The
default is still warn-primary: the audit flags and the agent continues. The README and
SPEC used to say "Nothing blocks" / "It is never a flag you flip." That was deliberate.
The captain overrode it once Jev made a same-turn audit cheap enough (~350ms) to send a
confident confabulation back for revision.

```
VS_BLOCK=1    # on — block a confident confabulation, at most twice per session
VS_BLOCK=0    # off (or unset) — warn-only, same as before
```

Only a positive, confident finding blocks. An outage, a missing key, a malformed reply,
or a timeout never does.

The classifier is **Jev** (typesafe.ai System One) when `TYPESAFE_API_KEY` is set: a
Choice question, not free prose. `veritaserum telemetry` counts detections —
that is the metric.

## Why after the fact

**After the fact, not before.** The filter runs at turn-end, where the claim
actually gets made. No upfront contract, no phase detection.

**Push, not pull — which is why there is no MCP server.** MCP is a *pull* surface: the
executor decides whether to call it. Ground truth cannot be opt-in. An agent skips a
self-check exactly when it is confabulating, because a confabulating agent doesn't
experience itself as guessing — it feels done. A voluntary "audit me" tool is therefore
adversely selected: its cleanest green stamps arrive precisely when they are worth least. So
the audit is **pushed** by the harness and the executor cannot decline it.

**Fail-open.** No key, a Jev outage, an unparseable reply — none of it stalls or
blocks your agent, and none of it falls back to another model. veritaserum never
halts your work over its own hiccup.

## CLI

```
veritaserum install <claude-code|goose|codex> [--global]   wire the auditor into a harness
veritaserum selfcheck                      prove the installed hook RUNS (and reaches the model)
veritaserum telemetry                      what got caught — verdicts, by harness
veritaserum doctor                         whether Jev is available (TYPESAFE_API_KEY)
```

## Install from source
```
pnpm install && pnpm build && npm link   # puts `veritaserum` on PATH
```

## Docs
- [SPEC.md](./SPEC.md) — the mechanism, the rules it must not break, and what v3 deleted.
- [docs/BLOCKING.md](./docs/BLOCKING.md) — captain override of R5: Jev blocking, off switch, cost, what was verified.
- [docs/DEMANDS.md](./docs/DEMANDS.md) — a demand is a failing test: authoring, materialization, lifecycle.
- [docs/DISTRIBUTION.md](./docs/DISTRIBUTION.md) — npm package + Claude Code plugin, from one repo.
- [DESIGN.md](./DESIGN.md), [ASSUMPTIONS.md](./ASSUMPTIONS.md) — design *history*, superseded in part. SPEC.md wins.

## Dev
```
pnpm test           # hermetic vitest — no network
pnpm test:package   # packed npm-tarball install seams — needs npm + registry access
pnpm typecheck
```

**Status.** One role, not four. The Knight (authored gates from a goal), the Transcriber
(authored gates from complaints), and the semantic Judge (ruled on gates) are deleted — they
were special cases of the auditor, which already rules on a claim *and* authors the check
when the evidence is missing (SPEC §4.1). One evaluator, one mechanism, one hook.
