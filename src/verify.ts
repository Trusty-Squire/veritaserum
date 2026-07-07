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

export interface GateOutcome {
  gateId: string;
  provenance: string;
  passed: boolean;
  /** Redacted failure symptom (R5). Present only on failure. */
  symptom?: string;
}

export interface VerifyResult {
  sealed: boolean;
  ran: number;
  passed: number;
  failures: GateOutcome[];
  checklist: { gateId: string; text: string; provenance: string }[];
  tamper: TamperFlag[];
  /** blocked = a claim of "done/pass" would be contradicted by reality. */
  blocked: boolean;
}

export class NotSealedError extends Error {
  constructor() {
    super("contract is not sealed (no contractCommit) — run `ser seed` first");
    this.name = "NotSealedError";
  }
}

export async function verify(
  dir: string,
  _level: "fast" | "full" = "fast",
  timeoutMs?: number,
): Promise<VerifyResult> {
  const c = await loadContract(dir);
  if (!c.contractCommit) throw new NotSealedError();
  const commit = c.contractCommit;

  const active = activeGates(c);
  const commandGates = active.filter((g) => g.run !== null);
  const checklist = active
    .filter((g) => g.run === null && g.checklist)
    .map((g) => ({ gateId: g.id, text: g.checklist as string, provenance: g.lineage.provenance }));

  const paths = activeGatePaths(c);

  const { result: outcomes, tamper } = await withPristineGraders(dir, commit, paths, async () => {
    const out: GateOutcome[] = [];
    for (const g of commandGates) {
      const r: GateResult = await runGate(g.run as string, dir, timeoutMs);
      out.push(
        r.passed
          ? { gateId: g.id, provenance: g.lineage.provenance, passed: true }
          : { gateId: g.id, provenance: g.lineage.provenance, passed: false, symptom: redactSymptom(r) },
      );
    }
    return out;
  });

  const failures = outcomes.filter((o) => !o.passed);
  return {
    sealed: true,
    ran: outcomes.length,
    passed: outcomes.length - failures.length,
    failures,
    checklist,
    tamper,
    blocked: failures.length > 0,
  };
}
