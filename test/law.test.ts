import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { tempRepo } from "./helpers.js";
import { appendDemand, loadLaw, readLawTreeSync, retireLaw, runnableChecks, LAW_FILENAME } from "../src/law.js";
import { saveContract } from "../src/contract.js";
import { ContractFileSchema, type ContractFile } from "../src/schema.js";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
});

async function repo(): Promise<string> {
  const { dir, cleanup } = await tempRepo();
  cleanups.push(cleanup);
  return dir;
}

/** Commit whatever's currently in the tree copy of the law file into HEAD. */
async function commitLaw(dir: string): Promise<void> {
  await execa("git", ["add", "-A"], { cwd: dir });
  await execa("git", ["commit", "-q", "-m", "law"], { cwd: dir });
}

/** A minimal sealed contract.yaml with one active, runnable, user-word gate
 *  (the "statute path", SPEC Appendix) — shaped like propose.ts's sealProposal
 *  output, written + committed directly (no LLM negotiation needed for these tests). */
async function sealStatute(dir: string, run: string, provenance = "the human said so"): Promise<void> {
  const contract: ContractFile = ContractFileSchema.parse({
    thesis: "statute test",
    contractCommit: null,
    gates: [
      {
        id: "g1-proposal",
        run,
        gatePaths: [],
        lineage: { pattern: "negotiated-anchor", params: { rung: "oracle" }, provenance, source: "user-word", retired: false },
      },
    ],
    repeats: [],
  });
  await saveContract(dir, contract);
  await execa("git", ["add", "-A"], { cwd: dir });
  await execa("git", ["commit", "-q", "-m", "seal statute"], { cwd: dir });
}

describe("appendDemand", () => {
  it("adds a fresh runnable demand with rung + binding recorded in lineage", async () => {
    const dir = await repo();
    const out = await appendDemand(dir, { run: "npm test", rung: "oracle", originClaim: "wrote tests, they pass" });
    expect(out.action).toBe("added");
    const law = readLawTreeSync(dir)!;
    expect(law.gates).toHaveLength(1);
    expect(law.gates[0]!.lineage.source).toBe("evaluator-demand");
    expect(law.gates[0]!.lineage.pattern).toBe("evaluator-demand");
    expect(law.gates[0]!.lineage.provenance).toBe("wrote tests, they pass");
    expect(law.gates[0]!.lineage.params.rung).toBe("oracle");
    expect(law.gates[0]!.lineage.params.binding).toBe(true);
    expect(law.gates[0]!.lineage.retired).toBe(false);
  });

  it("dedupes an exact-duplicate run command", async () => {
    const dir = await repo();
    await appendDemand(dir, { run: "npm test", rung: "oracle", originClaim: "first claim" });
    const out = await appendDemand(dir, { run: "npm test", rung: "oracle", originClaim: "second claim" });
    expect(out.action).toBe("duplicate");
    expect(readLawTreeSync(dir)!.gates).toHaveLength(1);
  });

  it("dedupes a normalized command variant (extra/collapsed whitespace)", async () => {
    const dir = await repo();
    await appendDemand(dir, { run: "  npm   test  ", rung: "oracle", originClaim: "a" });
    const out = await appendDemand(dir, { run: "npm test", rung: "held-out", originClaim: "b" });
    expect(out.action).toBe("duplicate");
    expect(readLawTreeSync(dir)!.gates).toHaveLength(1);
  });

  it("dedupes a named (checklist) expectation by slug equality, ignoring punctuation/case", async () => {
    const dir = await repo();
    await appendDemand(dir, {
      checklist: "Kuhn anchor: MCCFR converges to known equilibrium",
      rung: "oracle",
      originClaim: "a",
    });
    const out = await appendDemand(dir, {
      checklist: "kuhn anchor -- mccfr converges to known equilibrium!!",
      rung: "held-out",
      originClaim: "b",
    });
    expect(out.action).toBe("duplicate");
    expect(readLawTreeSync(dir)!.gates).toHaveLength(1);
  });

  it("does not dedupe genuinely different demands", async () => {
    const dir = await repo();
    await appendDemand(dir, { run: "npm test", rung: "oracle", originClaim: "a" });
    const out = await appendDemand(dir, { run: "npm run lint", rung: "oracle", originClaim: "b" });
    expect(out.action).toBe("added");
    expect(readLawTreeSync(dir)!.gates).toHaveLength(2);
  });

  it("records low-rung demands as recorded-never-binding; runnableChecks skips them", async () => {
    const dir = await repo();
    await appendDemand(dir, { run: "echo ok", rung: "self-consistency", originClaim: "claims it works" });
    const law = readLawTreeSync(dir)!;
    expect(law.gates[0]!.lineage.params.binding).toBe(false);
    expect(runnableChecks(law)).toHaveLength(0);
  });

  it("rejects a demand with neither run nor checklist", async () => {
    const dir = await repo();
    await expect(appendDemand(dir, { rung: "oracle", originClaim: "x" })).rejects.toThrow();
  });

  it("atomic append under concurrent calls: 10 unique demands land intact, valid YAML, no dupes", async () => {
    const dir = await repo();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        appendDemand(dir, { run: `cmd-${i}`, rung: "oracle", originClaim: `claim ${i}` }),
      ),
    );
    // readLawTreeSync round-trips through the YAML parser + zod schema — a
    // corrupted/half-written file would throw here.
    const law = readLawTreeSync(dir)!;
    expect(law.gates).toHaveLength(10);
    expect(new Set(law.gates.map((g) => g.id)).size).toBe(10);
    expect(new Set(law.gates.map((g) => g.run)).size).toBe(10);
  });

  it("concurrent identical demands collapse to exactly one added entry", async () => {
    const dir = await repo();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => appendDemand(dir, { run: "npm test", rung: "oracle", originClaim: "same" })),
    );
    expect(results.filter((r) => r.action === "added")).toHaveLength(1);
    expect(results.filter((r) => r.action === "duplicate")).toHaveLength(9);
    expect(readLawTreeSync(dir)!.gates).toHaveLength(1);
  });
});

