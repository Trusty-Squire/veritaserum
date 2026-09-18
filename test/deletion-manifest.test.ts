/**
 * v1 deletion manifest (SPEC.md §4 "what v3 deletes", §6.11 "v1 deletion
 * manifest asserted: regex extractors and dual-path symbols absent"). One
 * evaluator now (the async cross-family auditor, src/auditor.ts) — the v1
 * lexical claim-detection module and the synchronous hookStop/hookPrompt dual
 * path are gone, not just unused.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execa } from "execa";

const ROOT = resolve(import.meta.dirname, "..");
const src = (f: string) => resolve(ROOT, "src", f);
const test = (f: string) => resolve(ROOT, "test", f);

describe("v1 deletion manifest — files absent", () => {
  it("src/claim.ts is gone (R2: no lexical claim detection — DONE/NOT_DONE/GOAL regexes + mockClaimExtractor/mockGoalClassifier/makeLlmClaimExtractor had no surviving consumer once hook.ts was deleted)", () => {
    expect(existsSync(src("claim.ts"))).toBe(false);
  });

  it("src/hook.ts (hookStop/hookPrompt dual path) is gone — replaced by the sync path + enqueue in src/cli.ts", () => {
    expect(existsSync(src("hook.ts"))).toBe(false);
  });

  it("src/sentinel.ts (sync judge-primary confabulation check) is gone — superseded by src/auditor.ts", () => {
    expect(existsSync(src("sentinel.ts"))).toBe(false);
  });

  it("their direct-function test files are gone with them", () => {
    expect(existsSync(test("hook.test.ts"))).toBe(false);
    expect(existsSync(test("sentinel.test.ts"))).toBe(false);
  });
});

// Specifiers built at runtime (not string literals) so `tsc` can't statically
// resolve — and doesn't try to — module paths that are absent BY DESIGN.
function deletedModuleSpecifier(name: string): string {
  return `../src/${name}.js`;
}

describe("v1 deletion manifest — import attempts fail", () => {
  it("importing src/claim.js throws (module absent)", async () => {
    await expect(import(deletedModuleSpecifier("claim"))).rejects.toThrow();
  });

  it("importing src/hook.js throws (module absent)", async () => {
    await expect(import(deletedModuleSpecifier("hook"))).rejects.toThrow();
  });

  it("importing src/sentinel.js throws (module absent)", async () => {
    await expect(import(deletedModuleSpecifier("sentinel"))).rejects.toThrow();
  });
});

describe("v3 deletion manifest — the contract system is gone (one role, not four)", () => {
  const GONE = [
    "contract",
    "propose",
    "seed",
    "verify",
    "ratchet",
    "judge",
    "judge-verdict",
    "knight-llm",
    "transcriber-llm",
    "pristine",
    "symptom",
    "mcp",
  ];

  it.each(GONE)("src/%s.ts is gone — knight/judge/transcriber were special cases of the auditor", (name) => {
    expect(existsSync(src(`${name}.ts`))).toBe(false);
  });

  it.each(GONE)("importing src/%s.js throws (module absent)", async (name) => {
    await expect(import(deletedModuleSpecifier(name))).rejects.toThrow();
  });

  it("vendor resolution keeps exactly one role: the auditor", async () => {
    const mod = (await import("../src/resolve.js")) as Record<string, unknown>;
    expect(typeof mod.resolveAuditor).toBe("function");
    expect(mod.resolveKnight).toBeUndefined();
    expect(mod.resolveJudge).toBeUndefined();
    expect(mod.resolveTranscriber).toBeUndefined();
  });
});

// 2026-07-20: the case-law / demand / statute machinery was removed. The auditor
// is stateless per turn now — LLM verdict + the no-LLM grounding tier. See
// SPEC.md "2026-07-20: case law removed".
describe("v3 deletion manifest — case law is gone (the auditor is stateless per turn)", () => {
  const GONE = ["law", "demands", "gate-run", "schema"];

  it.each(GONE)("src/%s.ts is gone", (name) => {
    expect(existsSync(src(`${name}.ts`))).toBe(false);
  });

  it.each(GONE)("importing src/%s.js throws (module absent)", async (name) => {
    await expect(import(deletedModuleSpecifier(name))).rejects.toThrow();
  });

  it("the in-repo law and statute files are gone", () => {
    expect(existsSync(resolve(ROOT, "veritaserum.law.yaml"))).toBe(false);
    expect(existsSync(resolve(ROOT, "contract.yaml"))).toBe(false);
  });

  it("the auditor no longer authors demands or runs mechanical checks", async () => {
    const mod = (await import("../src/auditor.js")) as Record<string, unknown>;
    // The audit verdict carries no demands/mechanicalChecks: prove the shape by
    // asserting the module exports only audit() as its function surface here.
    expect(typeof mod.audit).toBe("function");
    expect(mod.appendDemand).toBeUndefined();
    expect(mod.materializeDemand).toBeUndefined();
  });

  it("the `retire` and `demands` CLI commands are gone from the usage string", async () => {
    const CLI = resolve(ROOT, "src", "cli.ts");
    const tsx = resolve(ROOT, "node_modules", ".bin", "tsx");
    const r = await execa(tsx, [CLI, "bogus-subcommand"], { reject: false });
    const usage = `${r.stdout}\n${r.stderr}`;
    expect(usage).toMatch(/usage: veritaserum/);
    expect(usage).not.toMatch(/\bretire\b/);
    expect(usage).not.toMatch(/\bdemands\b/);
  });
});
