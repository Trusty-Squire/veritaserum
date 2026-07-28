import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readLastAssistantMessage, readLastUserMessage, readReceiptsTail, readConversationTail, readFullSessionToolResults } from "../src/transcript.js";

describe("Claude Code transcript reader", () => {
  it("extracts the last assistant text from a JSONL transcript", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: "build it" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "working on it" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "All done, tests pass!" }] } }),
    ].join("\n");
    // write to a temp file
    const p = join(tmpdir(), `vs-cache-transcript-${process.pid}.jsonl`);
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
    const p = join(tmpdir(), `vs-cache-receipts-${process.pid}.jsonl`);
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
    const p = join(tmpdir(), `vs-cache-codex-receipts-${process.pid}.jsonl`);
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

describe("readConversationTail — recent prose exchange for reliance judgment", () => {
  it("extracts recent user/assistant prose and drops tool_use / tool_result noise", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: "is it safe to merge?" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm test" } }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "Tests 4 passed" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "all tests pass, safe to merge" }] } }),
    ].join("\n");
    const p = join(tmpdir(), `vs-cache-convtail-${process.pid}.jsonl`);
    require("node:fs").writeFileSync(p, lines);
    try {
      const tail = readConversationTail(p);
      expect(tail).toContain("User: is it safe to merge?");
      expect(tail).toContain("Agent: all tests pass, safe to merge");
      // tool noise never leaks into the reliance tail
      expect(tail).not.toContain("pnpm test");
      expect(tail).not.toContain("Tests 4 passed");
    } finally {
      require("node:fs").rmSync(p, { force: true });
    }
  });

  it("reads the codex event_msg user/agent shapes", () => {
    const lines = [
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "which two still fail?" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "the two stubborn ones" } }),
    ].join("\n");
    const p = join(tmpdir(), `vs-cache-convtail-codex-${process.pid}.jsonl`);
    require("node:fs").writeFileSync(p, lines);
    try {
      const tail = readConversationTail(p);
      expect(tail).toContain("User: which two still fail?");
      expect(tail).toContain("Agent: the two stubborn ones");
    } finally {
      require("node:fs").rmSync(p, { force: true });
    }
  });

  it("is tolerant of garbage and a missing file → '' (never throws)", () => {
    expect(readConversationTail("/no/such/file.jsonl")).toBe("");
    const p = join(tmpdir(), `vs-cache-convtail-garbage-${process.pid}.jsonl`);
    require("node:fs").writeFileSync(p, "not json\n{bad json\n\n[[[\n");
    try {
      expect(readConversationTail(p)).toBe("");
    } finally {
      require("node:fs").rmSync(p, { force: true });
    }
  });
});

// v3 (SPEC §2): the CLI's `hook-stop` no longer reads a claim out of the
// transcript at all — the sync path only stats the transcript for byte-size
// growth (the "nothing to audit" probe) and never emits a synchronous
// {"decision":"block"}. See test/sync-path.test.ts for the CC-payload coverage.

// ---------------------------------------------------------------------------
// readFullSessionToolResults — THE FALSE-FLAG MECHANISM fix (2026-07-27): the
// uncapped, whole-transcript tool-result reader that backs auditor.ts's
// demoteFullSessionFigures. Unlike readReceiptsTail (64KB tail, 2000-char/line
// clip), this scans every line for the WHOLE session's tool_result content,
// capped only by an honest file-size bail.
// ---------------------------------------------------------------------------
describe("readFullSessionToolResults — whole-session tool-result scan", () => {
  it("collects tool_result text from anywhere in the transcript (not just the tail), ignoring tool_use calls", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "browser_observe", input: { url: "https://shop.example/cart" } }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "cart: $60.00 subtotal, free shipping, $60.00 total" }] } }),
      // many turns of unrelated noise follow, simulating the figure scrolling out of a tail window
      ...Array.from({ length: 20 }, (_, i) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `unrelated turn ${i}` }] } })),
    ].join("\n");
    const p = join(tmpdir(), `vs-cache-fullscan-${process.pid}.jsonl`);
    require("node:fs").writeFileSync(p, lines);
    try {
      const { text, bailed } = readFullSessionToolResults(p);
      expect(bailed).toBe(false);
      expect(text).toContain("$60.00 total");
      // the tool_use call's own argv text never leaks in (calls are not results)
      expect(text).not.toContain("browser_observe");
    } finally {
      require("node:fs").rmSync(p, { force: true });
    }
  });

  it("collects the codex custom_tool_call_output shape", () => {
    const lines = [
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "curl cart" } },
      { type: "response_item", payload: { type: "custom_tool_call_output", output: [{ type: "input_text", text: "Total: $60.00" }] } },
    ];
    const p = join(tmpdir(), `vs-cache-fullscan-codex-${process.pid}.jsonl`);
    require("node:fs").writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"));
    try {
      const { text, bailed } = readFullSessionToolResults(p);
      expect(bailed).toBe(false);
      expect(text).toContain("Total: $60.00");
    } finally {
      require("node:fs").rmSync(p, { force: true });
    }
  });

  it("ANTI-SELF-LAUNDERING GUARD: a figure appearing only in the agent's OWN prior assistant text is never captured — only tool_result content grounds", () => {
    const lines = [
      // the agent asserts the figure in plain prose; no tool ever produced it
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I estimate the total will be $60.00." }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "unrelated: 200 OK" }] } }),
    ].join("\n");
    const p = join(tmpdir(), `vs-cache-fullscan-selflaunder-${process.pid}.jsonl`);
    require("node:fs").writeFileSync(p, lines);
    try {
      const { text, bailed } = readFullSessionToolResults(p);
      expect(bailed).toBe(false);
      expect(text).not.toContain("$60.00");
      expect(text).not.toContain("estimate");
    } finally {
      require("node:fs").rmSync(p, { force: true });
    }
  });

  it("returns { text: '', bailed: false } for a missing file (fail-open, never throws)", () => {
    expect(readFullSessionToolResults("/no/such/transcript.jsonl")).toEqual({ text: "", bailed: false });
  });

  it("bails honestly (never a partial scan) when the transcript exceeds the cap", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "cart total $60.00" }] } }),
    ].join("\n");
    const p = join(tmpdir(), `vs-cache-fullscan-oversized-${process.pid}.jsonl`);
    require("node:fs").writeFileSync(p, lines);
    try {
      // a tiny cap (smaller than the file) exercises the same bail branch the
      // production ~5MB default guards, without writing an actual 5MB fixture.
      const { text, bailed } = readFullSessionToolResults(p, 10);
      expect(bailed).toBe(true);
      expect(text).toBe("");
    } finally {
      require("node:fs").rmSync(p, { force: true });
    }
  });

  it("is tolerant of garbage (never throws)", () => {
    const p = join(tmpdir(), `vs-cache-fullscan-garbage-${process.pid}.jsonl`);
    require("node:fs").writeFileSync(p, "not json\n{bad json\n\n[[[\n");
    try {
      expect(readFullSessionToolResults(p)).toEqual({ text: "", bailed: false });
    } finally {
      require("node:fs").rmSync(p, { force: true });
    }
  });
});
