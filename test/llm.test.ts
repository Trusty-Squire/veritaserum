import { describe, it, expect } from "vitest";
import { selectJudgeVendor, NoJudgeVendorError, MockLlmClient } from "../src/llm.js";
import { makeLlmClaimExtractor } from "../src/claim.js";

describe("cross-vendor judge selection (owner policy)", () => {
  it("picks codex when executor≠codex and codex is available", () => {
    const s = selectJudgeVendor("claude", { available: ["codex", "claude"] });
    expect(s.vendor).toBe("codex");
    expect(s.metered).toBe(false);
  });
  it("picks claude when executor is codex (codex would be same-vendor)", () => {
    const s = selectJudgeVendor("codex", { available: ["codex", "claude"] });
    expect(s.vendor).toBe("claude");
  });
  it("a goose/qwen executor gets codex (codex preferred over claude)", () => {
    expect(selectJudgeVendor("unknown", { available: ["codex", "claude"] }).vendor).toBe("codex");
  });
  it("falls to the only available cross-vendor subscription", () => {
    expect(selectJudgeVendor("codex", { available: ["claude"] }).vendor).toBe("claude");
    expect(selectJudgeVendor("claude", { available: ["codex"] }).vendor).toBe("codex");
  });
  it("uses OpenRouter (metered) ONLY when no cross-vendor local sub AND a model is given", () => {
    const s = selectJudgeVendor("claude", { available: ["claude"], openrouterModel: "x/y" });
    expect(s.vendor).toBe("openrouter");
    expect(s.metered).toBe(true);
  });
  it("throws when no cross-vendor judge and no OpenRouter model", () => {
    expect(() => selectJudgeVendor("claude", { available: ["claude"] })).toThrow(NoJudgeVendorError);
    expect(() => selectJudgeVendor("codex", { available: [] })).toThrow(NoJudgeVendorError);
  });
});

describe("LLM claim extractor (fails safe to heuristic)", () => {
  const done = new MockLlmClient("codex", () => '{"claimsDone": true, "evidence": "shipped"}');
  const notDone = new MockLlmClient("codex", () => '{"claimsDone": false, "evidence": ""}');
  const garbage = new MockLlmClient("codex", () => "the model rambled without JSON");

  it("returns claimsDone from valid JSON", async () => {
    expect((await makeLlmClaimExtractor(done)("we shipped it")).claimsDone).toBe(true);
    expect((await makeLlmClaimExtractor(notDone)("still going")).claimsDone).toBe(false);
  });
  it("falls back to the heuristic on non-JSON output", async () => {
    // heuristic reads the message itself: a clear done-claim → true
    expect((await makeLlmClaimExtractor(garbage)("Done, all tests pass.")).claimsDone).toBe(true);
    expect((await makeLlmClaimExtractor(garbage)("not done yet")).claimsDone).toBe(false);
  });
  it("empty message is never a claim", async () => {
    expect((await makeLlmClaimExtractor(done)("")).claimsDone).toBe(false);
  });
});
