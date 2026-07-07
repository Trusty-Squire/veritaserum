import { describe, it, expect, afterEach } from "vitest";
import { execa } from "execa";
import { resolve } from "node:path";
import { tempRepo, write } from "./helpers.js";
import { seed } from "../src/seed.js";
import { hookStop, hookPrompt } from "../src/hook.js";
import { mockClaimExtractor, mockCorrectionClassifier } from "../src/claim.js";
import { loadContract, activeGates } from "../src/contract.js";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
});
async function seeded(artifact: string | null) {
  const { dir, cleanup } = await tempRepo();
  cleanups.push(cleanup);
  await seed(dir, "toy: produce answer.txt");
  if (artifact !== null) await write(dir, "answer.txt", artifact);
  return dir;
}

describe("claim extraction (DESIGN §6 — honest-incomplete must pass)", () => {
  it("fires on a completion claim", () => {
    expect(mockClaimExtractor("Done — all tests pass.").claimsDone).toBe(true);
    expect(mockClaimExtractor("I've finished the feature.").claimsDone).toBe(true);
  });
  it("does NOT fire on honest incompleteness", () => {
    expect(mockClaimExtractor("Finished step 1, tests are not passing yet.").claimsDone).toBe(false);
    expect(mockClaimExtractor("Still working on it, not done.").claimsDone).toBe(false);
    expect(mockClaimExtractor("Here's my progress so far.").claimsDone).toBe(false);
  });
});

describe("hookStop — block only on a contradicted completion claim", () => {
  it("BLOCKS when the agent claims done but a gate is red", async () => {
    const dir = await seeded(null); // broken build
    const d = await hookStop(dir, "All done, tests pass!");
    expect(d.block).toBe(true);
    expect(d.reason).toMatch(/contract gate/i);
    expect(d.reason).not.toMatch(/answer\.txt.*==|grep -q/); // symptom, not grader internals
  });

  it("ALLOWS honest incompleteness even when gates are red (no trap)", async () => {
    const dir = await seeded(null); // broken build
    const d = await hookStop(dir, "Finished the parser; tests are still failing, more to do.");
    expect(d.block).toBe(false);
    expect(d.claimed).toBe(false);
  });

  it("ALLOWS a completion claim when gates are green", async () => {
    const dir = await seeded("42");
    const d = await hookStop(dir, "Done, everything works.");
    expect(d.block).toBe(false);
    expect(d.claimed).toBe(true);
    expect(d.failed).toBe(0);
  });

  it("does not block when there is no sealed contract", async () => {
    const { dir, cleanup } = await tempRepo();
    cleanups.push(cleanup);
    const d = await hookStop(dir, "Done!");
    expect(d.block).toBe(false);
  });
});

describe("hookPrompt — ratchet a correction to a shipped contract", () => {
  it("ratchets when the message is a correction", async () => {
    const dir = await seeded("42");
    const before = activeGates(await loadContract(dir)).length;
    const r = await hookPrompt(dir, "no, the output is still wrong on empty input", { now: () => "T" });
    expect(r.ratcheted).toBe(true);
    expect(activeGates(await loadContract(dir))).toHaveLength(before + 1);
  });
  it("ignores a plain new request / chatter", async () => {
    const dir = await seeded("42");
    const r = await hookPrompt(dir, "thanks, looks great");
    expect(r.ratcheted).toBe(false);
  });
  it("classifier needs a sealed contract to treat text as a correction", async () => {
    const { dir, cleanup } = await tempRepo();
    cleanups.push(cleanup);
    const c = await loadContract(dir);
    expect(mockCorrectionClassifier("this is wrong", c).isCorrection).toBe(false);
  });
});

describe("CLI hook contract (goose payload shape → block decision on stdout)", () => {
  const CLI = resolve(import.meta.dirname, "../src/cli.ts");
  const RUNNER = resolve(import.meta.dirname, "../node_modules/.bin/tsx");
  async function hook(dir: string, sub: string, payload: object) {
    const r = await execa(RUNNER, [CLI, sub], { cwd: dir, input: JSON.stringify(payload), reject: false });
    return { code: r.exitCode ?? 1, out: r.stdout.trim() };
  }

  it("hook-stop emits {decision:block} on a false done-claim (exit 0, block via stdout)", async () => {
    const dir = await seeded(null);
    const r = await hook(dir, "hook-stop", { event: "Stop", message: "Done, tests pass!", working_dir: dir });
    expect(r.code).toBe(0); // goose reads block from stdout JSON, not exit code
    const parsed = JSON.parse(r.out);
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toMatch(/gate/i);
  });

  it("hook-stop stays silent (allows) on honest incompleteness", async () => {
    const dir = await seeded(null);
    const r = await hook(dir, "hook-stop", { event: "Stop", message: "not done yet", working_dir: dir });
    expect(r.code).toBe(0);
    expect(r.out).toBe(""); // no block payload
  });
});
