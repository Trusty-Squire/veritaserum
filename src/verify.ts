/**
 * THE ONE VERIFICATION (DESIGN §4, §6). Runs the active command gates against
 * reality and blocks on contradiction. R2: graders run from their COMMITTED
 * version (via withPristineGraders), so a tampered grader is inert and flagged.
 * R5: failures carry a redacted symptom, never a raw grader dump.
 *
 * Checklist gates (run === null) are audit items — surfaced, never executed.
 * `level` accepts "fast" | "full"; in P0 all gates are fast (no expensive/semantic
 * gates yet), so full runs the same set. Expensive-gate gating is P1+.
 */
import { activeGates, activeGatePaths, loadContract } from "./contract.js";
import { runGate, type GateResult } from "./gate-run.js";
import { withPristineGraders, type TamperFlag } from "./pristine.js";
import { redactSymptom } from "./symptom.js";
import type { SemanticJudge } from "./judge-verdict.js";

export interface GateOutcome {
  gateId: string;
  provenance: string;
  passed: boolean;
  /** Redacted failure symptom (R5). Present only on failure/abstain. */
  symptom?: string;
  /** Semantic gate the judge declined to rule on → routes to a human. */
  abstained?: boolean;
}

export interface VerifyResult {
  sealed: boolean;
  ran: number;
  passed: number;
  failures: GateOutcome[];
  /** Semantic gates the judge abstained on — human review, not a pass or a block. */
  abstentions: GateOutcome[];
  checklist: { gateId: string; text: string; provenance: string }[];
  tamper: TamperFlag[];
  /** blocked = a claim of "done/pass" would be contradicted by reality. */
  blocked: boolean;
}

export interface VerifyDeps {
  level?: "fast" | "full";
  timeoutMs?: number;
  /** Cross-vendor semantic judge. Absent → semantic gates abstain (route to human). */
  judge?: SemanticJudge;
}

export class NotSealedError extends Error {
  constructor() {
    super("contract is not sealed (no contractCommit) — run `ser seed` first");
    this.name = "NotSealedError";
  }
}

export async function verify(dir: string, deps: VerifyDeps = {}): Promise<VerifyResult> {
  const { timeoutMs, judge } = deps;
  const c = await loadContract(dir);
  if (!c.contractCommit) throw new NotSealedError();
  const commit = c.contractCommit;

  const active = activeGates(c);
  const commandGates = active.filter((g) => g.run !== null);
  const semanticGates = active.filter((g) => g.semantic);
  const checklist = active
    .filter((g) => g.run === null && !g.semantic && g.checklist)
    .map((g) => ({ gateId: g.id, text: g.checklist as string, provenance: g.lineage.provenance }));

  const paths = activeGatePaths(c);

  const { result: outcomes, tamper } = await withPristineGraders(dir, commit, paths, async () => {
    const out: GateOutcome[] = [];
    // Command gates: shell, exit code.
    for (const g of commandGates) {
      const r: GateResult = await runGate(g.run as string, dir, timeoutMs);
      out.push(
        r.passed
          ? { gateId: g.id, provenance: g.lineage.provenance, passed: true }
          : { gateId: g.id, provenance: g.lineage.provenance, passed: false, symptom: redactSymptom(r) },
      );
    }
    // Semantic gates: pristine capture → cross-vendor judge. No judge → abstain.
    for (const g of semanticGates) {
      const spec = g.semantic!;
      const cap = await runGate(spec.capture, dir, timeoutMs);
      const evidence = `${cap.stdoutTail}\n${cap.stderrTail}`.trim();
      if (!judge) {
        out.push({ gateId: g.id, provenance: g.lineage.provenance, passed: false, abstained: true, symptom: "no cross-vendor judge available — routed to human" });
        continue;
      }
      const v = await judge(evidence, spec.claim);
      if (v.ruling === "pass") out.push({ gateId: g.id, provenance: g.lineage.provenance, passed: true });
      else if (v.ruling === "abstain")
        out.push({ gateId: g.id, provenance: g.lineage.provenance, passed: false, abstained: true, symptom: v.symptom ?? "judge abstained" });
      else out.push({ gateId: g.id, provenance: g.lineage.provenance, passed: false, symptom: v.symptom ?? "claim not satisfied" });
    }
    return out;
  });

  const abstentions = outcomes.filter((o) => o.abstained);
  const failures = outcomes.filter((o) => !o.passed && !o.abstained);
  return {
    sealed: true,
    ran: outcomes.length,
    passed: outcomes.filter((o) => o.passed).length,
    failures,
    abstentions,
    checklist,
    tamper,
    // Abstentions do NOT block (they route to a human); only real failures block.
    blocked: failures.length > 0,
  };
}
