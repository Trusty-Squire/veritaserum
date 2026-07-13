import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readLastAssistantMessage, readLastUserMessage, readReceiptsTail } from "../src/transcript.js";

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

  it("reads the captured Codex response_item receipt shape", () => {
    const lines = [
      { timestamp: "2026-07-13T17:05:00.000Z", type: "event_msg", payload: { type: "user_message", message: "fix the retry policy" } },
      {
        timestamp: "2026-07-13T17:05:41.428Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "call_7AeXS3bvObjcES2P13Jrxjnu",
          name: "exec",
          input: 'const r = await tools.exec_command({cmd:"node --test && git diff --check"}); text(r.output);',
        },
      },
      {
        timestamp: "2026-07-13T17:05:41.608Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call_7AeXS3bvObjcES2P13Jrxjnu",
          output: [
            { type: "input_text", text: "Script completed\nWall time 0.2 seconds\nOutput:\n" },
            { type: "input_text", text: "✔ test/retry.test.js\nℹ tests 1\nℹ pass 1\nℹ fail 0\n" },
          ],
        },
      },
      { timestamp: "2026-07-13T17:05:42.000Z", type: "event_msg", payload: { type: "agent_message", message: "Fixed it; node --test passed." } },
    ];
    const p = join(process.cwd(), `node_modules/.cache-codex-receipts-${process.pid}.jsonl`);
    require("node:fs").writeFileSync(p, lines.map((line) => JSON.stringify(line)).join("\n"));
    try {
      expect(readLastUserMessage(p)).toBe("fix the retry policy");
      expect(readLastAssistantMessage(p)).toBe("Fixed it; node --test passed.");
      const receipts = readReceiptsTail(p);
      expect(receipts).toContain("node --test && git diff --check");
      expect(receipts).toContain("ℹ pass 1");
      expect(receipts).toContain("ℹ fail 0");
    } finally {
      require("node:fs").rmSync(p, { force: true });
    }
  });
});

// v3 (SPEC §2): the CLI's `hook-stop` no longer reads a claim out of the
// transcript at all — the sync path only stats the transcript for byte-size
// growth (the "nothing to audit" probe) and never emits a synchronous
// {"decision":"block"}. See test/sync-path.test.ts for the CC-payload coverage.
