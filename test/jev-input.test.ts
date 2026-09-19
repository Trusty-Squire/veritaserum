import { describe, expect, it } from "vitest";
import { detectLoadBearingClaims, selectJevEvidence } from "../src/jev-input.js";

describe("detectLoadBearingClaims", () => {
  it("returns verbatim source-offset spans for state, work, test, quantity, and causal claims", () => {
    const message = [
      "The root cause is the expired token.",
      "I corrected src/auth.ts and committed the fix.",
      "All 128 tests passed in 4.2 seconds.",
    ].join("\n");

    const spans = detectLoadBearingClaims(message);

    expect(spans.map((span) => span.text)).toEqual([
      "The root cause is the expired token.",
      "I corrected src/auth.ts and committed the fix.",
      "All 128 tests passed in 4.2 seconds.",
    ]);
    for (const span of spans) expect(message.slice(span.start, span.end)).toBe(span.text);
  });

  it("drops questions, hedges, predictions, fiction, quotations, relayed verdicts, and structured blobs", () => {
    const rejected = [
      "Could the timeout be an IP allow-list?",
      "It might be the expired token, but I have not verified it.",
      "The new cache will cut latency by 43%.",
      "In this fictional story, all 128 tests passed.",
      '> "All 128 tests passed."',
      'veritaserum: Codex, you have no basis to claim "all tests passed".',
      '{"status":"complete","tests":128}',
    ];

    for (const message of rejected) expect(detectLoadBearingClaims(message), message).toEqual([]);
  });

  it("keeps a completed correction even when the sentence also describes its expected future effect", () => {
    const message = "I fixed src/cache.ts; this should prevent the next timeout.";
    expect(detectLoadBearingClaims(message).map((span) => span.text)).toEqual(["I fixed src/cache.ts;"]);
  });

  it("keeps generic confident present-state reports but drops pure judgments", () => {
    expect(detectLoadBearingClaims("The installer requires existing Codex sessions to restart.")).toHaveLength(1);
    expect(detectLoadBearingClaims("This visual direction is beautiful and clearly better.")).toEqual([]);
    expect(detectLoadBearingClaims("I recommend the simpler layout.")).toEqual([]);
  });
});

describe("selectJevEvidence", () => {
  it("keeps receipts matching named commands, tests, files, and numbers while dropping unrelated output", () => {
    const message = "I updated src/cache.ts, and `pnpm test` passed all 128 tests in 4.2 seconds.";
    const spans = detectLoadBearingClaims(message);
    const evidence = [
      '> Bash {"command":"git status"}',
      "< clean",
      '> Bash {"command":"pnpm test"}',
      "< src/cache.ts: 128 tests passed in 4.2 seconds",
      '> Bash {"command":"curl https://example.test/noise"}',
      `< ${"unrelated output ".repeat(300)}`,
    ].join("\n");

    const selected = selectJevEvidence(evidence, spans, 2 * 1024);

    expect(selected.text).toContain("pnpm test");
    expect(selected.text).toContain("src/cache.ts: 128 tests passed in 4.2 seconds");
    expect(selected.text).not.toContain("unrelated output");
    expect(selected.text).toContain("evidence lines elided");
    expect(selected.bytes).toBeLessThan(Buffer.byteLength(evidence, "utf8"));
  });
});
