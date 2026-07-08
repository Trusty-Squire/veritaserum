import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAuditor, doctorReport, executorFamily } from "../src/resolve.js";

// Hermetic: this sandbox has REAL codex/claude CLIs on the ambient PATH (used by
// eval/ scripts), so every test pins PATH to a fresh shim dir + the bare minimum
// system dirs `sh`/`command` need, and points the 24h doctor cache at a fresh temp
// file — never the real ~/.veritaserum/doctor.json, never the real CLIs.

const ENV_KEYS = ["PATH", "VS_DOCTOR_CACHE_PATH", "VS_AUDITOR", "VS_AUDITOR_METERED", "OPENROUTER_API_KEY"] as const;
let saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
let shimDir: string;
let cacheDir: string;

beforeEach(async () => {
  shimDir = await mkdtemp(join(tmpdir(), "vs-shim-"));
  cacheDir = await mkdtemp(join(tmpdir(), "vs-doctor-cache-"));
  saved = {};
  for (const k of ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) saved[k] = v;
  }
  process.env.PATH = `${shimDir}:/usr/bin:/bin`;
  process.env.VS_DOCTOR_CACHE_PATH = join(cacheDir, "doctor.json");
  delete process.env.VS_AUDITOR;
  delete process.env.VS_AUDITOR_METERED;
  delete process.env.OPENROUTER_API_KEY;
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(shimDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
});

/** A fake CLI on PATH: any args, prints "ok", exits 0 — enough to pass the 1-token smoke call. */
async function shim(name: "codex" | "claude"): Promise<void> {
  const p = join(shimDir, name);
  await writeFile(p, "#!/bin/sh\necho ok\nexit 0\n", "utf8");
  await chmod(p, 0o755);
}

describe("executorFamily", () => {
  it("classifies codex/openai/gpt-* as openai-family", () => {
    expect(executorFamily("codex")).toBe("openai");
    expect(executorFamily("openai")).toBe("openai");
    expect(executorFamily("openai:gpt-4o")).toBe("openai");
    expect(executorFamily("gpt-4")).toBe("openai");
  });
  it("classifies claude as claude-family", () => {
    expect(executorFamily("claude")).toBe("claude");
    expect(executorFamily("claude:sonnet")).toBe("claude");
  });
  it("classifies anything else (ollama, goose, unknown) as other", () => {
    expect(executorFamily("ollama:qwen2.5:3b")).toBe("other");
    expect(executorFamily("unknown")).toBe("other");
  });
});

describe("resolveAuditor — the five rules (SPEC §2 'Auditor resolution')", () => {
  it("rule1: codex available, executor family≠openai → codex (agentic, not same-family)", async () => {
    await shim("codex");
    const a = await resolveAuditor("claude");
    expect(a.tier).toBe("agentic");
    expect(a.vendor).toBe("codex");
    expect(a.sameFamily).toBe(false);
  });

  it("rule2: claude available, executor family≠claude → claude (agentic, not same-family)", async () => {
    await shim("claude");
    const a = await resolveAuditor("codex");
    expect(a.tier).toBe("agentic");
    expect(a.vendor).toBe("claude");
    expect(a.sameFamily).toBe(false);
  });

  it("rule2 also fires for a goose/ollama executor (family 'other' ≠ claude)", async () => {
    await shim("claude");
    const a = await resolveAuditor("ollama:qwen2.5:3b");
    expect(a.vendor).toBe("claude");
    expect(a.sameFamily).toBe(false);
  });

  it("rule3: only codex available AND the executor is openai-family → codex WITH a same-family warning", async () => {
    await shim("codex");
    const a = await resolveAuditor("codex");
    expect(a.tier).toBe("agentic");
    expect(a.vendor).toBe("codex");
    expect(a.sameFamily).toBe(true);
  });

  it("rule4: only claude available AND the executor is claude-family → claude WITH a same-family warning", async () => {
    await shim("claude");
    const a = await resolveAuditor("claude");
    expect(a.tier).toBe("agentic");
    expect(a.vendor).toBe("claude");
    expect(a.sameFamily).toBe(true);
  });

  it("rule5: no agentic CLI, OPENROUTER_API_KEY set → metered default glm-4.2 (pre-gathered)", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test-key";
    const a = await resolveAuditor("ollama:qwen2.5:3b");
    expect(a.tier).toBe("pre-gathered");
    expect(a.vendor).toBe("openrouter");
    expect(a.model).toBe("glm-4.2");
    expect(a.sameFamily).toBe(false);
  });

  it("rule5: a user-configured metered choice (VS_AUDITOR_METERED) wins over the glm-4.2 default", async () => {
    process.env.VS_AUDITOR_METERED = "ollama:llama3.2:1b";
    const a = await resolveAuditor("ollama:qwen2.5:3b");
    expect(a.tier).toBe("pre-gathered");
    expect(a.vendor).toBe("ollama");
    expect(a.model).toBe("llama3.2:1b");
  });

  it("floor: nothing available (no CLI, no metered key/choice) → tier absent, mechanical checks are the caller's job (R8)", async () => {
    const a = await resolveAuditor("codex");
    expect(a.tier).toBe("absent");
    expect(a.vendor).toBe("none");
    await expect(a.invoke("x", "/tmp")).rejects.toThrow();
  });
});

