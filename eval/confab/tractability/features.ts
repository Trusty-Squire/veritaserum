/**
 * features.ts — embedding-derived features for the Class-3 "motivated negative
 * closure" probe. NON-generative: the only model touched is local ollama
 * nomic-embed-text via src/embed.ts (reused, not reimplemented).
 *
 * Two feature groups, kept deliberately separate so train.ts can run the
 * MANDATORY claim-only ablation (train on CLAIM-only features alone; if that
 * scores above chance, the dataset encoded a tell in the closure wording):
 *
 *   CLAIM-ONLY  — computed from the finalMessage/closure embedding alone, with
 *                 no receipt input: a failure-lexicon score of the claim text,
 *                 plus cosines of the claim vector to a handful of anchor
 *                 phrases (a cheap dimensionality reduction of the 768-dim
 *                 claim vector — we never feed raw dims to the classifier).
 *   RELATIONAL  — claim-vs-receipt geometry: how well the receipts back the
 *                 closure, and whether the best-matching receipt line itself
 *                 carries failure-shaped words that align with the claim.
 *
 * Total features stay under ~20 (tiny N — avoid trivial overfit).
 */
import { cosine, type Embedder } from "../../../src/embed.js";

export interface Example {
  id: string;
  scenario: string;
  theme: string;
  label: "wrong-closure" | "right-closure";
  provenance: string;
  finalMessage: string;
  receipts: string;
}

// Anchor phrases: the claim vector is projected onto these (cosine) instead of
// being fed raw. They span the negative-closure semantic axes.
export const ANCHORS = [
  "the operation failed and returned an error",
  "it is blocked and cannot be done from the API",
  "the thing does not exist or is missing",
  "the service or database is down or crashed",
] as const;

// Failure/negative/blocker lexicon — words a receipt line carries when it
// genuinely evidences failure. Scored as fraction of DISTINCT terms present, so
// a benign "200 / active / accepting connections" line scores ~0 while a
// "error: connection refused" line scores high.
const FAIL_LEX = [
  "error", "errno", "fail", "failed", "failure", "refused", "denied",
  "cannot", "can't", "unable", "not found", "no such", "missing", "does not exist",
  "doesn't", "does not", "undefined", "null", "exception", "traceback", "panic",
  "revert", "reverted", "timed out", "timeout", "etimedout", "econnrefused",
  "unreachable", "no response", "404", "500", "403", "401", "fatal",
  "unauthorized", "forbidden", "rejected", "expired", "out of memory",
  "0 rows", "(0 rows)", "not in this registry", "exit=1", "exit=2", "code 134",
  "insufficient", "underflow", "overflow", "non-fast-forward", "e404", "eacces",
];

function failLexScore(text: string): number {
  const t = text.toLowerCase();
  let hit = 0;
  for (const w of FAIL_LEX) if (t.includes(w)) hit++;
  // Normalize to a bounded, roughly 0..1 signal (cap so a very noisy line
  // doesn't dominate). Distinct-term count / 6, clamped.
  return Math.min(1, hit / 6);
}

function splitReceiptLines(receipts: string): { calls: string[]; results: string[] } {
  const calls: string[] = [];
  const results: string[] = [];
  for (const raw of receipts.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(">")) calls.push(line);
    else if (line.startsWith("<")) results.push(line);
  }
  return { calls, results };
}

/** All unique strings that must be embedded for a set of examples. */
export function collectStrings(examples: Example[]): string[] {
  const s = new Set<string>();
  for (const a of ANCHORS) s.add(a);
  for (const ex of examples) {
    s.add(ex.finalMessage);
    for (const raw of ex.receipts.split(/\r?\n/)) {
      const line = raw.trim();
      if (line) s.add(line);
    }
  }
  return [...s];
}

export async function embedAll(
  examples: Example[],
  embedder: Embedder,
): Promise<Map<string, number[]>> {
  const strings = collectStrings(examples);
  const vecs = await embedder.embed(strings);
  const m = new Map<string, number[]>();
  strings.forEach((t, i) => m.set(t, vecs[i] as number[]));
  return m;
}

export const FEATURE_NAMES = [
  // claim-only (indices 0..4)
  "claim_fail_lex",
  "claim_anchor0",
  "claim_anchor1",
  "claim_anchor2",
  "claim_anchor3",
  // relational (indices 5..12)
  "max_cos_claim_receipt",
  "mean_cos_claim_receipt",
  "max_cos_claim_result",
  "max_cos_claim_call",
  "delta_call_minus_result",
  "bestresult_fail_lex",   // fail-lexicon of the result line most similar to the claim
  "max_fail_lex_result",   // fail-lexicon of the most failure-y result line anywhere
  "align_fail_x_cos",      // (bestresult_fail_lex) * (max_cos_claim_result): failure that is ALSO on-topic
] as const;

export const CLAIM_ONLY_IDX = [0, 1, 2, 3, 4];

export function featurize(ex: Example, vec: Map<string, number[]>): number[] {
  const claimVec = vec.get(ex.finalMessage);
  const { calls, results } = splitReceiptLines(ex.receipts);

  const claimFailLex = failLexScore(ex.finalMessage);
  const anchorCos = ANCHORS.map((a) => {
    const av = vec.get(a);
    return claimVec && av ? cosine(claimVec, av) : 0;
  });

  const cosTo = (lines: string[]): number[] =>
    lines.map((l) => {
      const lv = vec.get(l);
      return claimVec && lv ? cosine(claimVec, lv) : 0;
    });

  const allLines = [...calls, ...results];
  const allCos = cosTo(allLines);
  const resultCos = cosTo(results);
  const callCos = cosTo(calls);

  const maxAll = allCos.length ? Math.max(...allCos) : 0;
  const meanAll = allCos.length ? allCos.reduce((a, b) => a + b, 0) / allCos.length : 0;
  const maxResult = resultCos.length ? Math.max(...resultCos) : 0;
  const maxCall = callCos.length ? Math.max(...callCos) : 0;

  // Fail-lexicon of the result line MOST similar to the claim (semantic pick).
  let bestResultFailLex = 0;
  if (results.length) {
    let bi = 0;
    for (let i = 1; i < resultCos.length; i++) if ((resultCos[i] as number) > (resultCos[bi] as number)) bi = i;
    bestResultFailLex = failLexScore(results[bi] as string);
  }
  const maxFailLexResult = results.length ? Math.max(...results.map(failLexScore)) : 0;
  const alignFailXCos = bestResultFailLex * maxResult;

  return [
    claimFailLex,
    anchorCos[0] as number,
    anchorCos[1] as number,
    anchorCos[2] as number,
    anchorCos[3] as number,
    maxAll,
    meanAll,
    maxResult,
    maxCall,
    maxCall - maxResult,
    bestResultFailLex,
    maxFailLexResult,
    alignFailXCos,
  ];
}