describe("retireLaw", () => {
  it("marks retired + retiredBy; runnableChecks never returns it again", async () => {
    const dir = await repo();
    await appendDemand(dir, { run: "npm test", rung: "oracle", originClaim: "x" });
    const before = readLawTreeSync(dir)!;
    const id = before.gates[0]!.id;
    expect(runnableChecks(before)).toHaveLength(1);

    const ok = await retireLaw(dir, id, "superseded by held-out suite");
    expect(ok).toBe(true);

    const after = readLawTreeSync(dir)!;
    expect(after.gates[0]!.lineage.retired).toBe(true);
    expect(after.gates[0]!.retiredBy).toBe("superseded by held-out suite");
    expect(runnableChecks(after)).toHaveLength(0);
    // recorded, never deleted
    expect(after.gates).toHaveLength(1);
  });

  it("returns false for an unknown id and for an already-retired id", async () => {
    const dir = await repo();
    await appendDemand(dir, { run: "npm test", rung: "oracle", originClaim: "x" });
    const id = readLawTreeSync(dir)!.gates[0]!.id;
    expect(await retireLaw(dir, "not-a-real-id", "why")).toBe(false);
    expect(await retireLaw(dir, id, "first reason")).toBe(true);
    expect(await retireLaw(dir, id, "second reason")).toBe(false);
    expect(readLawTreeSync(dir)!.gates[0]!.retiredBy).toBe("first reason");
  });
});

describe("loadLaw — reads HEAD, classifies tree drift", () => {
  it("drift=none when no law file exists anywhere", async () => {
    const dir = await repo();
    const { law, drift } = await loadLaw(dir);
    expect(drift).toBe("none");
    expect(law.gates).toHaveLength(0);
  });

  it("drift=none when the tree copy matches committed HEAD", async () => {
    const dir = await repo();
    await appendDemand(dir, { run: "npm test", rung: "oracle", originClaim: "x" });
    await commitLaw(dir);
    const { drift } = await loadLaw(dir);
    expect(drift).toBe("none");
  });

  it("drift=pending-canon when HEAD has never seen a law file but the tree has one", async () => {
    const dir = await repo();
    await appendDemand(dir, { run: "npm test", rung: "oracle", originClaim: "x" });
    // deliberately not committed
    const { law, drift } = await loadLaw(dir);
    expect(drift).toBe("pending-canon");
    expect(law.gates).toHaveLength(1);
  });

  it("drift=tree-modified when HEAD has law and the tree copy was edited afterward", async () => {
    const dir = await repo();
    await appendDemand(dir, { run: "npm test", rung: "oracle", originClaim: "x" });
    await commitLaw(dir);
    await appendDemand(dir, { run: "npm run lint", rung: "oracle", originClaim: "y" }); // uncommitted
    const { law, drift } = await loadLaw(dir);
    expect(drift).toBe("tree-modified");
    // reads HEAD, not the tree — the second (uncommitted) demand is absent here.
    expect(law.gates).toHaveLength(1);
  });

  it("drift=tree-deleted when HEAD has law and the tree copy was removed", async () => {
    const dir = await repo();
    await appendDemand(dir, { run: "npm test", rung: "oracle", originClaim: "x" });
    await commitLaw(dir);
    await rm(join(dir, LAW_FILENAME));
    const { law, drift } = await loadLaw(dir);
    expect(drift).toBe("tree-deleted");
    expect(law.gates).toHaveLength(1); // still reads HEAD
  });
});