describe("VS_AUDITOR override — wins over every rule", () => {
  it("overrides rule1 even when codex+claude are both available", async () => {
    await shim("codex");
    await shim("claude");
    process.env.VS_AUDITOR = "ollama:qwen2.5:3b";
    const a = await resolveAuditor("claude");
    expect(a.tier).toBe("pre-gathered");
    expect(a.vendor).toBe("ollama");
    expect(a.model).toBe("qwen2.5:3b");
  });

  it("accepts a bare vendor with no model (e.g. 'claude')", async () => {
    process.env.VS_AUDITOR = "claude";
    const a = await resolveAuditor("codex");
    expect(a.tier).toBe("agentic");
    expect(a.vendor).toBe("claude");
    expect(a.sameFamily).toBe(false); // override never carries a same-family warning
  });

  it("accepts an openrouter:<model> override", async () => {
    process.env.VS_AUDITOR = "openrouter:glm-4.6";
    const a = await resolveAuditor("codex");
    expect(a.tier).toBe("pre-gathered");
    expect(a.vendor).toBe("openrouter");
    expect(a.model).toBe("glm-4.6");
  });

  it("a malformed override falls open to auto-resolution rather than wedging the auditor (R8)", async () => {
    await shim("codex");
    process.env.VS_AUDITOR = "not-a-real-vendor";
    const a = await resolveAuditor("claude");
    expect(a.tier).toBe("agentic");
    expect(a.vendor).toBe("codex"); // rule1 still fires
  });
});

describe("doctorReport — which rule fired and why, per candidate (SPEC §2 'doctor')", () => {
  it("reports both candidates and marks the one that fired", async () => {
    await shim("codex");
    await shim("claude");
    const r = await doctorReport("codex");
    expect(r.executor).toBe("codex");
    expect(r.family).toBe("openai");
    expect(r.candidates).toHaveLength(2);
    const codexC = r.candidates.find((c) => c.vendor === "codex")!;
    const claudeC = r.candidates.find((c) => c.vendor === "claude")!;
    expect(codexC.ok).toBe(true);
    expect(claudeC.ok).toBe(true);
    // executor is openai-family: rule1 (codex, family≠openai) can't fire; rule2 does.
    expect(codexC.firedRule).toBeNull();
    expect(claudeC.firedRule).toContain("rule2");
    expect(r.chosen.vendor).toBe("claude");
    expect(r.chosen.rule).toContain("rule2");
  });

  it("reports auditor_absent floor with a reason when nothing is available", async () => {
    const r = await doctorReport("claude");
    expect(r.chosen.tier).toBe("absent");
    expect(r.chosen.rule).toContain("floor");
  });
});

describe("doctor cache — 24h TTL (SPEC §2 'auth-probed... cached')", () => {
  it("caches a positive probe: removing the binary after the first resolve doesn't change the cached result", async () => {
    await shim("codex");
    const first = await resolveAuditor("claude");
    expect(first.vendor).toBe("codex");

    await rm(join(shimDir, "codex"), { force: true });
    const second = await resolveAuditor("claude"); // same VS_DOCTOR_CACHE_PATH → cache hit
    expect(second.vendor).toBe("codex");
  });

  it("a fresh cache path re-probes and reflects the now-missing binary", async () => {
    await shim("codex");
    await resolveAuditor("claude");
    await rm(join(shimDir, "codex"), { force: true });

    const freshCache = await mkdtemp(join(tmpdir(), "vs-doctor-cache2-"));
    process.env.VS_DOCTOR_CACHE_PATH = join(freshCache, "doctor.json");
    const after = await resolveAuditor("claude");
    expect(after.tier).toBe("absent");
    await rm(freshCache, { recursive: true, force: true });
  });
});
