import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAuditor, doctorReport, jevDidNotRun } from "../src/resolve.js";
import { JEV_MODEL } from "../src/jev.js";

const ENV_KEYS = ["TYPESAFE_API_KEY", "PATH", "VS_AUDITOR", "OPENROUTER_API_KEY"] as const;
let saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
let shimDir: string;

beforeEach(async () => {
  shimDir = await mkdtemp(join(tmpdir(), "vs-resolve-shim-"));
  saved = {};
  for (const k of ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) saved[k] = v;
  }
  process.env.PATH = `${shimDir}:/usr/bin:/bin`;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.VS_AUDITOR;
  delete process.env.OPENROUTER_API_KEY;
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(shimDir, { recursive: true, force: true });
});

describe("resolveAuditor — Jev is the only classifier", () => {
  it("no key → absent, vendor none", async () => {
    const a = await resolveAuditor("claude");
    expect(a.tier).toBe("absent");
    expect(a.vendor).toBe("none");
    await expect(a.invoke("x", "/tmp")).rejects.toThrow(/jev did not run/i);
  });

  it("TYPESAFE_API_KEY present → jev, even with coding-agent CLIs on PATH", async () => {
    process.env.TYPESAFE_API_KEY = "sk-test";
    const a = await resolveAuditor("unknown");
    expect(a.vendor).toBe("jev");
    expect(a.tier).toBe("pre-gathered");
    expect(a.model).toBe(JEV_MODEL);
    expect(a.sameFamily).toBe(false);
  });

  it("VS_AUDITOR is not a selector — missing key still means Jev did not run", async () => {
    process.env.VS_AUDITOR = "codex";
    const a = await resolveAuditor("unknown");
    expect(a.tier).toBe("absent");
    expect(a.vendor).toBe("none");
  });
});

describe("doctorReport — Jev available or not", () => {
  it("without a key, doctor says Jev did not run", async () => {
    const r = await doctorReport("unknown");
    expect(r.chosen.vendor).toBe("none");
    expect(r.chosen.rule).toBe(jevDidNotRun("TYPESAFE_API_KEY is not set"));
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.vendor).toBe("jev");
    expect(r.candidates[0]!.ok).toBe(false);
  });

  it("with a key, doctor chooses jev", async () => {
    process.env.TYPESAFE_API_KEY = "sk-test";
    const r = await doctorReport("codex");
    expect(r.chosen.vendor).toBe("jev");
    expect(r.chosen.model).toBe(JEV_MODEL);
    expect(r.candidates[0]!.ok).toBe(true);
  });
});
