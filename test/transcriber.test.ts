import { describe, it, expect, afterEach } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempRepo } from "./helpers.js";
import { seed } from "../src/seed.js";
import { ratchetComplaint, commitRatchet } from "../src/ratchet.js";
import { makeLlmTranscriber } from "../src/transcriber-llm.js";
import { MockLlmClient } from "../src/llm.js";
import { verify } from "../src/verify.js";
import { loadContract, activeGates } from "../src/contract.js";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
});
async function seeded() {
  const { dir, cleanup } = await tempRepo();
  cleanups.push(cleanup);
  await seed(dir, "toy: produce answer.txt"); // MockKnight floor gate
  await writeFile(join(dir, "answer.txt"), "42\n"); // floor gate green
  return dir;
}

// A transcriber that authors a NEW command gate with its own grader script.
const newCommandGate = JSON.stringify({
  kind: "new",
  gate: {
    type: "command",
    run: "sh .ser/gates/nonempty.sh",
    gatePaths: [".ser/gates/nonempty.sh"],
    graderFiles: [{ path: ".ser/gates/nonempty.sh", content: "test -s output.txt\n" }],
  },
  describeBack: "Added: output.txt must be non-empty.",
});

describe("LLM transcriber + grader-bearing ratchet reseal", () => {
  it("writes the grader, reseals, and pristine-verifies the new gate", async () => {
    const dir = await seeded();
    const t = makeLlmTranscriber(new MockLlmClient("claude", () => newCommandGate));
    const r = await ratchetComplaint(dir, "output.txt must not be empty", t);
    expect(r.action).toBe("added");
    expect(r.newGraderPaths).toContain(".ser/gates/nonempty.sh");
    await commitRatchet(dir, r);

    // the new gate is active + its grader is sealed at contractCommit
    const c = await loadContract(dir);
    expect(activeGates(c).some((g) => g.run === "sh .ser/gates/nonempty.sh")).toBe(true);

    // verify now runs the new gate: no output.txt → blocked
    let v = await verify(dir);
    expect(v.blocked).toBe(true); // nonempty gate fails (answer.txt exists, output.txt doesn't)

    // satisfy it → passes
    await writeFile(join(dir, "output.txt"), "x\n");
    v = await verify(dir);
    expect(v.blocked).toBe(false);

    // tamper the new grader to always-pass; pristine committed grader still runs
    await writeFile(join(dir, ".ser/gates/nonempty.sh"), "exit 0\n");
    await writeFile(join(dir, "output.txt"), ""); // make it empty again (broken)
    v = await verify(dir);
    expect(v.blocked).toBe(true); // pristine grader catches it despite the tamper
    expect(v.tamper.some((tf) => tf.path === ".ser/gates/nonempty.sh")).toBe(true);
  });

  it("falls back to a checklist gate when the model returns junk (never drops the correction)", async () => {
    const dir = await seeded();
    const t = makeLlmTranscriber(new MockLlmClient("claude", () => "sure, here's a gate"));
    const before = activeGates(await loadContract(dir)).length;
    const r = await ratchetComplaint(dir, "must handle unicode", t);
    expect(r.action).toBe("added");
    const gates = activeGates(await loadContract(dir));
    expect(gates).toHaveLength(before + 1);
    expect(gates[gates.length - 1]!.checklist).toBe("must handle unicode"); // checklist carries the words
  });

  it("routes a feature request to intake (no gate)", async () => {
    const dir = await seeded();
    const t = makeLlmTranscriber(
      new MockLlmClient("claude", () => JSON.stringify({ kind: "feature", describeBack: "new scope — route to intake" })),
    );
    const before = activeGates(await loadContract(dir)).length;
    const r = await ratchetComplaint(dir, "also add a GUI", t);
    expect(r.action).toBe("routed-to-boundary");
    expect(activeGates(await loadContract(dir))).toHaveLength(before); // no gate added
  });
});
