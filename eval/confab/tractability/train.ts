/**
 * train.ts — plain-TypeScript logistic regression (batch gradient descent, L2)
 * plus leave-one-scenario-out cross-validation and metrics. NO npm deps, no
 * generative model. ~ the whole "small model" of the experiment.
 *
 * Standardization is fit on TRAIN folds only (mean/std per feature) and applied
 * to the held-out fold, so no test-fold statistics leak into training.
 */

export interface LogRegModel {
  w: number[];
  b: number;
  mean: number[];
  std: number[];
}

function standardizeFit(X: number[][]): { mean: number[]; std: number[] } {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) mean[j] += (row[j] as number) / n;
  for (const row of X)
    for (let j = 0; j < d; j++) std[j] += ((row[j] as number) - mean[j]) ** 2 / n;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) || 1; // guard zero-variance
  return { mean, std };
}

function applyStd(row: number[], mean: number[], std: number[]): number[] {
  return row.map((v, j) => (v - (mean[j] as number)) / (std[j] as number));
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/** Train logistic regression by full-batch gradient descent with L2. */
export function trainLogReg(
  X: number[][],
  y: number[],
  opts: { lr?: number; iters?: number; l2?: number } = {},
): LogRegModel {
  const lr = opts.lr ?? 0.3;
  const iters = opts.iters ?? 2000;
  const l2 = opts.l2 ?? 1.0;
  const { mean, std } = standardizeFit(X);
  const Xs = X.map((r) => applyStd(r, mean, std));
  const n = Xs.length;
  const d = Xs[0]?.length ?? 0;
  const w = new Array(d).fill(0);
  let b = 0;

  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const row = Xs[i] as number[];
      let z = b;
      for (let j = 0; j < d; j++) z += (w[j] as number) * (row[j] as number);
      const err = sigmoid(z) - (y[i] as number);
      for (let j = 0; j < d; j++) gw[j] += (err * (row[j] as number)) / n;
      gb += err / n;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] + (l2 * (w[j] as number)) / n);
    b -= lr * gb;
  }
  return { w, b, mean, std };
}

export function predictProba(model: LogRegModel, row: number[]): number {
  const r = applyStd(row, model.mean, model.std);
  let z = model.b;
  for (let j = 0; j < model.w.length; j++) z += (model.w[j] as number) * (r[j] as number);
  return sigmoid(z);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
export interface Metrics {
  n: number;
  accuracy: number;
  auc: number;
  confusion: { tp: number; fp: number; tn: number; fn: number };
  // precision/recall/coverage at high-confidence thresholds (the warn-tier case)
  thresholds: {
    t: number;
    precision: number;
    recall: number;
    coverage: number; // fraction of ALL examples that fire (predict positive)
    fired: number;
  }[];
}

/** Trapezoid ROC-AUC. positive label = 1 (wrong-closure). */
export function rocAuc(y: number[], p: number[]): number {
  const pairs = y.map((yi, i) => ({ y: yi, p: p[i] as number }));
  pairs.sort((a, b) => b.p - a.p);
  const P = y.filter((v) => v === 1).length;
  const N = y.length - P;
  if (P === 0 || N === 0) return NaN;
  // Sweep threshold down; accumulate TPR/FPR points, integrate by trapezoid.
  let tp = 0;
  let fp = 0;
  let prevFpr = 0;
  let prevTpr = 0;
  let auc = 0;
  let i = 0;
  while (i < pairs.length) {
    const thr = pairs[i]!.p;
    while (i < pairs.length && pairs[i]!.p === thr) {
      if (pairs[i]!.y === 1) tp++;
      else fp++;
      i++;
    }
    const tpr = tp / P;
    const fpr = fp / N;
    auc += ((fpr - prevFpr) * (tpr + prevTpr)) / 2;
    prevFpr = fpr;
    prevTpr = tpr;
  }
  return auc;
}

export function metricsAt(y: number[], p: number[], thresholds = [0.5, 0.8, 0.9, 0.95]): Metrics {
  const n = y.length;
  const P = y.filter((v) => v === 1).length;
  // confusion at 0.5
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (let i = 0; i < n; i++) {
    const pred = (p[i] as number) >= 0.5 ? 1 : 0;
    if (pred === 1 && y[i] === 1) tp++;
    else if (pred === 1 && y[i] === 0) fp++;
    else if (pred === 0 && y[i] === 0) tn++;
    else fn++;
  }
  const accuracy = (tp + tn) / n;
  const auc = rocAuc(y, p);
  const thr = thresholds.map((t) => {
    let ftp = 0, ffp = 0;
    for (let i = 0; i < n; i++) {
      if ((p[i] as number) >= t) {
        if (y[i] === 1) ftp++;
        else ffp++;
      }
    }
    const fired = ftp + ffp;
    return {
      t,
      precision: fired ? ftp / fired : NaN,
      recall: P ? ftp / P : NaN,
      coverage: fired / n,
      fired,
    };
  });
  return { n, accuracy, auc, confusion: { tp, fp, tn, fn }, thresholds: thr };
}

/**
 * Leave-one-scenario-out CV: for each distinct group value, train on all other
 * groups and predict the held-out group. Returns pooled out-of-fold (y, p) plus
 * per-fold accuracy. This is the ONLY honest split here — paraphrase variants of
 * a scenario always sit together in the held-out fold, never straddling.
 */
export function losoCV(
  rows: { x: number[]; y: number; group: string }[],
  opts: { lr?: number; iters?: number; l2?: number } = {},
): { y: number[]; p: number[]; perFold: { group: string; n: number; acc: number }[] } {
  const groups = [...new Set(rows.map((r) => r.group))];
  const yOut: number[] = [];
  const pOut: number[] = [];
  const perFold: { group: string; n: number; acc: number }[] = [];
  for (const g of groups) {
    const train = rows.filter((r) => r.group !== g);
    const test = rows.filter((r) => r.group === g);
    const model = trainLogReg(train.map((r) => r.x), train.map((r) => r.y), opts);
    let correct = 0;
    for (const r of test) {
      const pr = predictProba(model, r.x);
      yOut.push(r.y);
      pOut.push(pr);
      if ((pr >= 0.5 ? 1 : 0) === r.y) correct++;
    }
    perFold.push({ group: g, n: test.length, acc: correct / test.length });
  }
  return { y: yOut, p: pOut, perFold };
}
