# Jev prompt-packaging optimization study

Measured 2026-09-19 against `jev-latest`, using 60 labelled fixtures and five repetitions per fixture/cell.

## Answer

Two findings matter together:

1. **Nothing ships on this evidence.** No single optimization cleared the prespecified noise floor on the 60-fixture study. The surviving-optimization composite therefore contains nothing and remains **20/24 (83.3%)** on the original corpus, against **20/24 today** and the **23/24 uncompressed ceiling**. It recovered **0 of the 3** fixtures lost to compression.
2. **Paired evidence (A3) exactly matched the full-evidence ceiling on the pre-existing corpus at about one sixty-sixth the size.** It scored **115/120 (23/24 in every repetition)** with 45 correct catches, 5 misses, and zero false catches—the same result as full evidence—at **901.5 median characters** versus full evidence's **59,337**.

No single optimization cleared the prespecified noise floor, so C1 contained no optimizations and was a fresh compressed-control replication. Enabling all five anyway (C2) did score 23/24 on the original fixtures, but its gain did not replicate as measurable on the balanced 60-fixture corpus. It is therefore not a surviving combination and is not enabled in production.

The all-five combination did not beat the best single optimization. Paired evidence (A3) scored 93.3% on the 60-fixture corpus; all five together (C2) scored 91.7%. Both scored 23/24 on the original fixtures.

## Method

- The original 24 fixtures from `f64e1b6` remain the first 24 entries, unchanged and separately reported.
- The corpus was expanded to 60: 30 flag and 30 clean, evenly divided into 30 backend and 30 frontend fixtures.
- Historical real turns were not reconstructed. Telemetry retains only 400-character claim prefixes, not the full request, evidence, and response needed for a labelled fixture.
- The 36 new fixtures were authored by the Codex worker running this study on 2026-09-19, after the five optimization hypotheses had already been specified, using the same claim/receipt style as the originals. This creates an instrument-design limitation: an arm can look deterministic on the corpus that predates the experiment yet look like noise on fixtures written after the hypothesis. The study does not establish that the new fixtures are biased, but it also cannot rule out that risk. The original-24 and expanded-corpus results must therefore be read together.
- Every cell used five repetitions. Accuracy intervals below are 95% Wilson intervals over the repeated judgements; repetition spread is the minimum–maximum pass rate across the five runs.
- Arm effects used a paired 10,000-sample bootstrap over fixture clusters. A single arm counted as a gain only when that 95% interval versus compressed baseline excluded zero.
- Empty deterministic claim selections were scored clean without a Jev call, as in production.

## Baseline

The original-corpus baseline reproduced the published table exactly in every repetition: full was 23/24 and compressed was 20/24.

| Diet | Median chars | 60-fixture accuracy (95% CI) | Repetition spread | Original-24 accuracy (95% CI) |
|---|---:|---:|---:|---:|
| full | 59,337 | 285/300 = 95.0% (91.9%–96.9%) | 95.0%–95.0% | 115/120 = 95.8% (90.6%–98.2%); 23/24 each run |
| filtered | 22,255 | 269/300 = 89.7% (85.7%–92.6%) | 88.3%–90.0% | 113/120 = 94.2% (88.4%–97.1%); 22–23/24 |
| compressed | 2,664.5 | 269/300 = 89.7% (85.7%–92.6%) | 88.3%–90.0% | 100/120 = 83.3% (75.7%–88.9%); 20/24 each run |

## Single optimization arms

| Arm | Optimization | Median chars | Accuracy (95% CI) | Repetition spread | Difference from compressed (paired 95% CI) | Result |
|---|---|---:|---:|---:|---:|---|
| A1 | Negative anchor | 2,664.5 | 266/300 = 88.7% (84.6%–91.8%) | 86.7%–90.0% | −1.0 points (−3.0 to 0.0) | No measurable effect |
| A2 | Typed claim reasons | 2,785.5 | 270/300 = 90.0% (86.1%–92.9%) | 90.0%–90.0% | +0.3 points (−4.7 to +5.3) | No measurable effect |
| A3 | Paired evidence | 901.5 | 280/300 = 93.3% (89.9%–95.6%) | 93.3%–93.3% | +3.7 points (−2.7 to +10.3) | No measurable effect |
| A4 | Per-claim questions | 2,737.5 | 265/300 = 88.3% (84.2%–91.5%) | 88.3%–88.3% | −1.3 points (−4.0 to 0.0) | No measurable effect |
| A5 | Combined confabulation mass | 2,664.5 | 264/300 = 88.0% (83.8%–91.2%) | 86.7%–90.0% | −1.7 points (−4.3 to 0.0) | No measurable effect |

Original-24 accuracy was 20/24 for A1, A4, and A5; 21/24 for A2; and 23/24 for A3, in every repetition.

A3 is the standout follow-up candidate: on the only corpus that existed before this study, it removed both compressed false catches while retaining 9/10 catches, exactly matching full evidence at 1.5% of the state size. Its expanded-corpus interval still crosses zero, so this is a reason to validate the instrument and collect independent fixtures—not permission to ship A3.

## Composite arms

| Arm | Composition | Median chars | Accuracy (95% CI) | Repetition spread | Difference from compressed (paired 95% CI) | Original 24 | Result |
|---|---|---:|---:|---:|---:|---:|---|
| C1 | Measurable single-arm winners: none | 2,664.5 | 262/300 = 87.3% (83.1%–90.6%) | 86.7%–88.3% | −2.3 points (−6.0 to 0.0) | 100/120 = 83.3%; 20/24 each run | No measurable effect; 0/3 recovered |
| C2 | All five | 938.5 | 275/300 = 91.7% (88.0%–94.3%) | 91.7%–91.7% | +2.0 points (−5.0 to +10.0) | 115/120 = 95.8%; 23/24 each run | No measurable effect; apparent original-set recovery did not clear noise floor |

The all-five interaction is directionally positive and keeps the state payload far below 10K characters, but the study does not support shipping it as an accuracy improvement. A negative result remains the result.

## Cost

The study made **2,685 Jev calls**: 830 for baseline, 1,325 for single arms, and 530 for composites. The other 315 of 3,000 fixture/repetition evaluations were deterministic no-claim skips.

Provider-reported usage totalled **8,259,750 input tokens** and **146,330 output tokens**. Jev returned no dollar-price field for any of the 2,685 calls, and no public official price was available, so exact total dollar spend is **unknown** rather than zero.

## Artifacts

- Baseline prose: `docs/JEV-PROMPT-OPTIMIZATION-BASELINE.md`
- Single-arm prose: `docs/JEV-PROMPT-OPTIMIZATION-SINGLES.md`
- Composite prose: `docs/JEV-PROMPT-OPTIMIZATION-COMPOSITES.md`
- Per-call data: `eval/jev-compression/results/baseline.json`, `singles.json`, and `composites.json`
- Reproducible harness: `scripts/measure-jev-compression.ts`

The experimental request-packaging paths remain opt-in to the measurement harness. Production continues to use the unchanged compressed request because no optimization survived the statistical gate.
