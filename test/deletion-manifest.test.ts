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

describe("v1 deletion manifest — refactored-in survivors stay, on the new path", () => {
  it("judge-verdict.ts (semantic gate judge, used by verify.ts) still exports makeSemanticJudge", async () => {
    const mod = (await import("../src/judge-verdict.js")) as Record<string, unknown>;
    expect(typeof mod.makeSemanticJudge).toBe("function");
  });

  it("gate-run.ts (mechanical check exec, used by auditor.ts) still exports runGate", async () => {
    const mod = (await import("../src/gate-run.js")) as Record<string, unknown>;
    expect(typeof mod.runGate).toBe("function");
  });

  it("resolve.ts's CorrectionClassifier consumer chase confirms ratchet.ts never imported claim.ts directly", async () => {
    const mod = (await import("../src/ratchet.js")) as Record<string, unknown>;
    expect(typeof mod.ratchetComplaint).toBe("function"); // ratchet takes a raw complaint string — no claim.ts classifier gate
  });
});
