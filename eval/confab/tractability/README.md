# Class-3 tractability probe — can a small non-generative model recover "motivated negative closure"?

## The question

The no-LLM grounding detector (`src/grounding.ts`) catches Class 1/2 confabulation:
the load-bearing referent is **absent** from the agent's tool receipts. It stays
silent on Class 3, where the referent **is present** but the inference over it is
wrong (see the `changepubkey` fixture: the registration check ran, the agent read
a field the endpoint doesn't return, and concluded "didn't register").

This experiment tests the narrow Class-3 subclass **"motivated negative/blocker
closure"**: the agent confidently concludes *it doesn't work / it's blocked / it
failed / we can't* from evidence that is present in its own receipts but does not
actually support that closure.

**Falsifiable prediction on record:** this subclass is *not* recoverable without
reasoning — referent-presence is held constant, so the error lives entirely in the
inference, and a small embedding model should be at chance.

**How much of it can a small, non-generative model (logistic regression over
embedding features) recover before you are forced to a generative LLM?**

## Method

- **Data** (`dataset.json`): 15 confab *themes* (a curl reading a present-but-wrong
  field → false "not registered"; failing tests in an unrelated module → false "my
  change broke it"; a 500 whose body is an app `TypeError` → false "the DB is down";
  a typo'd grep → false "the function doesn't exist"; a linter `exit 1` on
  warnings-only → false "the build is broken"; a 404 on a typo'd path, a
  permission-denied on the *wrong* path, an `ETIMEDOUT` misread as a registry 404, a
  health check on the wrong port, a non-fast-forward push misread as "no access", a
  401 for a missing header misread as "key expired", a compile error in a dependency,
  a caller-side revert, a wrong-column query). Each theme has a **wrong-closure**
  member (receipts present but don't support the closure) and a mirrored
  **right-closure** member (the same-shaped receipts genuinely support it — the field
  is `null`, the failing test *is* the touched module, the 500 body literally says
  `Connection refused`). 30 scenarios × 3 paraphrase variants = **90 examples,
  balanced 45/45**. The referent is **always present** in the receipts, both labels;
  only whether the inference is valid differs.
- **Model** (`train.ts`): plain-TypeScript logistic regression, full-batch gradient
  descent, L2, z-score standardization fit on train folds only. No npm deps, no
  generative model.
- **Features** (`features.ts`, 13 total, all from local ollama `nomic-embed-text`):
  5 **claim-only** (a failure-lexicon score of the closure text + 4 cosines of the
  claim vector to fixed anchor phrases — a cheap reduction of the 768-dim vector, we
  never feed raw dims), and 8 **relational** (max/mean cosine of claim vs receipt
  lines; max cosine vs the best `<` result line and best `>` call line; the call-minus-
  result delta; the failure-lexicon of the *best-matching* result line; the max
  failure-lexicon over any result line; and failure-lexicon × on-topic-cosine — "is
  the failure-shaped evidence also about the thing the claim is about").

### Leakage guard

Two guards, both mandatory:

1. **Hold out by scenario, never by paraphrase.** Cross-validation is
   leave-one-scenario-out: all 3 paraphrase variants of a scenario sit together in
   the held-out fold, so paraphrase similarity can never inflate the score. We also
   report the **stricter leave-one-THEME-out** split (hold out *both* sides of a
   theme at once), which is the true generalization test — see below.
2. **Claim-only ablation (mandatory).** Within every theme the wrong- and
   right-closure members **share the identical pool of closure strings** (variant `v`
   of each side is the same finalMessage text). So closure wording carries *zero*
   label information by construction — a confabulating agent and an honest agent are
   made to sound *identically* confident. Training on the claim-only features alone
   must therefore be at chance. It is (below).

## Actual numbers (real run — `pnpm tsx eval/confab/tractability/run.ts`, ollama up)

| evaluation | accuracy @0.5 | ROC-AUC | precision @0.8 (recall / coverage) |
| --- | --- | --- | --- |
| **Claim-only ablation** (LOSO) | 0.0% | **0.000** | — (never fires) |
| **Full model, leave-one-scenario-out** | 28.9% | 0.224 | 12.5% (2% / 9%) |
| **Full model, leave-one-THEME-out** (unseen family) | 51.1% | **0.558** | 71.4% (22% / 16%) |
| **Real-only probe** (frozen model, never trained on) | 75.0% | 1.000 | 100% (60% / 38%) |

Confusion @0.5, leave-one-theme-out: TP=26 FP=25 TN=20 FN=19.

### Reading these numbers

- **The claim-only ablation passes emphatically.** AUC **0.000** is the degenerate
  form of "at chance": because every closure string appears once as wrong and once as
  right with identical claim features, the only claim-keyed evidence the model ever
  has is the held-out example's *mirror*, labelled the opposite way — so it is
  systematically wrong. The claim wording is **not** a tell. Whatever the full model
  does, it is not reading the label off the sentence.
- **Leave-one-scenario-out is below chance (AUC 0.224)** because that split *puts the
  mirror in the training fold* — a near-identical receipt structure with the opposite
  label pulls the global boundary the wrong way. This is a confound of the split, not
  a property of the task, which is exactly why the theme-level split matters more.
- **Leave-one-THEME-out — the honest headline — is chance (AUC 0.558, accuracy
  51.1%).** Shown a confab *family it has never seen*, the small model cannot tell a
  wrong closure from a right one. There is a faint above-base-rate signal only at high
  confidence (71% precision when it fires, but at 16% coverage / 22% recall) — nowhere
  near the "20% of wrong-closures at 95% precision" bar that would make a real warn
  tier. The learned weights are diffuse and mostly small (largest `|w|`≈0.56 on
  `mean_cos_claim_receipt`); no single embedding feature isolates "the inference is
  wrong".
- **The real-only probe looks great (AUC 1.000) — and that is the instructive part,
  not a contradiction.** That model was trained on **all** synthetic themes and the
  real cases are instances of families it saw (a flat-memory 500 → "memory leak", a
  normal-CPU latency bump → "add replicas", a stale benchmark → "no need to
  optimize", a blocker with no attempt). It ranks all 5 real wrong-closures above 2 of
  3 real right-closures and fires at 100% precision / 38% coverage. The two misses are
  both real right-closures scored just over 0.5 — false positives, not missed catches.

## Honest conclusion

**The prediction largely holds.** Holding referent-presence constant, a small
non-generative model has **no general capability** to judge whether an inference over
present evidence is valid: on an unseen confab family it is at chance (AUC 0.558,
~51% accuracy), and even its best high-confidence tier (~71% precision, ~22% recall)
falls well short of a useful warn threshold. Embedding geometry can measure *whether
the claim is on-topic with the receipts* — it cannot measure *whether the receipts
license the conclusion*, which is the whole of Class 3. That is the reasoning step,
and it is where a generative LLM becomes necessary.

**The one real nuance the data forces:** a small model *can* fit the relational
signature of **specific, enumerated** confab shapes it has been trained on, and would
then fire usefully on new instances of those same shapes (the real-probe AUC 1.000,
100% precision @0.8). So the recoverable fraction is not "some percent of Class 3
in general" — it is "close to all of a *known, closed* list of confab templates, and
essentially none of anything outside it". A narrow trained detector is viable only as
a warn-tier for a hand-curated catalogue of recurring confab families, never as a
general Class-3 judge. For open-world Class 3, the generative auditor stays load-
bearing.

## LLM judge (zero-shot)

The section above proves a *trained* embedding classifier is at chance on an unseen
confab family (theme-out AUC 0.558). The complementary question: can a local
**generative** model, prompted **zero-shot**, judge *"do these receipts actually
support this conclusion?"* — and does capability scale with model size? Zero-shot
means no training and no leakage: every theme is unseen to the judge, so we evaluate
all 98 examples and report synthetic and real separately. Positive class =
wrong-closure (`supported:false` is the correct call); right-closure → `supported:true`.

Runner: `pnpm tsx eval/confab/tractability/llm-judge.ts [--model <name>]`
(local ollama `/api/chat`, temperature 0, strict-JSON prompt, defensive
first-object parse + one retry). Verdicts + aggregates in `results-llm-judge.json`.

**The box is CPU-only** (no GPU; qwen2.5:14b at 9.9 GB ran ~25 s per judgment). So
**qwen2.5:14b was judged on a stratified sample — the v0 paraphrase of both the
wrong- and right-closure member of every theme: 15 × 2 = 30 balanced synthetic
(15 wrong / 15 right) + all 8 real.** qwen2.5:3b and llama3.2:1b ran the **full 90**
(45/45) + 8 real. Numbers below are from one real run; the 14b synthetic row is
**n=30 sampled**, treat it as indicative, not a full-set estimate.

### Wrong-closure detection (synthetic)

| judge / baseline | n | accuracy | precision(wrong) | recall(wrong) | ROC-AUC | parse-fail | mean latency |
| --- | --- | --- | --- | --- | --- | --- | --- |
| majority-class (predict all-wrong) | 90 | 50.0% | 50.0% | 100% | 0.500 | — | — |
| **trained classifier, theme-out** (prior expt) | 90 | 51.1% | 71.4% @0.8 | 22% | **0.558** | — | ~0 (embed) |
| **llama3.2:1b** (full) | 90 | 51.1% | 83.3% | 11.1% | **0.480** | 4.4% | 3.1 s |
| **qwen2.5:3b** (full) | 90 | 64.4% | 81.0% | 37.8% | **0.666** | 0.0% | 6.0 s |
| **qwen2.5:14b** (sampled) | **30** | 83.3% | 77.8% | 93.3% | **0.767** | 0.0% | 24.8 s |

Confusion (parsed): **14b** TP=14 FP=4 TN=11 FN=1 · **3b** TP=17 FP=4 TN=41 FN=28 ·
**1b** TP=5 FP=1 TN=41 FN=39 (+4 parse-fails).

### Real Class-3 probe (n=8: 5 wrong-closure, 3 right-closure)

| judge | accuracy | wrong caught | right kept | parse-fail |
| --- | --- | --- | --- | --- |
| **qwen2.5:14b** | **100%** | **5/5** | 3/3 | 0 |
| qwen2.5:3b | 50.0% | 1/5 | 3/3 | 0 |
| llama3.2:1b | 50.0% | 1/5 | 3/3 | 0 |

### Reading these numbers

- **Capability scales cleanly with size, and the jump is real.** AUC climbs
  0.480 → 0.666 → 0.767 (1b → 3b → 14b), accuracy 51% → 64% → 83%, wrong-closure
  recall 11% → 38% → 93%. The 14b judge is the only one that clears the
  trained-classifier bar decisively: on the sampled synthetic it catches 14/15 wrong
  closures at 78% precision (AUC 0.767 vs 0.558), and on the **8 real Class-3 cases it
  is perfect — 5/5 confabs caught, 3/3 honest closures kept**. This is exactly the
  reasoning step the embedding geometry could not do.
- **No model games the format** (the honesty check). The worry was a judge that
  always answers `false` to farm cheap wrong-closure recall. The `always-false` rate
  is 7% (1b), 23% (3b), 60% (14b) — the *small* models are biased the **opposite**
  way: they default to trusting the agent (`supported:true`), which is why their
  precision looks high (81–83%) but their recall is a floor-scraping 11–38% — they
  only fire when overwhelmingly sure and miss most confabs. The trained classifier's
  71% precision and the small LLMs' 81% precision are the same illusion at different
  addresses: precision bought with near-zero coverage. Only 14b leans skeptical, and
  it still *discriminates* (AUC 0.767, not a degenerate 0.5) rather than blanket-failing.
- **Parse reliability is a non-issue at this task.** Every model emitted parseable
  strict JSON almost always; 1b's 4/90 (4.4%) parse-fails are the only blemish and did
  not decide its verdict — it is at chance (AUC 0.480) on judgment, not on formatting.
- **14b's worst themes** (`404-not-deployed` 0/2, and `curl-field` / `linter-exit1` /
  `migration-column` at 1/2) show the residual failure mode is a specific inference it
  still gets wrong, not noise — but at n=2 per theme in the sample these are directional.

### Honest verdict

**Is qwen2.5:14b good enough to be the local Class-3 auditor tier? Yes — as a
warn tier, not a block tier, and only if you can eat CPU latency.** On the real
Class-3 probe it is perfect (5/5 / 3/3); on the sampled synthetic it recovers
wrong-closure judgment the embedding model could not (AUC 0.767, 93% recall) — but at
**78% precision one flag in ~4.5 is a false alarm** (4 honest closures wrongly
flagged out of 15), which is fine to *warn* on and too noisy to *block* on, and each
judgment costs **~25 s on this CPU-only box**. **3b lands in the middle** (AUC 0.666):
above chance and above the trained classifier, fast (6 s), but 38% recall means it
misses most confabs — a weak warn tier at best, and only 1/5 on the real cases.
**1b is hopeless as a judge** (AUC 0.480, 11% recall, 1/5 real) despite emitting clean
JSON — it just trusts the agent.

**The "Class 3 needs a generative LLM" claim is SUPPORTED, with one scoping caveat.**
A generative model *does* recover the reasoning step that the embedding classifier
provably cannot, and the recovery scales monotonically with size — so the mechanism
the claim names is the right one. The remaining question is not *whether* a generative
LLM but *how big*: a local 14B model is enough for a **warn** tier (and nails the real
cases), but its ~78% precision and 25 s/turn CPU cost mean a high-precision **block**
tier still points at frontier-scale (or a GPU + a larger local model). Net:
**generative-LLM-necessary = confirmed; local-14B-sufficient = yes for warn, needs
frontier-scale for block.**

## Provenance

- `results-llm-judge.json` / `llm-judge.ts` — zero-shot generative-judge probe
  (local ollama, non-training). 14b synthetic row is a **stratified n=30 sample**
  (CPU-only box); 3b and 1b are full 90. Reuses `rocAuc` from `train.ts`.
- `dataset.json` — `examples` are synthetic (generated to enforce the claim-sharing
  invariant; each carries `provenance: "synthetic"` and a per-theme `_theme_note`).
  `real_probe` are drawn from real repo fixtures (`eval/confab/grounding` changepubkey
  & funds-locked, `eval/confab/fixtures.json` Arm B api-500s & latency-after-deploy,
  and `eval/confab/tractability/repo` stale-benchmark), each with a `provenance` note;
  the probe set is **never** trained on.
- Reuses `src/embed.ts` (`ollamaEmbedder`, `cosine`) unchanged. Non-generative
  throughout — the only model call is local `nomic-embed-text` embeddings.
