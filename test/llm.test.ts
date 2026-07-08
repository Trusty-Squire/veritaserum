import { describe, it, expect } from "vitest";
import { selectJudgeVendor, NoJudgeVendorError, MockLlmClient } from "../src/llm.js";

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
