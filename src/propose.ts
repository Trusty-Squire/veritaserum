/**
 * Contract negotiation (executor proposes, Knight grades, human seals).
 * Causality-correct gate authoring: the EXECUTOR generates candidate gates at
 * the Knight's challenge (it has the task context + research tools); a
 * cross-vendor grader scores each gate on the epistemic ladder; the HUMAN's
 * approval sentence seals — the anti-correlated-slop backstop (two agents
 * agreeing on weak gates never binds anything without a human word).
 *
 * Bounded at MAX_ROUNDS — unbounded negotiation is a deadlock with extra steps.
 * "No oracle exists" is a sealable outcome, surfaced instead of silent.
 */
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { contractExists, saveContract } from "./contract.js";
import { commitPaths, ensureRepo } from "./git.js";
import { detectVendors, makeClient, selectJudgeVendor, type LlmClient, type Vendor } from "./llm.js";
import { ContractFileSchema, CONTRACT_FILENAME, type ContractFile } from "./schema.js";

export const MAX_ROUNDS = 3;
export const PROPOSAL_FILENAME = "contract.proposal.json";

/** The epistemic ladder, strongest first. Only the top three rungs can bind. */
export const RUNGS = ["analytic", "oracle", "held-out", "self-consistency", "unverifiable"] as const;
export type Rung = (typeof RUNGS)[number];
const BINDING: ReadonlySet<Rung> = new Set(["analytic", "oracle", "held-out"]);

export const ProposedGateSchema = z
  .object({
    /** What the gate checks, in one sentence. */
    description: z.string().min(1),
    /** Executable check (shell, exit 0 = pass). Omit for checklist-only gates. */
    run: z.string().min(1).optional(),
    /** Grader files the gate depends on (sealed pristine at contract commit). */
    gatePaths: z.array(z.string().min(1)).default([]),
    /** The proposer's claimed rung on the epistemic ladder. */
    rung: z.enum(RUNGS),
  })
  .strict();
export type ProposedGate = z.infer<typeof ProposedGateSchema>;

export interface GateVerdict {
  verdict: "accepted" | "rejected";
  /** The grader's (possibly corrected) rung. */
  rung: Rung;
  reason: string;
}

interface ProposalState {
  goal: string;
  round: number;
  gates: (ProposedGate & { graded: GateVerdict })[];
  demand: string;
}

export class ProposeError extends Error {}

function proposalPath(dir: string): string {
  return join(dir, PROPOSAL_FILENAME);
}

export function proposalExists(dir: string): boolean {
  return existsSync(proposalPath(dir));
}

function loadProposal(dir: string): ProposalState | null {
  if (!proposalExists(dir)) return null;
  try {
    return JSON.parse(readFileSync(proposalPath(dir), "utf8")) as ProposalState;
  } catch {
    return null;
  }
}

// --- grading -----------------------------------------------------------------

/**
 * Deterministic fallback when no cross-vendor grader is available: the ladder
 * itself decides. Predictable and honest about being mechanical.
 */
function gradeByRung(gates: ProposedGate[]): { verdicts: GateVerdict[]; demand: string } {
  return {
    verdicts: gates.map((g) => ({
      verdict: BINDING.has(g.rung) ? ("accepted" as const) : ("rejected" as const),
      rung: g.rung,
      reason: BINDING.has(g.rung)
        ? "rung binds (mechanical grade — no cross-vendor grader available)"
        : `${g.rung} cannot bind: propose a known-answer case, independent oracle, or held-out test`,
    })),
    demand: "",
  };
}

const GRADER_SYSTEM =
  "You are the Knight, grading a proposed verification contract. You have NO stake in the work. " +
  "The proposer is the same agent that will be judged by these gates, so weak gates are self-serving. Be terse and strict.";

function graderPrompt(goal: string, gates: ProposedGate[]): string {
  const listed = gates
    .map((g, i) => `${i}. [claimed ${g.rung}] ${g.description}${g.run ? ` — run: ${g.run}` : " (checklist only)"}`)
    .join("\n");
  return [
    `GOAL:\n"""${goal}"""`,
    "",
    "PROPOSED GATES:",
    listed,
    "",
    "Epistemic ladder, strongest first: analytic (known-answer case with an exact expected value) >",
    "oracle (independent system confirms) > held-out (test the proposer cannot see/overfit) >",
    "self-consistency (the work agreeing with itself, e.g. 'tests pass') > unverifiable.",
    "",
    "Rules:",
    "- Correct the rung when it is inflated; grade on the corrected rung.",
    "- Only analytic | oracle | held-out can bind. Reject self-consistency and unverifiable.",
    "- Reject any gate whose evidence is the proposer's own output or claims (self-graded).",
    "- Reject vacuous gates (would pass on an empty/broken implementation).",
    "- If the domain plausibly has a known-answer case the proposal misses, name it in demand.",
    'Reply ONLY JSON: {"gates":[{"i":0,"verdict":"accepted|rejected","rung":"<corrected rung>","reason":"<one line>"}],"demand":"<one line or empty>"}',
  ].join("\n");
}

/**
 * Grade a proposal. Cross-vendor by the same rule as the sentinel (the proposer
 * must not pick its own examiner). Falls back to the mechanical ladder grade on
 * any infra failure — grading must never wedge the negotiation.
 */
