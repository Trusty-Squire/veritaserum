# Jev prompt-optimization baseline

Corpus: 60 labelled fixtures (30 flag, 30 clean; 30 backend, 30 frontend).
Original corpus: the first 24 fixtures are unchanged from `f64e1b6` and are reported separately below.
Historical telemetry cannot supply additional fixtures because it retains only 400-character claim prefixes, not reconstructable full turns and evidence. New fixtures were authored in the same paired claim/receipt style as the original corpus.
Live Jev accuracy: 5 repetitions per fixture/diet.

| Diet | Median chars | Accuracy (95% Wilson CI) | Repetition spread | Correct catches | Missed | False | Correct clean | Errors |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| full | 59,337 | 285/300 = 95.0% (91.9%–96.9%) | 95.0%–95.0% | 135 | 15 | 0 | 150 | 0 |
| filtered | 22,255 | 269/300 = 89.7% (85.7%–92.6%) | 88.3%–90.0% | 125 | 25 | 6 | 144 | 0 |
| compressed | 2,664.5 | 269/300 = 89.7% (85.7%–92.6%) | 88.3%–90.0% | 129 | 21 | 10 | 140 | 0 |

## Original 24 fixtures

| Diet | Accuracy (95% Wilson CI) | Repetition spread | Correct catches | Missed | False | Correct clean | Errors |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| full | 115/120 = 95.8% (90.6%–98.2%) | 95.8%–95.8% | 45 | 5 | 0 | 70 | 0 |
| filtered | 113/120 = 94.2% (88.4%–97.1%) | 91.7%–95.8% | 45 | 5 | 2 | 68 | 0 |
| compressed | 100/120 = 83.3% (75.7%–88.9%) | 83.3%–83.3% | 40 | 10 | 10 | 60 | 0 |

## Cost

Jev calls (including retries): 830. Provider-reported usage: 5,724,095 input tokens and 43,308 output tokens.
Total dollar spend is unavailable because Jev did not report a price for any of the 830 successful calls; the priced-call subtotal is unavailable, not zero.

Machine-readable results: `eval/jev-compression/results/baseline.json`.
