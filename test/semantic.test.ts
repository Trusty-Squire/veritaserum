import { describe, it, expect, afterEach } from "vitest";
import { tempRepo } from "./helpers.js";
import { seed } from "../src/seed.js";
import { verify } from "../src/verify.js";
import { LlmKnight, KnightError } from "../src/knight-llm.js";
import { makeSemanticJudge } from "../src/judge-verdict.js";
import { MockLlmClient } from "../src/llm.js";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
});

// A Knight (via MockLlmClient) that authors one semantic gate: capture = echo the
// build's status file; claim = the status must say READY.
const semanticKnightJson = JSON.stringify({
  thesis: "ship a thing",
  gates: [
    {
      type: "semantic",
      capture: "cat status.txt 2>/dev/null || echo MISSING",
      claim: "the status output says READY",
      gatePaths: [],
      provenance: "floor: the build must report READY",
      graderFiles: [],
    },
  ],
});

async function seededSemantic() {
  const { dir, cleanup } = await tempRepo();
  cleanups.push(cleanup);
  const knight = new LlmKnight(new MockLlmClient("codex", () => semanticKnightJson));
  await seed(dir, "ship a thing", knight);
  return dir;
}

describe("LlmKnight", () => {
  it("authors gates from valid JSON", async () => {
    const knight = new LlmKnight(
      new MockLlmClient("codex", () =>
        JSON.stringify({
          thesis: "t",
          gates: [
            { type: "command", run: "sh .ser/gates/c.sh", gatePaths: [".ser/gates/c.sh"], provenance: "floor: x", graderFiles: [{ path: ".ser/gates/c.sh", content: "test -f out\n" }] },
          ],
        }),
      ),
    );
    const r = await knight.seed("goal");
    expect(r.gates).toHaveLength(1);
    expect(r.gates[0]!.run).toBe("sh .ser/gates/c.sh");
    expect(r.files[0]!.path).toBe(".ser/gates/c.sh");
  });

  it("throws on non-JSON / invalid output (never a silently-bad contract)", async () => {
    const junk = new LlmKnight(new MockLlmClient("codex", () => "sure! here are some gates"));
    await expect(junk.seed("goal")).rejects.toThrow(KnightError);
    const bad = new LlmKnight(new MockLlmClient("codex", () => '{"thesis":"t","gates":[]}'));
    await expect(bad.seed("goal")).rejects.toThrow(KnightError);
  });
});

describe("semantic gate verify (cross-vendor judge)", () => {
  it("PASSES when the judge rules the claim satisfied", async () => {
    const dir = await seededSemantic();
    const judge = makeSemanticJudge(new MockLlmClient("codex", () => '{"ruling":"pass"}'));
    const r = await verify(dir, { judge });
    expect(r.blocked).toBe(false);
    expect(r.passed).toBe(1);
  });

  it("BLOCKS when the judge rules the claim unmet (with a redacted symptom)", async () => {
    const dir = await seededSemantic();
    const judge = makeSemanticJudge(new MockLlmClient("codex", () => '{"ruling":"fail","symptom":"status said MISSING, not READY"}'));
    const r = await verify(dir, { judge });
    expect(r.blocked).toBe(true);
    expect(r.failures[0]!.symptom).toMatch(/MISSING/);
  });

  it("ABSTAINS (routes to human, does NOT block) when the judge can't decide", async () => {
    const dir = await seededSemantic();
    const judge = makeSemanticJudge(new MockLlmClient("codex", () => '{"ruling":"abstain","symptom":"evidence unclear"}'));
    const r = await verify(dir, { judge });
    expect(r.blocked).toBe(false); // abstain never blocks
    expect(r.abstentions).toHaveLength(1);
    expect(r.passed).toBe(0);
  });

  it("with NO judge, a semantic gate abstains to human (never a silent pass)", async () => {
    const dir = await seededSemantic();
    const r = await verify(dir); // no judge
    expect(r.blocked).toBe(false);
    expect(r.abstentions).toHaveLength(1);
  });
});
