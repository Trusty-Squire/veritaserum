# Guard-compliance — can qwen2.5:14b actually FOLLOW the audit guards once it can SEE them?

## The question (the owner's)

`src/auditor.ts` `RULES_BLOCK` is ~1.6k tokens of carve-outs — the guards that stop
the auditor flagging honest hedges, fiction, predictions, and relayed verdicts, and
that tell it when to contradict a false "all tests pass" or mark bare "done" work
unaccountable. It sits at the **front** of every audit prompt.

A defect (fixed this change — see below) meant the production ollama auditor sent
`/api/chat` with **no `options.num_ctx`**, so ollama fell back to a 4096-token window
and dropped the **front** of any longer prompt — i.e. exactly the rules — on
receipt-heavy turns. With that fixed, the rules are now **visible**. The remaining
question is **capability**: given it can see the whole guard set, does the 14B model
actually obey it?

## Method

- Runs the **real** production prompt builder `buildPreGatheredPrompt` (exported from
  `src/auditor.ts` for this eval — it was module-private), through the **real**
  `OllamaClient` (`src/llm.ts`, now num_ctx-fixed, `format:"json"`, `temperature:0`),
  and parses each verdict with the **real** `parseReply` (also newly exported). No
  re-implementation of any production path.
- `dataset.json`: 10 hand-labeled scenarios, one per guard the rules block spells out.
  Expectation grammar: `flag` = at least one `unsupported|contradicted`; `contradicted`
  = at least one `contradicted`; `clean` = no `unsupported|contradicted` **and**
  `unaccountable:false`; `unaccountable` = `unaccountable:true`.
- Each scenario runs **twice**. `temperature` is now pinned to 0, so the two runs
  **should** agree; a disagreement is reported as a determinism finding.
- Runner: `pnpm tsx eval/confab/guard-compliance/run.ts [--model qwen2.5:14b] [--runs 2]`.
  `VS_GC_PAD_SCALE` scales the per-scenario `padKB` receipt padding (see the ceiling
  note below for why it exists).

## Results (real run — qwen2.5:14b, live ollama, temperature 0)

Each model now writes its own `results-<sanitized-model>.json` (e.g.
`results-codex-gpt-5.6-luna.json`) instead of overwriting a shared file; the
committed `results.json` in this directory is left in place as the qwen2.5:14b
baseline below.

<!-- RESULTS_TABLE -->

## The second ceiling this eval surfaced (undici 300s headers cap)

The eval was written to pad several scenarios' receipts to ~30 KB so the context fix
would be *exercised* (a padded prompt is far past the old 4096-token default, so a
correct verdict proves the front-loaded rules survived). On this **CPU-only box** that
ran into a **second, independent ceiling** unrelated to `num_ctx`:

- The production `OllamaClient` uses `fetch` (undici) with `stream:false`. ollama sends
  **no HTTP response — not even headers — until generation is fully done**, and undici
  caps time-to-headers at **300s**. A slow enough audit surfaces as an opaque
  `TypeError: fetch failed` (`UND_ERR_HEADERS_TIMEOUT`).
- <!-- CEILING_NUMBERS: warm tok/s + the token budget that fits 300s -->

The `num_ctx` fix is still correct and necessary — it is what makes the rules
*visible* at all — but on slow hardware realizing its benefit for large audits also
needs faster inference (GPU / smaller model) **or** switching the auditor client to
streaming so headers arrive immediately. This plausibly explains a share of the
"26/82 audits died with fetch failed" telemetry that `src/llm.ts`'s retry comment
attributes solely to TCP rejections: a headers-timeout on a slow eval looks identical,
and a retry (which re-sends and re-evaluates the same big prompt) cannot fix it.

Because of this ceiling, the capability numbers above were gathered at
`VS_GC_PAD_SCALE=0` (prompts small enough to complete), and the **truncation-defeat
proof is carried separately** by the `prompt_eval_count` probe (a real ~10k-token
production-shaped body → `prompt_eval_count` well above 4096; see the change report).

## Honest reading

<!-- READING -->
