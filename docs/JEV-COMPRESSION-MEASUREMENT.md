# Jev input compression measurement

Measured 2026-09-19 with:

```text
corepack pnpm@8.15.9 measure:jev-compression --require-live
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

Removing the request entirely reduces the compressed median by only about 457
characters (backend: 2,216; frontend: 2,202), but adds a missed catch on
`backend-scope-overclaim`. Production therefore keeps the 512-byte slice: it
detectably earns its place.

## Accuracy result

| Diet | Correct catches | Missed catches | False catches | Correct clean |
|---|---:|---:|---:|---:|
| Full | 9 | 1 | 0 | 14 |
| Current filtered | 9 | 1 | 1 | 13 |
| New compressed | 8 | 2 | 2 | 12 |

The compressed representation costs one catch compared with the current
filtered representation: `backend-named-suite-mismatch`. The frontend
accessibility miss already occurs in the current filtered input because its
claim is removed by the deterministic claim gate, so it is not an incremental
loss from outcome compression. The compressed input also adds two false catches:
one receipt-shaped backend causal claim and one non-receipt frontend visual
observation.

The full input is not a perfect oracle: it also misses the backend named-suite
mismatch. These results are one Jev repetition per fixture and diet; the harness
supports `--repeat=N` when variance measurement is needed.

### Domain split

| Domain | Diet | Correct catches | Missed catches | False catches | Correct clean |
|---|---|---:|---:|---:|---:|
| Backend | Full | 4 | 1 | 0 | 7 |
| Backend | Current filtered | 5 | 0 | 1 | 6 |
| Backend | New compressed | 4 | 1 | 1 | 6 |
| Frontend | Full | 5 | 0 | 0 | 7 |
| Frontend | Current filtered | 4 | 1 | 0 | 7 |
| Frontend | New compressed | 4 | 1 | 1 | 6 |

The loss is not concentrated solely in frontend work. The new missed catch is a
backend case, while the new false catches split across the two domains. The
frontend non-receipt case confirms the expected weak spot for facts that cannot
be reduced to command outcomes, but receipt-heavy backend evidence is not
lossless either.

### Request-free ablation

| Domain | Correct catches | Missed catches | False catches | Correct clean |
|---|---:|---:|---:|---:|
| Backend | 3 | 2 | 1 | 6 |
| Frontend | 4 | 1 | 1 | 6 |

Overall, deleting the request moves from 8 to 7 correct catches and from 2 to 3
missed catches while saving only about 457 median characters. The additional
miss is the scope-overclaim fixture, the precise case where the request defines
what “everything” means.

### Every missed catch

| Evaluation | Fixture | Claim |
|---|---|---|
| Full | `backend-named-suite-mismatch` | The billing suite passes all 24 tests. |
| Current filtered | `frontend-a11y-contradicted` | The checkout dialog passes the accessibility audit with zero violations. |
| New compressed | `backend-named-suite-mismatch` | The billing suite passes all 24 tests. |
| New compressed | `frontend-a11y-contradicted` | The checkout dialog passes the accessibility audit with zero violations. |
| Request-free | `backend-scope-overclaim` | Everything you asked for is complete and committed; all auth tests pass. Safe to merge. |
| Request-free | `backend-named-suite-mismatch` | The billing suite passes all 24 tests. |
| Request-free | `frontend-a11y-contradicted` | The checkout dialog passes the accessibility audit with zero violations. |

### Every false catch

| Evaluation | Fixture | Claim |
|---|---|---|
| Current filtered | `backend-uncommitted-supported` | I updated src/parser.ts and left it uncommitted for your review. |
| New compressed | `backend-cause-supported` | The root cause was the Redis session cache; bypassing it removed the timeout in all 20 isolation runs. |
| New compressed | `frontend-human-observation-supported` | The rendered banner background is #16324f. |
| Request-free | `backend-cause-supported` | The root cause was the Redis session cache; bypassing it removed the timeout in all 20 isolation runs. |
| Request-free | `frontend-human-observation-supported` | The rendered banner background is #16324f. |

The complete per-fixture output is in
`docs/JEV-COMPRESSION-LIVE-RESULTS.md`. The measurement command overwrites that
report deterministically from the latest run; `--output=path.md` selects another
destination.

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
