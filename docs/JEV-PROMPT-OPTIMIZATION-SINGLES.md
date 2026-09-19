# Jev prompt-optimization singles

Corpus: 60 labelled fixtures (30 flag, 30 clean; 30 backend, 30 frontend).
Original corpus: the first 24 fixtures are unchanged from `f64e1b6` and are reported separately below.
Historical telemetry cannot supply additional fixtures because it retains only 400-character claim prefixes, not reconstructable full turns and evidence. New fixtures were authored in the same paired claim/receipt style as the original corpus.
Live Jev accuracy: 5 repetitions per fixture/cell.

A single arm is a measurable gain only when its 95% fixture-cluster bootstrap interval versus compressed baseline excludes zero.

| Arm | Packaging | Median chars | Accuracy (95% Wilson CI) | Repeat spread | Δ vs compressed (95% paired CI) | Δ vs full | Effect | Errors |
|---|---|---:|---:|---:|---:|---:|---|---:|
| A1 | negative anchor | 2,664.5 | 266/300 = 88.7% (84.6%–91.8%) | 86.7%–90.0% | -1.0% (-3.0%–0.0%) | -6.3% | no measurable effect | 0 |
| A2 | typed claim reasons | 2,785.5 | 270/300 = 90.0% (86.1%–92.9%) | 90.0%–90.0% | 0.3% (-4.7%–5.3%) | -5.0% | no measurable effect | 0 |
| A3 | paired evidence | 901.5 | 280/300 = 93.3% (89.9%–95.6%) | 93.3%–93.3% | 3.7% (-2.7%–10.3%) | -1.7% | no measurable effect | 0 |
| A4 | per-claim questions | 2,737.5 | 265/300 = 88.3% (84.2%–91.5%) | 88.3%–88.3% | -1.3% (-4.0%–0.0%) | -6.7% | no measurable effect | 0 |
| A5 | combined confabulation mass | 2,664.5 | 264/300 = 88.0% (83.8%–91.2%) | 86.7%–90.0% | -1.7% (-4.3%–0.0%) | -7.0% | no measurable effect | 0 |

Reference rates: compressed 89.7% (269/300); full 95.0% (285/300).

## Original 24 fixtures

| Cell | Accuracy (95% Wilson CI) | Repetition spread | Correct catches | Missed | False | Correct clean | Errors |
|---|---:|---:|---:|---:|---:|---:|---:|
| A1 | 100/120 = 83.3% (75.7%–88.9%) | 83.3%–83.3% | 40 | 10 | 10 | 60 | 0 |
| A2 | 105/120 = 87.5% (80.4%–92.3%) | 87.5%–87.5% | 40 | 10 | 5 | 65 | 0 |
| A3 | 115/120 = 95.8% (90.6%–98.2%) | 95.8%–95.8% | 45 | 5 | 0 | 70 | 0 |
| A4 | 100/120 = 83.3% (75.7%–88.9%) | 83.3%–83.3% | 40 | 10 | 10 | 60 | 0 |
| A5 | 100/120 = 83.3% (75.7%–88.9%) | 83.3%–83.3% | 40 | 10 | 10 | 60 | 0 |

## Cost

Jev calls (including retries): 1,325. Provider-reported usage: 1,844,510 input tokens and 72,282 output tokens.
Total dollar spend is unavailable because Jev did not report a price for any of the 1,325 successful calls; the priced-call subtotal is unavailable, not zero.

Machine-readable results: `eval/jev-compression/results/singles.json`.
