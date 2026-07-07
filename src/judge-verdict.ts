/**
 * The semantic-gate JUDGE (DESIGN §3, §5). A CROSS-VENDOR LLM rules on whether a
 * gate's `claim` holds over the deterministically-captured evidence. It only
 * interprets given evidence — it never drives the app or edits anything. Output
 * is a verdict + a redacted symptom (reality → executor), never a solution.
 *
 * Fails SAFE: on any judge error or unparseable output the gate ABSTAINS (routes
 * to a human) rather than passing — a judge outage must never fabricate a green.
 */
import type { LlmClient } from "./llm.js";

export interface SemanticVerdict {
  /** "pass" | "fail" | "abstain" — abstain routes to a human, never auto-passes. */
  ruling: "pass" | "fail" | "abstain";
  symptom?: string;
}

export type SemanticJudge = (evidence: string, claim: string) => Promise<SemanticVerdict>;

const MAX_EVIDENCE = 6000;

export function makeSemanticJudge(client: LlmClient): SemanticJudge {
  return async (evidence, claim) => {
    const ev = evidence.length > MAX_EVIDENCE ? evidence.slice(-MAX_EVIDENCE) : evidence;
    const system =
      "You are an adversarial verifier. You are told the work is broken; decide if the " +
      "CLAIM is actually satisfied by the EVIDENCE. Default to fail if the evidence does " +
      "not clearly show the claim holds. If the evidence is insufficient to decide, abstain.";
    const prompt =
      `CLAIM (must hold):\n${claim}\n\n` +
      `EVIDENCE (captured output):\n"""\n${ev}\n"""\n\n` +
      `Reply with ONLY compact JSON: {"ruling":"pass"|"fail"|"abstain","symptom":"<short, what's wrong; no fix, no test internals>"}`;
    try {
      const raw = await client.complete({ system, prompt, timeoutMs: 90_000 });
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return { ruling: "abstain", symptom: "judge returned no parseable verdict" };
      const parsed = JSON.parse(m[0]) as { ruling?: unknown; symptom?: unknown };
      if (parsed.ruling !== "pass" && parsed.ruling !== "fail" && parsed.ruling !== "abstain") {
        return { ruling: "abstain", symptom: "judge returned an invalid ruling" };
      }
      return {
        ruling: parsed.ruling,
        ...(typeof parsed.symptom === "string" && parsed.symptom ? { symptom: parsed.symptom } : {}),
      };
    } catch (e) {
      return { ruling: "abstain", symptom: `judge unavailable (${e instanceof Error ? e.message : "error"})` };
    }
  };
}
