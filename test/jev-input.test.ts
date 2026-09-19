import { describe, expect, it } from "vitest";
import {
  compressUserRequest,
  detectLoadBearingClaims,
  digestJevReceipts,
  selectJevEvidence,
  selectStrongestClaimSpans,
} from "../src/jev-input.js";

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

describe("compressed Jev input", () => {
  it("keeps request scope and constraints within a hard UTF-8 budget", () => {
    const request = [
      "For background, the old release was noisy and several people discussed replacing it.",
      "Fix both src/auth.ts and docs/login.md.",
      "Do not change the billing flow, and run the auth tests before saying everything is done.",
      "This final paragraph is intentionally verbose context that should rank below the actual requested work.",
    ].join(" ");

    const compressed = compressUserRequest(request, 180);

    expect(Buffer.byteLength(compressed, "utf8")).toBeLessThanOrEqual(180);
    expect(compressed).toContain("src/auth.ts");
    expect(compressed).toContain("docs/login.md");
    expect(compressed).toContain("Do not change");
  });

  it("clips an overlong highest-priority request unit instead of replacing it with short background", () => {
    const request = `Fix both src/auth.ts and docs/login.md without changing billing ${"carefully ".repeat(100)}. Short background.`;
    const compressed = compressUserRequest(request, 120);
    expect(compressed).toContain("src/auth.ts");
    expect(compressed).not.toBe("Short background.");
    expect(Buffer.byteLength(compressed, "utf8")).toBeLessThanOrEqual(120);
  });

  it("caps claims at the strongest few while preserving their source order", () => {
    const message = [
      "The cache is available.",
      "The root cause was a scheduler race.",
      "I fixed src/cache.ts and committed the patch.",
      "All 48 tests passed in 2.1 seconds.",
      "The branch remains clean.",
    ].join("\n");
    const selected = selectStrongestClaimSpans(detectLoadBearingClaims(message), 3, 300);

    expect(selected).toHaveLength(3);
    expect(selected.map((span) => span.text)).toEqual([
      "The root cause was a scheduler race.",
      "I fixed src/cache.ts and committed the patch.",
      "All 48 tests passed in 2.1 seconds.",
    ]);
  });

  it("turns receipt transcripts into bounded command outcomes", () => {
    const spans = detectLoadBearingClaims("I updated src/cache.ts and all 48 tests passed.");
    const receipts = [
      '> Bash {"command":"pnpm vitest run test/cache.test.ts"}',
      "< RUN v2.1.8",
      "< src/cache.ts",
      "< Test Files 1 passed (1)",
      "< Tests 48 passed (48)",
      "< exit code: 0",
      '> Bash {"command":"curl https://example.test/irrelevant"}',
      `< ${"unrelated prose ".repeat(200)}`,
    ].join("\n");

    const digested = digestJevReceipts(receipts, spans, 700);

    expect(digested.text).toContain('command="pnpm vitest run test/cache.test.ts"');
    expect(digested.text).toContain("exit=0");
    expect(digested.text).toContain("outcome=pass");
    expect(digested.text).toContain("passed=48");
    expect(digested.text).toContain("mentions=src/cache.ts");
    expect(digested.text).not.toContain("unrelated prose");
    expect(digested.bytes).toBeLessThanOrEqual(700);
  });

  it("retains structured browser assertions without pretending visual prose is an outcome", () => {
    const spans = detectLoadBearingClaims("The mobile checkout has no horizontal overflow at 390px.");
    const receipts = [
      "BROWSER_ASSERT viewport=390x844 selector=#checkout horizontal_overflow=false",
      "A designer said the page feels much nicer now.",
    ].join("\n");

    const digested = digestJevReceipts(receipts, spans, 500);

    expect(digested.text).toContain("browser_assert");
    expect(digested.text).toContain("horizontal_overflow=false");
    expect(digested.text).not.toContain("feels much nicer");
  });

  it("retains structured browser result facts inside a tool-call block", () => {
    const spans = detectLoadBearingClaims("The purchase button is visible above the fold on mobile.");
    const receipts = [
      '> Browser {"command":"inspect #purchase-button"}',
      "< DOM_ASSERT viewport=390x844 selector=#purchase-button visible=false bounding_top=912",
    ].join("\n");
    const digested = digestJevReceipts(receipts, spans, 500);
    expect(digested.text).toContain("visible=false");
    expect(digested.text).toContain("viewport=390x844");
  });
});
