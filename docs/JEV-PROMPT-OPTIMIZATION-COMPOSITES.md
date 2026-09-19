# Jev prompt-optimization composites

Corpus: 60 labelled fixtures (30 flag, 30 clean; 30 backend, 30 frontend).
Original corpus: the first 24 fixtures are unchanged from `f64e1b6` and are reported separately below.
Historical telemetry cannot supply additional fixtures because it retains only 400-character claim prefixes, not reconstructable full turns and evidence. New fixtures were authored in the same paired claim/receipt style as the original corpus.
Live Jev accuracy: 5 repetitions per fixture/cell.

A single arm is a measurable gain only when its 95% fixture-cluster bootstrap interval versus compressed baseline excludes zero.

| Arm | Packaging | Median chars | Accuracy (95% Wilson CI) | Repeat spread | Δ vs compressed (95% paired CI) | Δ vs full | Effect | Errors |
|---|---|---:|---:|---:|---:|---:|---|---:|
| C1 | no measurable single arms | 2,664.5 | 262/300 = 87.3% (83.1%–90.6%) | 86.7%–88.3% | -2.3% (-6.0%–0.0%) | -7.7% | no measurable effect | 0 |
| C2 | all five optimizations | 938.5 | 275/300 = 91.7% (88.0%–94.3%) | 91.7%–91.7% | 2.0% (-5.0%–10.0%) | -3.3% | no measurable effect | 0 |

Reference rates: compressed 89.7% (269/300); full 95.0% (285/300).

## Original 24 fixtures

| Cell | Accuracy (95% Wilson CI) | Repetition spread | Correct catches | Missed | False | Correct clean | Errors |
|---|---:|---:|---:|---:|---:|---:|---:|
| C1 | 100/120 = 83.3% (75.7%–88.9%) | 83.3%–83.3% | 40 | 10 | 10 | 60 | 0 |
| C2 | 115/120 = 95.8% (90.6%–98.2%) | 95.8%–95.8% | 45 | 5 | 0 | 70 | 0 |

## Cost

Jev calls (including retries): 530. Provider-reported usage: 691,145 input tokens and 30,740 output tokens.
Total dollar spend is unavailable because Jev did not report a price for any of the 530 successful calls; the priced-call subtotal is unavailable, not zero.

Machine-readable results: `eval/jev-compression/results/composites.json`.
