/**
 * Turn-boundary interpretation seams (DESIGN §6). Two fuzzy questions the hook
 * needs answered — behind interfaces so the LLM drops in at P2. P1 ships
 * deterministic heuristics (no network); they are intentionally conservative.
 *
 *  - ClaimExtractor: did the agent claim the task is DONE / tests pass? Only a
 *    completion claim can be CONTRADICTED — honest incompleteness must pass, or
 *    the tool traps the agent mid-work.
 *  - CorrectionClassifier: is the human's message a CORRECTION to the shipped
 *    contract (→ ratchet) versus a new request or chatter?
 */
import type { ContractFile } from "./schema.js";
import type { LlmClient } from "./llm.js";

export interface ClaimVerdict {
  claimsDone: boolean;
  /** The phrase that triggered it (for the block reason / audit). */
  evidence?: string;
}
export type ClaimExtractor = (message: string) => ClaimVerdict | Promise<ClaimVerdict>;

const DONE = /\b(done|complete[d]?|finished|shipped|ready to (review|ship|merge)|all (the )?tests? (are )?pass(ing|ed)?|tests? (are )?(now )?passing|it works now|works as expected|implemented (it|the|this)|fixed it|good to go)\b/i;
const NOT_DONE = /\b(not|isn't|isn['’]t|aren't|aren['’]t|don't|doesn't|can't|couldn't|still (need|have to|failing|broken)|not yet|in progress|wip|partially|almost|next step|todo|remaining)\b/i;

/**
 * P1 heuristic: a completion claim fires only when a done-phrase appears AND the
 * same message does not carry a nearby negation/incompleteness marker. Biased to
 * FALSE (honest-incomplete passes) — a missed claim is a soft miss; a false claim
 * would trap the agent. The LLM extractor (P2) replaces this.
 */
export const mockClaimExtractor = (message: string): ClaimVerdict => {
  const m = message ?? "";
  const hit = m.match(DONE);
  if (!hit) return { claimsDone: false };
  if (NOT_DONE.test(m)) return { claimsDone: false };
  return { claimsDone: true, evidence: hit[0] };
};

/**
 * LLM-backed claim extractor (cross-vendor judge, DESIGN §9). Reads the executor's
 * final message and judges whether it CLAIMS completion. Fails SAFE: any parse
 * error or exception falls back to the conservative heuristic, so a judge outage
 * never fabricates a block. The client should be a vendor ≠ the executor.
 */
export function makeLlmClaimExtractor(client: LlmClient): ClaimExtractor {
  return async (message) => {
    if (!(message ?? "").trim()) return { claimsDone: false };
    const system =
      "You judge whether a coding agent's final message CLAIMS the task is finished. " +
      "Be strict: true only if it asserts completion, or that the build/tests pass. " +
      "Honest progress, partial work, or questions are false.";
    const prompt =
      `Agent message:\n"""\n${message}\n"""\n` +
      `Reply with ONLY compact JSON: {"claimsDone": true|false, "evidence": "<short quote or empty>"}`;
    try {
      const raw = await client.complete({ system, prompt, timeoutMs: 60_000 });
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return mockClaimExtractor(message);
      const parsed = JSON.parse(m[0]) as { claimsDone?: unknown; evidence?: unknown };
      if (typeof parsed.claimsDone !== "boolean") return mockClaimExtractor(message);
      return {
        claimsDone: parsed.claimsDone,
        ...(typeof parsed.evidence === "string" && parsed.evidence ? { evidence: parsed.evidence } : {}),
      };
    } catch {
      return mockClaimExtractor(message);
    }
  };
}

export interface CorrectionVerdict {
  isCorrection: boolean;
}
export type CorrectionClassifier = (message: string, contract: ContractFile) => CorrectionVerdict;

const CORRECTION = /\b(still|again|didn't|did not|doesn't|does not|isn't|not working|not right|wrong|broken|should (have|be|not|include)|actually|no,|nope|that's not|thats not|regression|bug|missing|instead)\b/i;

/**
 * P1 heuristic: a correction only when a sealed contract already exists (there is
 * something to correct) AND the message reads like a complaint. Conservative;
 * the LLM classifier (P2) handles the real new-request vs correction split.
 */
export const mockCorrectionClassifier: CorrectionClassifier = (message, contract) => {
  const sealed = contract.contractCommit !== null && contract.gates.length > 0;
  return { isCorrection: sealed && CORRECTION.test(message ?? "") };
};
