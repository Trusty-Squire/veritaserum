/**
 * The thin-judge seam (DESIGN §2, §3). Everything interpretive is behind an
 * interface; P0 ships deterministic mocks so nothing touches the network. The
 * real LLM-backed Knight/Transcriber drop in at P2 without changing callers.
 *
 * Where proj-cs ser used regex to interpret natural language, that logic lives
 * ONLY behind these seams now — the mechanics (contract, ratchet, pristine,
 * verify) never parse prose.
 */
import type { ContractFile, GateLineage } from "./schema.js";

/** A constructed, not-yet-persisted gate: one pattern application. */
export interface GateInstance {
  /** Rendered shell command (exit 0 = pass), or null for a human checklist item. */
  run: string | null;
  /** Human checklist text (only when run === null). */
  checklist?: string;
  /** R2 grader files this gate depends on. */
  gatePaths: string[];
  lineage: GateLineage;
}

/** A grader file the Knight emits alongside a gate (path relative to repo root). */
export interface EmittedFile {
  path: string;
  content: string;
}

export interface SeedResult {
  thesis: string;
  gates: GateInstance[];
  files: EmittedFile[];
}

/** design-time: goal -> contract. Tool-rich LLM in prod; deterministic mock in P0. */
export interface Knight {
  seed(goal: string): Promise<SeedResult>;
}

/**
 * verify-time complaint routing (the ratchet's brain). LLM in prod; mock in P0.
 * `kind` routes the complaint; only `new` adds a gate.
 */
export interface ComplaintTranscription {
  kind: "new" | "duplicate" | "contradicts" | "feature";
  instance?: GateInstance;
  describeBack: string;
  contradictsGateId?: string;
  duplicateOfGateId?: string;
}
export type ComplaintTranscriber = (complaint: string, contract: ContractFile) => Promise<ComplaintTranscription>;

// ---------------------------------------------------------------------------
// P0 deterministic mocks (no network)
// ---------------------------------------------------------------------------

/**
 * MockKnight: emits one floor gate — "the build produced its declared output" —
 * with a real committed grader script, so R2 (pristine-git) is exercisable end
 * to end. The real Knight designs oracles from the goal; this is a stand-in.
 */
export class MockKnight implements Knight {
  constructor(private readonly artifact = "answer.txt") {}

  async seed(goal: string): Promise<SeedResult> {
    const graderPath = ".ser/gates/floor.sh";
    const grader = [
      "#!/usr/bin/env sh",
      "# floor gate (MockKnight): the build must produce a non-empty output artifact.",
      `test -s "${this.artifact}"`,
      "",
    ].join("\n");
    return {
      thesis: goal,
      gates: [
        {
          run: `sh ${graderPath}`,
          gatePaths: [graderPath],
          lineage: {
            pattern: "command",
            params: { artifact: this.artifact },
            provenance: `floor: the build must produce ${this.artifact} (${goal})`,
            source: "floor",
            retired: false,
          },
        },
      ],
      files: [{ path: graderPath, content: grader }],
    };
  }
}

/**
 * MockTranscriber: without an LLM it cannot synthesize a command gate from prose,
 * so a complaint becomes a human-checklist gate carrying the user's exact words
 * (honest P0 behavior — the real transcriber constructs command gates). Dedupe is
 * exact-text over active checklist gates; a match records a repeat, never a twin.
 */
export const mockTranscriber: ComplaintTranscriber = async (complaint, contract) => {
  const norm = complaint.replace(/\s+/g, " ").trim().toLowerCase();
  const twin = contract.gates.find(
    (g) => !g.lineage.retired && (g.checklist ?? "").replace(/\s+/g, " ").trim().toLowerCase() === norm,
  );
  if (twin) {
    return { kind: "duplicate", duplicateOfGateId: twin.id, describeBack: `Already covered by ${twin.id}.` };
  }
  return {
    kind: "new",
    instance: {
      run: null,
      checklist: complaint,
      gatePaths: [],
      lineage: { pattern: "checklist", params: {}, provenance: complaint, source: "user-word", retired: false },
    },
    describeBack: `Recorded as a checklist gate: "${complaint}"`,
  };
};