describe("loadLaw — statute union (SPEC Appendix 'optional statute path')", () => {
  it("a sealed contract.yaml gate appears in the loadLaw union and in runnableChecks", async () => {
    const dir = await repo();
    await sealStatute(dir, "npm run statute-check");
    const { law } = await loadLaw(dir);
    const statuteGate = law.gates.find((g) => g.id === "g1-proposal");
    expect(statuteGate).toBeDefined();
    expect(statuteGate!.lineage.source).toBe("user-word"); // tagged by its existing lineage, not retagged
    expect(runnableChecks(law).map((g) => g.id)).toContain("g1-proposal");
  });

  it("a law-file evaluator-demand and a sealed contract gate coexist in the same union", async () => {
    const dir = await repo();
    await appendDemand(dir, { run: "npm test", rung: "oracle", originClaim: "wrote tests" });
    await commitLaw(dir);
    await sealStatute(dir, "npm run statute-check");

    const { law } = await loadLaw(dir);
    const ids = law.gates.map((g) => g.id);
    expect(ids.some((id) => id.startsWith("law"))).toBe(true);
    expect(ids).toContain("g1-proposal");
    const runnableIds = runnableChecks(law).map((g) => g.id);
    expect(runnableIds.length).toBe(2);
  });

  it("a RETIRED contract gate is excluded from the union (statute retirement mirrors law retirement)", async () => {
    const dir = await repo();
    const retired: ContractFile = ContractFileSchema.parse({
      thesis: "retired statute",
      contractCommit: null,
      gates: [
        {
          id: "g1-proposal",
          run: "npm run statute-check",
          gatePaths: [],
          lineage: { pattern: "negotiated-anchor", params: { rung: "oracle" }, provenance: "human said so", source: "user-word", retired: true },
          retiredBy: "superseded",
        },
      ],
      repeats: [],
    });
    await saveContract(dir, retired);
    await execa("git", ["add", "-A"], { cwd: dir });
    await execa("git", ["commit", "-q", "-m", "seal retired statute"], { cwd: dir });

    const { law } = await loadLaw(dir);
    expect(law.gates.find((g) => g.id === "g1-proposal")).toBeUndefined();
  });

  it("drift is classified independently per source: contract.yaml drifts while law.yaml does not", async () => {
    const dir = await repo();
    await appendDemand(dir, { run: "npm test", rung: "oracle", originClaim: "x" });
    await commitLaw(dir); // law.yaml committed, tree matches HEAD
    await sealStatute(dir, "npm run statute-check"); // contract.yaml committed too
    await saveContract(
      dir,
      ContractFileSchema.parse({
        thesis: "statute test",
        contractCommit: null,
        gates: [
          {
            id: "g1-proposal",
            run: "npm run statute-check-edited",
            gatePaths: [],
            lineage: { pattern: "negotiated-anchor", params: { rung: "oracle" }, provenance: "the human said so", source: "user-word", retired: false },
          },
        ],
        repeats: [],
      }),
    ); // uncommitted edit to contract.yaml's tree copy — executor/human drift

    const { drift, contractDrift } = await loadLaw(dir);
    expect(drift).toBe("none");
    expect(contractDrift).toBe("tree-modified");
  });

  it("drift is classified independently per source: law.yaml drifts while contract.yaml does not", async () => {
    const dir = await repo();
    await sealStatute(dir, "npm run statute-check"); // contract.yaml committed, tree matches HEAD
    await appendDemand(dir, { run: "npm test", rung: "oracle", originClaim: "x" });
    await commitLaw(dir);
    await appendDemand(dir, { run: "npm run lint", rung: "oracle", originClaim: "y" }); // uncommitted law.yaml edit

    const { drift, contractDrift } = await loadLaw(dir);
    expect(drift).toBe("tree-modified");
    expect(contractDrift).toBe("none");
  });

  it("no contract.yaml anywhere: contractDrift=none, union contributes nothing", async () => {
    const dir = await repo();
    await appendDemand(dir, { run: "npm test", rung: "oracle", originClaim: "x" });
    await commitLaw(dir);
    const { law, contractDrift } = await loadLaw(dir);
    expect(contractDrift).toBe("none");
    expect(law.gates).toHaveLength(1);
  });
});