export async function gradeProposal(
  goal: string,
  gates: ProposedGate[],
  executor: Vendor | "unknown",
  clientOverride?: LlmClient,
): Promise<{ verdicts: GateVerdict[]; demand: string }> {
  let client = clientOverride;
  if (!client && !process.env.VS_MOCK_KNIGHT) {
    try {
      client = makeClient(selectJudgeVendor(executor, { available: await detectVendors() }));
    } catch {
      /* fall through to mechanical */
    }
  }
  if (!client) return gradeByRung(gates);

  try {
    const raw = await client.complete({ system: GRADER_SYSTEM, prompt: graderPrompt(goal, gates), timeoutMs: 120_000 });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return gradeByRung(gates);
    const parsed = JSON.parse(m[0]) as { gates?: { i?: number; verdict?: string; rung?: string; reason?: string }[]; demand?: string };
    const verdicts: GateVerdict[] = gates.map((g, i) => {
      const v = parsed.gates?.find((x) => x.i === i);
      const rung = RUNGS.includes(v?.rung as Rung) ? (v!.rung as Rung) : g.rung;
      const accepted = v?.verdict === "accepted" && BINDING.has(rung);
      return {
        verdict: accepted ? "accepted" : "rejected",
        rung,
        reason: v?.reason?.trim() || (accepted ? "accepted" : "rejected by grader"),
      };
    });
    return { verdicts, demand: typeof parsed.demand === "string" ? parsed.demand.trim() : "" };
  } catch {
    return gradeByRung(gates);
  }
}

// --- propose / seal ------------------------------------------------------------

export interface ProposeOutcome {
  round: number;
  roundsLeft: number;
  gates: (ProposedGate & { graded: GateVerdict })[];
  demand: string;
  accepted: number;
}

export async function propose(
  dir: string,
  goal: string,
  gates: ProposedGate[],
  executor: Vendor | "unknown",
  clientOverride?: LlmClient,
): Promise<ProposeOutcome> {
  if (contractExists(dir)) {
    throw new ProposeError("contract.yaml already sealed — corrections go through contract_ratchet/contract_amend");
  }
  const prev = loadProposal(dir);
  // Round tracks the negotiation SESSION for this dir, not exact goal-text equality —
  // an agent that rephrases the goal to fix rejected gates must still converge toward
  // a seal (else it loops on round 1 forever, which crashes real multi-turn runs).
  const round = prev !== null ? prev.round + 1 : 1;
  if (round > MAX_ROUNDS) {
    throw new ProposeError(
      `negotiation rounds exhausted (${MAX_ROUNDS}) — seal the accepted gates with contract_seal, or seal with none to record that no oracle was found`,
    );
  }

  const { verdicts, demand } = await gradeProposal(goal, gates, executor, clientOverride);
  const state: ProposalState = {
    goal,
    round,
    gates: gates.map((g, i) => ({ ...g, graded: verdicts[i]! })),
    demand,
  };
  writeFileSync(proposalPath(dir), JSON.stringify(state, null, 2) + "\n");
  return {
    round,
    roundsLeft: MAX_ROUNDS - round,
    gates: state.gates,
    demand,
    accepted: verdicts.filter((v) => v.verdict === "accepted").length,
  };
}

export interface SealOutcome {
  gates: number;
  contractCommit: string;
  noOracle: boolean;
}

/**
 * Seal the accepted gates. `approval` is the HUMAN's approval sentence, verbatim —
 * it becomes every gate's provenance (source: user-word). Sealing with zero
 * accepted gates is allowed and records the no-oracle state explicitly.
 */
export async function sealProposal(dir: string, approval: string): Promise<SealOutcome> {
  await ensureRepo(dir); // R2 needs git; auto-init a fresh work dir rather than fail on it
  if (contractExists(dir)) throw new ProposeError("contract.yaml already exists — nothing to seal");
  const state = loadProposal(dir);
  if (!state) throw new ProposeError("no proposal to seal — call contract_propose first");

  const accepted = state.gates.filter((g) => g.graded.verdict === "accepted");
  const noOracle = accepted.length === 0;
  const contract: ContractFile = ContractFileSchema.parse({
    thesis: noOracle ? `${state.goal} [no oracle found — completion claims on this goal are unverifiable]` : state.goal,
    contractCommit: null,
    gates: accepted.map((g, i) => ({
      id: `g${i + 1}-proposal`,
      run: g.run ?? null,
      ...(g.run ? {} : { checklist: g.description }),
      gatePaths: g.gatePaths.filter((p) => existsSync(join(dir, p))),
      lineage: {
        pattern: "negotiated-anchor",
        params: { rung: g.graded.rung, description: g.description },
        provenance: approval,
        source: "user-word" as const,
      },
    })),
    repeats: [],
  });
  await saveContract(dir, contract);

  const graderPaths = [...new Set(accepted.flatMap((g) => g.gatePaths))].filter((p) => existsSync(join(dir, p)));
  const sealed = await commitPaths(dir, [CONTRACT_FILENAME, ...graderPaths], `ser: seal negotiated contract for "${state.goal}"`);
  contract.contractCommit = sealed;
  await saveContract(dir, contract);
  await commitPaths(dir, [CONTRACT_FILENAME], "ser: record contractCommit");
  rmSync(proposalPath(dir), { force: true });

  return { gates: accepted.length, contractCommit: sealed, noOracle };
}

// --- the Knight's challenge (injected at prompt time) ---------------------------

export const CHALLENGE = [
  "veritaserum: new goal, no verification contract. Before working, answer the Knight's challenge:",
  "what known-answer case, analytic solution, independent oracle, or held-out test would prove",
  "this work correct independently of your own claims? Research if needed, then submit gates via",
  "the veritaserum MCP tool contract_propose (graded on the ladder: analytic > oracle > held-out >",
  "self-consistency > unverifiable; only the top three bind; max 3 rounds). When the human approves,",
  "seal with contract_seal passing their approval sentence verbatim. If no oracle exists, say so",
  "explicitly and seal with none — unverifiable-but-declared beats silent.",
].join(" ");
