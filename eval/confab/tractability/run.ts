/**
 * run.ts — end-to-end: embed the dataset with REAL local ollama
 * (nomic-embed-text), build features, run leave-one-scenario-out CV for the
 * full model AND the mandatory claim-only ablation, then evaluate the frozen
 * full model on the never-trained REAL probe set. Prints all metrics.
 *
 *   pnpm tsx eval/confab/tractability/run.ts
 *
 * Requires ollama up at OLLAMA_HOST (default http://127.0.0.1:11434) with
 * nomic-embed-text pulled. Non-generative throughout.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ollamaEmbedder } from "../../../src/embed.js";
import {
  type Example,
  embedAll,
  featurize,
  FEATURE_NAMES,
  CLAIM_ONLY_IDX,
} from "./features.js";
import {
  losoCV,
  trainLogReg,
  predictProba,
  metricsAt,
  type Metrics,
} from "./train.js";

const HERE = dirname(fileURLToPath(import.meta.url));

interface Dataset {
  examples: Example[];
  real_probe: Example[];
  _counts: Record<string, number>;
}

const LABEL_POS = "wrong-closure"; // positive class = the confab we want to catch

function pct(x: number): string {
  return Number.isNaN(x) ? "  n/a" : (x * 100).toFixed(1).padStart(5) + "%";
}

function printMetrics(title: string, m: Metrics): void {
  const c = m.confusion;
  console.log(`\n=== ${title} (n=${m.n}) ===`);
  console.log(`  accuracy @0.5 : ${pct(m.accuracy)}`);
  console.log(`  ROC-AUC       : ${Number.isNaN(m.auc) ? "n/a" : m.auc.toFixed(3)}`);
  console.log(`  confusion@0.5 : TP=${c.tp} FP=${c.fp} TN=${c.tn} FN=${c.fn}`);
  console.log(`  threshold  precision  recall  coverage  fired`);
  for (const t of m.thresholds) {
    console.log(
      `    ${t.t.toFixed(2)}     ${pct(t.precision)}   ${pct(t.recall)}   ${pct(t.coverage)}   ${t.fired}`,
    );
  }
}

async function main(): Promise<void> {
  const ds = JSON.parse(readFileSync(join(HERE, "dataset.json"), "utf8")) as Dataset;
  const all = [...ds.examples, ...ds.real_probe];

  console.log(
    `dataset: ${ds.examples.length} synthetic examples, ` +
      `${new Set(ds.examples.map((e) => e.scenario)).size} scenarios, ` +
      `${ds.real_probe.length} real-probe`,
  );
  console.log("embedding with local ollama nomic-embed-text ...");
  const embedder = ollamaEmbedder();
  const vec = await embedAll(all, embedder); // one batched embed for everything

  // Feature matrix for synthetic set.
  const rows = ds.examples.map((ex) => ({
    x: featurize(ex, vec),
    y: ex.label === LABEL_POS ? 1 : 0,
    group: ex.scenario,
  }));

  // ---- FULL MODEL: leave-one-scenario-out CV --------------------------------
  const full = losoCV(rows);
  const fullMetrics = metricsAt(full.y, full.p);
  printMetrics("FULL MODEL — leave-one-scenario-out CV", fullMetrics);

  // ---- FULL MODEL: leave-one-THEME-out CV -----------------------------------
  // Stricter grouping: hold out BOTH sides of a theme at once, so the held-out
  // family's mirror is never in training. This removes the mirror-in-fold
  // confound and tests pure generalization to an UNSEEN confab family.
  const themeRows = ds.examples.map((ex) => ({
    x: featurize(ex, vec),
    y: ex.label === LABEL_POS ? 1 : 0,
    group: ex.theme,
  }));
  const theme = losoCV(themeRows);
  printMetrics("FULL MODEL — leave-one-THEME-out CV (unseen family)", metricsAt(theme.y, theme.p));

  // ---- CLAIM-ONLY ABLATION (MANDATORY) --------------------------------------
  // Same LOSO protocol, but features restricted to claim-only indices. If this
  // is above chance, the dataset encodes the label in the closure wording.
  const claimRows = rows.map((r) => ({
    x: CLAIM_ONLY_IDX.map((i) => r.x[i] as number),
    y: r.y,
    group: r.group,
  }));
  const claimOnly = losoCV(claimRows);
  const claimMetrics = metricsAt(claimOnly.y, claimOnly.p);
  printMetrics("CLAIM-ONLY ABLATION — leave-one-scenario-out CV", claimMetrics);

  // ---- REAL-ONLY PROBE ------------------------------------------------------
  // Freeze a full model trained on ALL synthetic data, evaluate on real cases
  // that never appeared in training.
  const realModel = trainLogReg(rows.map((r) => r.x), rows.map((r) => r.y));
  const realY: number[] = [];
  const realP: number[] = [];
  console.log("\n=== REAL-ONLY PROBE (frozen full model, never trained on these) ===");
  for (const ex of ds.real_probe) {
    const p = predictProba(realModel, featurize(ex, vec));
    const y = ex.label === LABEL_POS ? 1 : 0;
    realY.push(y);
    realP.push(p);
    const hit = (p >= 0.5 ? 1 : 0) === y ? "OK " : "XX ";
    console.log(
      `  ${hit} p(wrong-closure)=${p.toFixed(2)}  [${ex.label}]  ${ex.id}`,
    );
  }
  const realMetrics = metricsAt(realY, realP, [0.5, 0.8, 0.9]);
  printMetrics("REAL-ONLY PROBE", realMetrics);

  // ---- Learned weights on the full data (interpretability) ------------------
  console.log("\n=== learned weights (full model on all synthetic data) ===");
  FEATURE_NAMES.forEach((name, i) => {
    console.log(`  ${name.padEnd(26)} ${(realModel.w[i] as number).toFixed(3)}`);
  });
  console.log(`  ${"bias".padEnd(26)} ${realModel.b.toFixed(3)}`);
}

main().catch((e) => {
  console.error("run failed:", e);
  process.exit(1);
});
