import { describe, expect, it } from "vitest";
import { buildJevInputVariants, gatherCompressedJevEvidence } from "../src/jev-evidence.js";
import { detectLoadBearingClaims, JEV_COMPRESSED_EVIDENCE_BUDGET_BYTES } from "../src/jev-input.js";
import { fixtureRepo } from "../eval/fixtures/types.js";

describe("compressed Jev evidence", () => {
  it("emits bounded git and receipt outcomes instead of transcript prose", async () => {
    const { dir, cleanup } = await fixtureRepo({
      commits: [{ message: "fix: cache race", files: { "src/cache.ts": "export const fixed = true;\n" } }],
      uncommittedFiles: { "docs/note.md": "draft\n" },
    });
    try {
      const spans = detectLoadBearingClaims("I committed the src/cache.ts fix and all 12 tests passed.");
      const receipts = [
        "$ pnpm vitest run test/cache.test.ts",
        "Tests 12 passed (12)",
        "exit code: 0",
        `This is human-readable output that is irrelevant. ${"noise ".repeat(500)}`,
      ].join("\n");

      const evidence = await gatherCompressedJevEvidence(dir, receipts, spans);

      expect(evidence).toContain("git_head sha=");
      expect(evidence).toContain("src/cache.ts");
      expect(evidence).toContain("outcome=pass");
      expect(evidence).toContain("passed=12");
      expect(evidence).not.toContain("human-readable output");
      expect(Buffer.byteLength(evidence, "utf8")).toBeLessThanOrEqual(JEV_COMPRESSED_EVIDENCE_BUDGET_BYTES);
    } finally {
      await cleanup();
    }
  });

  it("builds comparable full, filtered, and compressed states", async () => {
    const { dir, cleanup } = await fixtureRepo(undefined);
    try {
      const input = await buildJevInputVariants({
        dir,
        userRequest: `${"Background context. ".repeat(100)} Fix src/auth.ts only and run the tests.`,
        finalMessage: `${"Could we discuss more background later?\n".repeat(20)}I fixed src/auth.ts and all 8 tests passed.`,
        receipts: `$ pnpm test\nTests 8 passed (8)\nexit code: 0\n${"irrelevant output\n".repeat(300)}`,
      });

      expect(input.full.finalMessage.length).toBeGreaterThan(input.filtered.finalMessage.length);
      expect(input.filtered.userRequest).toBe(input.full.userRequest);
      expect(input.compressed.userRequest.length).toBeLessThan(input.filtered.userRequest.length);
      expect(input.compressed.finalMessage).toContain("all 8 tests passed");
      expect(input.compressed.evidence).toContain("outcome=pass");
      expect(JSON.stringify(input.compressed).length).toBeLessThan(10_000);
    } finally {
      await cleanup();
    }
  });
});
