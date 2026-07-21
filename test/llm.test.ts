import { describe, it, expect, afterEach } from "vitest";
import { selectJudgeVendor, NoJudgeVendorError, MockLlmClient, OllamaClient } from "../src/llm.js";

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

/**
 * FIX (2026-07-20): the auditor's only src/ consumer of OllamaClient always expects a strict-JSON
 * verdict, and prod telemetry showed 11 parse failures clustered on turns whose final message was
 * itself JSON/code-fenced (the model derailed its output format). Sending `format:"json"` to
 * ollama's /api/chat constrains decoding to valid JSON so the model can't emit prose/fences.
 */
describe("OllamaClient — forces JSON-constrained decoding", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("sends format:'json' in the /api/chat request body", async () => {
    let capturedBody: unknown;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ message: { content: '{"claims":[]}' } }) };
    }) as unknown as typeof fetch;

    const out = await new OllamaClient("qwen2.5:14b").complete({ prompt: "audit this" });
    expect(out).toBe('{"claims":[]}');
    expect((capturedBody as { format?: string }).format).toBe("json");
  });
});
