import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tempRepo } from "./helpers.js";
import { propose, sealProposal, gradeProposal, ProposeError, MAX_ROUNDS, PROPOSAL_FILENAME, type ProposedGate } from "../src/propose.js";
import { loadContract } from "../src/contract.js";
import { MockLlmClient } from "../src/llm.js";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
  delete process.env.VS_MOCK_KNIGHT;
});

async function repo(): Promise<string> {
  const { dir, cleanup } = await tempRepo();
  cleanups.push(cleanup);
  return dir;
}

const KUHN: ProposedGate = {
  description: "CFR engine hits Kuhn poker's analytic first-player value of -1/18",
  run: "cargo test --release kuhn_anchor",
  gatePaths: [],
  rung: "analytic",
};
const SELFCON: ProposedGate = { description: "my tests pass", run: "true", gatePaths: [], rung: "self-consistency" };

const acceptFirstRejectSecond = new MockLlmClient(
  "codex",
  () =>
    '{"gates":[{"i":0,"verdict":"accepted","rung":"analytic","reason":"known-answer case"},{"i":1,"verdict":"rejected","rung":"self-consistency","reason":"self-graded"}],"demand":""}',
);

describe("contract negotiation (executor proposes, Knight grades, human seals)", () => {
  it("propose: grades gates, writes negotiation state, round 1", async () => {
    const dir = await repo();
    const r = await propose(dir, "build a CFR solver", [KUHN, SELFCON], "claude", acceptFirstRejectSecond);
    expect(r.round).toBe(1);
    expect(r.accepted).toBe(1);
    expect(r.gates[0]!.graded.verdict).toBe("accepted");
    expect(r.gates[1]!.graded.verdict).toBe("rejected");
    expect(existsSync(join(dir, PROPOSAL_FILENAME))).toBe(true);
  });

  it("negotiation is bounded: round MAX_ROUNDS+1 on the same goal throws", async () => {
    const dir = await repo();
    for (let i = 0; i < MAX_ROUNDS; i++) await propose(dir, "same goal", [KUHN], "claude", acceptFirstRejectSecond);
    await expect(propose(dir, "same goal", [KUHN], "claude", acceptFirstRejectSecond)).rejects.toThrow(ProposeError);
  });

  it("a different goal resets the negotiation instead of inheriting rounds", async () => {
    const dir = await repo();
    for (let i = 0; i < MAX_ROUNDS; i++) await propose(dir, "goal A", [KUHN], "claude", acceptFirstRejectSecond);
    const r = await propose(dir, "goal B", [KUHN], "claude", acceptFirstRejectSecond);
    expect(r.round).toBe(1);
  });

  it("seal: accepted gates become the contract, human approval is the provenance, proposal file removed", async () => {
    const dir = await repo();
    await propose(dir, "build a CFR solver", [KUHN, SELFCON], "claude", acceptFirstRejectSecond);
    const sealed = await sealProposal(dir, "yes, the Kuhn anchor is the right gate — ship it");
    expect(sealed.gates).toBe(1);
    expect(sealed.noOracle).toBe(false);
    expect(existsSync(join(dir, PROPOSAL_FILENAME))).toBe(false);

    const c = await loadContract(dir);
    expect(c.contractCommit).not.toBeNull();
    expect(c.gates).toHaveLength(1);
    expect(c.gates[0]!.run).toBe(KUHN.run);
    expect(c.gates[0]!.lineage.provenance).toContain("ship it");
    expect(c.gates[0]!.lineage.source).toBe("user-word");
  });

  it("seal with zero accepted gates records the no-oracle state explicitly", async () => {
    const dir = await repo();
    const rejectAll = new MockLlmClient("codex", () => '{"gates":[{"i":0,"verdict":"rejected","rung":"unverifiable","reason":"no oracle"}],"demand":""}');
    await propose(dir, "vibes-based goal", [{ description: "looks right", gatePaths: [], rung: "unverifiable" }], "claude", rejectAll);
    const sealed = await sealProposal(dir, "acknowledged, no oracle exists");
    expect(sealed.noOracle).toBe(true);
    const c = await loadContract(dir);
    expect(c.gates).toHaveLength(0);
    expect(c.thesis).toContain("no oracle found");
  });

  it("propose after a sealed contract throws (corrections go through ratchet)", async () => {
    const dir = await repo();
    await propose(dir, "g", [KUHN], "claude", acceptFirstRejectSecond);
    await sealProposal(dir, "ok");
    await expect(propose(dir, "g2", [KUHN], "claude", acceptFirstRejectSecond)).rejects.toThrow(/already sealed/);
  });

  it("mechanical fallback (no grader): the ladder decides — binding rungs accepted, lower rungs rejected", async () => {
    process.env.VS_MOCK_KNIGHT = "1";
    const { verdicts } = await gradeProposal("g", [KUHN, SELFCON], "unknown");
    expect(verdicts[0]!.verdict).toBe("accepted");
    expect(verdicts[1]!.verdict).toBe("rejected");
  });

  it("a grader verdict of accepted on a non-binding rung does NOT bind", async () => {
    const sycophant = new MockLlmClient("codex", () => '{"gates":[{"i":0,"verdict":"accepted","rung":"self-consistency","reason":"sure"}],"demand":""}');
    const { verdicts } = await gradeProposal("g", [SELFCON], "claude", sycophant);
    expect(verdicts[0]!.verdict).toBe("rejected");
  });
});

// v3 (SPEC §4): the CLI's `hook-prompt` is now a no-op — there is no prompt-time
// challenge. `CHALLENGE` (src/propose.ts) survives as the text the Knight's
// challenge uses *inside* a live contract_propose/contract_seal negotiation
// (MCP tools), it's just never injected from a hook anymore.
