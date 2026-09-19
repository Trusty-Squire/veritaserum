import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isExhausted,
  resolveAuditor,
  doctorReport,
  executorFamily,
  parseCodexExecJson,
  parseClaudePrintJson,
} from "../src/resolve.js";

// Hermetic: this sandbox has REAL codex/claude CLIs on the ambient PATH (used by
// eval/ scripts), so every test pins PATH to a fresh shim dir + the bare minimum
// system dirs `sh`/`command` need, and points the 24h doctor cache at a fresh temp
// file — never the real ~/.veritaserum/doctor.json, never the real CLIs.

const ENV_KEYS = ["PATH", "VS_DOCTOR_CACHE_PATH", "VS_AUDITOR", "VS_AUDITOR_METERED", "OPENROUTER_API_KEY", "VS_AUDITOR_EFFORT", "TYPESAFE_API_KEY"] as const;
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
  delete process.env.VS_AUDITOR_EFFORT;
  delete process.env.TYPESAFE_API_KEY;
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

describe("provider usage parsing — exact counters, never prompt-size estimates", () => {
  it("reads Codex turn.completed usage and the final agent message", () => {
    const parsed = parseCodexExecJson(
      [
        JSON.stringify({ type: "thread.started", thread_id: "t1" }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"claims":[]}' } }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1_234, cached_input_tokens: 900, output_tokens: 56 } }),
      ].join("\n"),
      "gpt-test",
    );
    expect(parsed.text).toBe('{"claims":[]}');
    expect(parsed.usage).toEqual({
      status: "reported",
      inputTokens: 1_234,
      outputTokens: 56,
      model: "gpt-test",
    });
  });

  it("marks Codex usage unavailable when turn.completed omits it", () => {
    const parsed = parseCodexExecJson(
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }),
    );
    expect(parsed.text).toBe("ok");
    expect(parsed.usage.status).toBe("unavailable");
  });

  it("sums Claude's provider-reported uncached + cache input and preserves reported cost", () => {
    const parsed = parseClaudePrintJson(
      JSON.stringify({
        result: '{"claims":[]}',
        total_cost_usd: 0.0123,
        modelUsage: {
          "claude-sonnet-test": {
            inputTokens: 100,
            cacheCreationInputTokens: 200,
            cacheReadInputTokens: 300,
            outputTokens: 40,
            costUSD: 0.0123,
          },
        },
      }),
      "sonnet",
    );
    expect(parsed.text).toBe('{"claims":[]}');
    expect(parsed.usage).toEqual({
      status: "reported",
      inputTokens: 600,
      outputTokens: 40,
      model: "claude-sonnet-test",
      costUsd: 0.0123,
    });
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

describe("Jev — on the existing resolution ladder when TYPESAFE_API_KEY is set", () => {
  it("prefers Jev over agentic CLIs and is never same-family", async () => {
    await shim("codex");
    await shim("claude");
    process.env.TYPESAFE_API_KEY = "sk-test-not-a-real-key";
    const a = await resolveAuditor("claude");
    expect(a.vendor).toBe("jev");
    expect(a.tier).toBe("pre-gathered");
    expect(a.sameFamily).toBe(false);
    expect(a.model).toBe("jev-latest");
  });

  it("VS_AUDITOR still overrides Jev", async () => {
    process.env.TYPESAFE_API_KEY = "sk-test-not-a-real-key";
    process.env.VS_AUDITOR = "ollama:qwen2.5:3b";
    const a = await resolveAuditor("claude");
    expect(a.vendor).toBe("ollama");
  });

  it("doctor names Jev as the fired rule", async () => {
    process.env.TYPESAFE_API_KEY = "sk-test-not-a-real-key";
    const r = await doctorReport("codex");
    expect(r.chosen.vendor).toBe("jev");
    expect(r.chosen.rule).toContain("jev");
    expect(r.chosen.sameFamily).toBe(false);
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

/** Shim codex to dump its argv (one per line) to a capture file, then exit 0 with a harmless reply. */
async function shimCapturingArgv(captureFile: string): Promise<void> {
  const p = join(shimDir, "codex");
  await writeFile(p, `#!/bin/sh\nfor a in "$@"; do echo "$a" >> '${captureFile}'; done\necho ok\nexit 0\n`, "utf8");
  await chmod(p, 0o755);
}

describe("codex reasoning-effort flag (VS_AUDITOR_EFFORT)", () => {
  it("VS_AUDITOR_EFFORT=medium adds -c model_reasoning_effort=medium before the trailing -", async () => {
    const captureFile = join(shimDir, "argv-medium.txt");
    await shimCapturingArgv(captureFile);
    process.env.VS_AUDITOR_EFFORT = "medium";
    const a = await resolveAuditor("claude");
    expect(a.vendor).toBe("codex");
    await a.invoke("hello", shimDir);
    const lines = (await readFile(captureFile, "utf8")).trim().split("\n");
    expect(lines).toContain("-c");
    const cIndex = lines.indexOf("-c");
    expect(lines[cIndex + 1]).toBe("model_reasoning_effort=medium");
    expect(lines[lines.length - 1]).toBe("-"); // trailing stdin marker still last
  });

  it("unset VS_AUDITOR_EFFORT omits the flag entirely", async () => {
    const captureFile = join(shimDir, "argv-unset.txt");
    await shimCapturingArgv(captureFile);
    const a = await resolveAuditor("claude");
    await a.invoke("hello", shimDir);
    const lines = (await readFile(captureFile, "utf8")).trim().split("\n");
    expect(lines).not.toContain("-c");
    expect(lines.join(" ")).not.toContain("model_reasoning_effort");
  });

  it("a garbage VS_AUDITOR_EFFORT value omits the flag (fail-open, no throw)", async () => {
    const captureFile = join(shimDir, "argv-garbage.txt");
    await shimCapturingArgv(captureFile);
    process.env.VS_AUDITOR_EFFORT = "ultra-max";
    const a = await resolveAuditor("claude");
    await expect(a.invoke("hello", shimDir)).resolves.not.toThrow();
    const lines = (await readFile(captureFile, "utf8")).trim().split("\n");
    expect(lines).not.toContain("-c");
    expect(lines.join(" ")).not.toContain("model_reasoning_effort");
  });
});

/**
 * A usage limit is not a broken auditor — it is an exhausted one, and the remedy is a
 * different vendor, not a retry. This mattered: three codex turns were audited against a
 * Claude account that had hit its limit, and every one recorded `verdict=error` with an
 * EMPTY reason, because these CLIs print "You've reached your … limit" to STDOUT and exit 1
 * while we captured only stderr. An audit that fails for no stated cause is indistinguishable
 * from one that never ran.
 */
describe("auditor exhaustion — recognise it, report it, route around it", () => {
  it("recognises a usage-limit refusal as exhaustion, not a generic failure", () => {
    expect(isExhausted("claude -p failed (exit 1): You've reached your Fable 5 limit.")).toBe(true);
    expect(isExhausted("codex exec failed (exit 1): rate limit exceeded")).toBe(true);
    expect(isExhausted("429 Too Many Requests")).toBe(true);
    expect(isExhausted("out of credits")).toBe(true);
  });

  it("does NOT mistake an ordinary failure for exhaustion (that would route around a real bug)", () => {
    expect(isExhausted("claude -p failed (exit 1): no output")).toBe(false);
    expect(isExhausted("codex exec failed (exit timeout):")).toBe(false);
    expect(isExhausted("auditor reply did not parse as the expected JSON verdict")).toBe(false);
  });
});
