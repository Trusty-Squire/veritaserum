/**
 * THE RATCHET (append-only, monotonic) and THE CLUTCH (amend --retire, the only
 * weakening path). Ported from proj-cs contract-file.ts. Transcription is behind
 * the injected seam (judge.ts); this module is pure mechanics: dedupe,
 * contradiction surfacing, retirement, the repeat metric.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { activeGates, loadContract, nextGateId, saveContract } from "./contract.js";
import { commitPaths } from "./git.js";
import type { ComplaintTranscriber } from "./judge.js";
import { CONTRACT_FILENAME, type ContractGate } from "./schema.js";

function normalize(run: string | null): string {
  return (run ?? "").replace(/\s+/g, " ").trim();
}

export interface RatchetOutcome {
  action: "added" | "repeat-recorded" | "conflict-surfaced" | "routed-to-boundary";
  gateId?: string;
  describeBack: string;
  /** conflict-surfaced: the user must choose retire-old vs drop-new; nothing is silently picked. */
  conflictWith?: ContractGate;
  /** Grader files written for the new gate; the caller must reseal contractCommit. */
  newGraderPaths?: string[];
}

/**
 * Apply one complaint to the contract:
 *  - new        → permanent first-class gate
 *  - duplicate  → recorded as a REPEAT (the metric event), no second gate
 *  - contradicts→ SURFACED (never silently picked; caller runs the clutch)
 *  - feature    → routed to the boundary/intake, not the ratchet
 * `at` is injected (tests pass a fixed clock) so the module has no hidden time dep.
 */
export async function ratchetComplaint(
  dir: string,
  complaint: string,
  transcribe: ComplaintTranscriber,
  now: () => string = () => new Date().toISOString(),
): Promise<RatchetOutcome> {
  const c = await loadContract(dir);
  const t = await transcribe(complaint, c);

  if (t.kind === "feature") {
    return { action: "routed-to-boundary", describeBack: t.describeBack };
  }
  if (t.kind === "contradicts") {
    const target = activeGates(c).find((g) => g.id === t.contradictsGateId);
    if (!target) throw new Error(`transcriber flagged contradiction with unknown gate "${t.contradictsGateId}"`);
    return { action: "conflict-surfaced", describeBack: t.describeBack, conflictWith: target };
  }

  if (t.kind === "duplicate" && !t.instance) {
    const gateId = t.duplicateOfGateId ?? "unknown";
    c.repeats.push({ gateId, complaint, at: now() });
    await saveContract(dir, c);
    return { action: "repeat-recorded", gateId, describeBack: t.describeBack };
  }
  if (!t.instance) throw new Error(`transcription kind "${t.kind}" requires a constructed instance`);

  const rendered = normalize(t.instance.run);
  const twin = activeGates(c).find((g) => normalize(g.run) === rendered && rendered !== "");
  if (t.kind === "duplicate" || twin) {
    const gateId = twin?.id ?? t.duplicateOfGateId ?? "unknown";
    c.repeats.push({ gateId, complaint, at: now() });
    await saveContract(dir, c);
    return { action: "repeat-recorded", gateId, describeBack: t.describeBack };
  }

  // Write any grader files the new gate depends on (caller reseals contractCommit).
  const newGraderPaths: string[] = [];
  for (const f of t.files ?? []) {
    const abs = join(dir, f.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, f.content, "utf8");
    newGraderPaths.push(f.path);
  }

  const gate: ContractGate = {
    id: nextGateId(c),
    run: t.instance.run,
    ...(t.instance.semantic ? { semantic: t.instance.semantic } : {}),
    ...(t.instance.checklist ? { checklist: t.instance.checklist } : {}),
    gatePaths: t.instance.gatePaths,
    lineage: t.instance.lineage,
  };
  c.gates.push(gate);
  await saveContract(dir, c);
  return {
    action: "added",
    gateId: gate.id,
    describeBack: t.describeBack,
    ...(newGraderPaths.length ? { newGraderPaths } : {}),
  };
}

/**
 * Persist a ratchet outcome to git. Commits contract.yaml (+ any new grader files);
 * when the new gate brought grader files, re-seals contractCommit to that commit so
 * pristine verify (R2) reads the freshly-sealed graders.
 */
export async function commitRatchet(dir: string, outcome: RatchetOutcome): Promise<void> {
  const graders = outcome.newGraderPaths ?? [];
  const sha = await commitPaths(dir, [CONTRACT_FILENAME, ...graders], `ser: ratchet — ${outcome.gateId ?? outcome.action}`);
  if (graders.length) {
    const c = await loadContract(dir);
    c.contractCommit = sha;
    await saveContract(dir, c);
    await commitPaths(dir, [CONTRACT_FILENAME], "ser: reseal after ratchet");
  }
}

/**
 * THE CLUTCH (amend --retire). Retire active gates whose provenance matches a
 * superseded intent — marked, never deleted; the suite skips them; history stays
 * auditable. Human-confirmed at the CLI. Returns retired ids.
 */
export async function retireByProvenance(dir: string, provenanceMatch: string, supersededBy: string): Promise<string[]> {
  const c = await loadContract(dir);
  const retired: string[] = [];
  const needle = provenanceMatch.toLowerCase();
  for (const g of c.gates) {
    if (!g.lineage.retired && g.lineage.provenance.toLowerCase().includes(needle)) {
      g.lineage.retired = true;
      g.retiredBy = supersededBy;
      retired.push(g.id);
    }
  }
  await saveContract(dir, c);
  return retired;
}
