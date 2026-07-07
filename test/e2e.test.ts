import { describe, it, expect, afterEach } from "vitest";
import { tempRepo, write } from "./helpers.js";
import { seed } from "../src/seed.js";
import { verify } from "../src/verify.js";
import { ratchetComplaint, retireByProvenance } from "../src/ratchet.js";
import { mockTranscriber } from "../src/judge.js";
import { loadContract, activeGates } from "../src/contract.js";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
});

async function seeded(artifactValue: string | null) {
  const { dir, cleanup } = await tempRepo();
  cleanups.push(cleanup);
  await seed(dir, "toy: produce answer.txt");
  if (artifactValue !== null) await write(dir, "answer.txt", artifactValue);
  return dir;
}

describe("seed → verify", () => {
  it("seeds a sealed contract with a floor gate + grader", async () => {
    const dir = await seeded("42");
    const c = await loadContract(dir);
    expect(c.contractCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(activeGates(c)).toHaveLength(1);
    expect(activeGates(c)[0]!.gatePaths).toContain(".veritaserum/gates/floor.sh");
  });

  it("verify passes when the output artifact exists", async () => {
    const dir = await seeded("42");
    const r = await verify(dir);
    expect(r.blocked).toBe(false);
    expect(r.passed).toBe(1);
  });

  it("verify BLOCKS when the artifact is missing (false 'done' would be caught)", async () => {
    const dir = await seeded(null); // no answer.txt
    const r = await verify(dir);
    expect(r.blocked).toBe(true);
    expect(r.failures[0]!.symptom).toBeTruthy();
  });

  it("tampering the grader to always-pass does NOT let a broken build pass", async () => {
    const dir = await seeded(null); // broken: no artifact
    await write(dir, ".veritaserum/gates/floor.sh", "exit 0\n"); // tamper: soften grader
    const r = await verify(dir);
    expect(r.blocked).toBe(true); // pristine grader still fails
    expect(r.tamper.map((t) => t.kind)).toContain("edited");
  });

  it("refuses to re-seed an existing contract", async () => {
    const dir = await seeded("42");
    await expect(seed(dir, "again")).rejects.toThrow(/already exists/);
  });
});

describe("ratchet + amend", () => {
  it("ratchet appends a checklist gate (monotonic)", async () => {
    const dir = await seeded("42");
    const before = activeGates(await loadContract(dir)).length;
    const r = await ratchetComplaint(dir, "answers must never be empty", mockTranscriber, () => "T");
    expect(r.action).toBe("added");
    expect(activeGates(await loadContract(dir))).toHaveLength(before + 1);
  });

  it("a repeated complaint records a repeat, not a second gate (the metric)", async () => {
    const dir = await seeded("42");
    await ratchetComplaint(dir, "answers must never be empty", mockTranscriber, () => "T");
    const n1 = activeGates(await loadContract(dir)).length;
    const r = await ratchetComplaint(dir, "answers must never be empty", mockTranscriber, () => "T");
    expect(r.action).toBe("repeat-recorded");
    const c = await loadContract(dir);
    expect(activeGates(c)).toHaveLength(n1); // no second gate
    expect(c.repeats).toHaveLength(1);
  });

  it("amend --retire marks a gate retired (recorded, not deleted)", async () => {
    const dir = await seeded("42");
    const retired = await retireByProvenance(dir, "floor: the build must produce", "scope change");
    expect(retired).toHaveLength(1);
    const c = await loadContract(dir);
    expect(activeGates(c)).toHaveLength(0); // no active gates
    expect(c.gates).toHaveLength(1); // but history preserved
    expect(c.gates[0]!.lineage.retired).toBe(true);
    expect(c.gates[0]!.retiredBy).toBe("scope change");
  });
});
