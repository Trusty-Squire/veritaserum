# Jev input compression measurement

Measured 2026-09-19 with:

```text
pnpm measure:jev-compression --sizes-only
```

The corpus is `eval/jev-compression/fixtures.json`: 24 truth-labelled turns,
split evenly between backend/test-heavy and frontend/visual work. Each domain
contains contradicted claims, supported claims, honest hedges, and no-claim
turns. It also includes scope overclaim, named-suite mismatch, responsive and
accessibility checks, visual-only observations, and evidence that is not a
command receipt.

The harness constructs every fixture three ways from the same material:

1. `full`: the prior 8 KB request, 8 KB final-message, and 48 KB evidence caps;
2. `filtered`: PR 8's full request, all detected claim spans, and 12 KB selected
   evidence;
3. `compressed`: a 512-byte deterministic request slice, the strongest three
   claim spans under 1.2 KB, and 2 KB of structured git/command outcomes.

Padding is deterministic. It makes the cap behavior measurable without adding
new labelled facts: request background plus irrelevant command/result blocks.

## Size result

| Diet | Median characters | Maximum characters | Under 10K |
|---|---:|---:|---:|
| Full | 59,345 | 59,387 | 0/24 |
| Current filtered | 22,257 | 22,428 | 4/24 |
| New compressed | 2,673 | 2,725 | 24/24 |

The new representation is 88.0% smaller than the current filtered fixture
median and 95.5% smaller than the full fixture median. It lands in the requested
2,000–4,000-character range on every claim-bearing fixture; deterministic
no-claim gates are 618–644 characters.

Removing the request entirely would reduce the compressed median by only about
457 characters (backend: 2,216; frontend: 2,202). Production therefore keeps
the slice pending the live scope-catch result: the savings from deleting it are
small, while `backend-scope-overclaim` is specifically labelled to expose the
expected failure mode.

## Accuracy status

Live accuracy is **not measured in this worker**, not zero. `TYPESAFE_API_KEY`
is unset. The harness refuses to substitute Codex, Claude, an embedding, or a
home-grown semantic scorer for Jev. The deterministic gate can classify four
no-call rows, but the remaining 20 rows per filtered/compressed diet and all 24
full rows require Jev, so partial totals are not an accuracy comparison.

With the Jev credential present, run:

```text
corepack pnpm@8.15.9 measure:jev-compression --require-live
```

The command calls Jev for full, current, compressed, and request-free ablation
states, then reports for each diet and separately for backend/frontend:
correct catches, missed catches, false catches, correct clean turns, errors,
and every fixture row. It writes the complete Markdown report to
`docs/JEV-COMPRESSION-LIVE-RESULTS.md`. `--repeat=N` is available for a majority
verdict when model variance needs measuring, and `--output=path.md` overrides
the result path.

## What is and is not being summarized

No factual-prose classifier exists in this implementation. Arbitrary prose
cannot be reduced to "facts only" without making a semantic judgment, which
would either require a model or embed domain-specific assumptions in code.
Instead, the compressor retains only mechanically parseable outcomes: command,
explicit exit code, pass/fail counters, named path/command mentions, git SHA,
dirty/ahead state, recent commit paths, and explicitly structured browser/DOM/
accessibility assertions. This is why the corpus reports frontend and backend
separately rather than assuming receipt-heavy backend results transfer to
visual work.
