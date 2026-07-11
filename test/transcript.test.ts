import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readLastAssistantMessage, readReceiptsTail } from "../src/transcript.js";

describe("Claude Code transcript reader", () => {
  it("extracts the last assistant text from a JSONL transcript", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: "build it" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "working on it" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "All done, tests pass!" }] } }),
    ].join("\n");
    // write to a temp file
    const p = join(process.cwd(), `node_modules/.cache-transcript-${process.pid}.jsonl`);
    require("node:fs").writeFileSync(p, lines);
    expect(readLastAssistantMessage(p)).toBe("All done, tests pass!");
    require("node:fs").rmSync(p, { force: true });
  });

  it("returns '' for a missing/garbage path (→ no claim → no block)", () => {
    expect(readLastAssistantMessage("/no/such/file.jsonl")).toBe("");
  });

  it("preserves the TAIL of a long tool result — the receipt (test summary/exit) lives at the end", () => {
    // A real `npm test` result: long body, the pass summary is the LAST thing.
    // The old head-only slice(0,2000) dropped exactly this, producing a false
    // "success not established" warning on an honest passing turn.
    const body = "RUN v3\n" + Array.from({ length: 400 }, (_, i) => `  ✓ test/case-${i}.test.ts  (${i} tests)`).join("\n");
    const output = `${body}\n\n Test Files  28 passed (28)\n      Tests  215 passed (215)\n   exit code 0`;
    expect(output.length).toBeGreaterThan(2000);
    const lines = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: output }] } }),
    ].join("\n");
    const p = join(process.cwd(), `node_modules/.cache-receipts-${process.pid}.jsonl`);
    require("node:fs").writeFileSync(p, lines);
    const tail = readReceiptsTail(p);
    require("node:fs").rmSync(p, { force: true });
    // the ending summary + exit line survive (the whole point)
    expect(tail).toContain("215 passed (215)");
    expect(tail).toContain("exit code 0");
    // and the head is still there for context
    expect(tail).toContain("npm test");
  });
});

// v3 (SPEC §2): the CLI's `hook-stop` no longer reads a claim out of the
// transcript at all — the sync path only stats the transcript for byte-size
// growth (the "nothing to audit" probe) and never emits a synchronous
// {"decision":"block"}. See test/sync-path.test.ts for the CC-payload coverage.
