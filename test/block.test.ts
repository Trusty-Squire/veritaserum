import { describe, expect, it } from "vitest";
import { emitBlock, isBlockEnabled, isBlockExplicitlyOff, shouldBlock, blockCap, DEFAULT_BLOCK_CAP } from "../src/block.js";
import type { AuditVerdict } from "../src/auditor.js";

function verdict(overrides: Partial<AuditVerdict> = {}): AuditVerdict {
  return {
    claims: [],
    unaccountable: false,
    note: "",
    warnings: [],
    deliverableWarnings: [],
    auditorTier: "pre-gathered",
    sameFamily: false,
    vendor: "jev",
    ...overrides,
  };
}

describe("VS_BLOCK off switch — no code edit required", () => {
  it("on only for 1/true/yes/on", () => {
    expect(isBlockEnabled({ VS_BLOCK: "1" })).toBe(true);
    expect(isBlockEnabled({ VS_BLOCK: "true" })).toBe(true);
    expect(isBlockEnabled({})).toBe(false);
    expect(isBlockEnabled({ VS_BLOCK: "0" })).toBe(false);
  });
  it("explicit off wins for the goose plugin path too", () => {
    expect(isBlockExplicitlyOff({ VS_BLOCK: "0" })).toBe(true);
    expect(isBlockExplicitlyOff({ VS_BLOCK: "off" })).toBe(true);
    expect(isBlockExplicitlyOff({})).toBe(false);
  });
  it("default cap is 2", () => {
    expect(blockCap({})).toBe(DEFAULT_BLOCK_CAP);
    expect(blockCap({ VS_BLOCK_CAP: "1" })).toBe(1);
  });
});

describe("shouldBlock — only a positive confident finding, at most the cap", () => {
  it("blocks unsupported/contradicted under the cap", () => {
    expect(
      shouldBlock(
        verdict({
          claims: [{ claim: "PRE-EXISTING", verdict: "contradicted", basis: "no clean-tree run", evidence: "" }],
        }),
        0,
        2,
      ),
    ).toBe(true);
  });
  it("does not block unaccountable work (low sensitivity — not one of the two named classes)", () => {
    expect(shouldBlock(verdict({ unaccountable: true, note: "be specific" }), 0, 2)).toBe(false);
  });
  it("does not block on auditor error (fail-open)", () => {
    expect(
      shouldBlock(
        verdict({
          error: "jev http 500",
          claims: [{ claim: "x", verdict: "contradicted", basis: "y", evidence: "" }],
        }),
        0,
        2,
      ),
    ).toBe(false);
  });
  it("does not block once the session is at cap", () => {
    expect(
      shouldBlock(
        verdict({
          claims: [{ claim: "x", verdict: "unsupported", basis: "y", evidence: "" }],
        }),
        2,
        2,
      ),
    ).toBe(false);
  });
});

describe("emitBlock — harness-specific contracts", () => {
  it("goose (and the goose plugin) uses exit 2 + stderr", () => {
    const e = emitBlock("goose", "reason");
    expect(e.exitCode).toBe(2);
    expect(e.stderr).toContain("reason");
    expect(e.stdout).toBe("");
  });
  it("claude-code and codex use JSON decision:block on stdout", () => {
    const e = emitBlock("claude-code", "reason");
    expect(e.exitCode).toBe(0);
    expect(JSON.parse(e.stdout)).toEqual({ decision: "block", reason: "reason" });
  });
});
