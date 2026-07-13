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
});

// v3 (SPEC §2): the CLI's `hook-stop` no longer reads a claim out of the
// transcript at all — the sync path only stats the transcript for byte-size
// growth (the "nothing to audit" probe) and never emits a synchronous
// {"decision":"block"}. See test/sync-path.test.ts for the CC-payload coverage.

/**
 * codex rollouts — the shape that made codex coverage FAKE.
 *
 * Every codex record is wrapped in `payload`, and its tools are their own records
 * (function_call / custom_tool_call + …_output), not content[] parts. This reader looked for
 * `role`/`content` at the top level, found neither, and returned "" for every field — so the
 * auditor audited an empty string and reported "no-claim". 830 vacuous audits in a single
 * day on the busiest harness on the box, while telemetry looked green.
 *
 * The fixture is built from a REAL rollout (shapes preserved verbatim, text redacted). A
 * hand-written mock is exactly what hid this bug: it would have agreed with the reader.
 */
describe("codex rollout transcript reader", () => {
  const fixture = join(import.meta.dirname, "fixtures", "codex-rollout.jsonl");

  it("reads the assistant's final message out of codex's payload wrapper", () => {
    expect(readLastAssistantMessage(fixture)).toBe("Done — the migration is complete and all tests pass.");
  });

  it("reads the HUMAN's request, not codex's injected AGENTS.md / environment_context", () => {
    // codex injects instructions and env context as `role:"user"` records, so the last
    // user-role message is often boilerplate. On a first turn the auditor would have judged
    // the work against the instructions file instead of the actual request. codex logs the
    // human separately as a `user_message` event — that is the request.
    expect(readLastUserMessage(fixture)).toBe("fix the flaky login test");
    expect(readLastUserMessage(fixture)).not.toContain("AGENTS.md");
    expect(readLastUserMessage(fixture)).not.toContain("environment_context");
  });

  it("assembles receipts from codex's standalone tool records (not content[] parts)", () => {
    const receipts = readReceiptsTail(fixture);
    expect(receipts).toContain("> exec"); // the call
    expect(receipts).toContain("npm test"); // its arguments
    expect(receipts).toContain("Tests 208 passed"); // and its OUTPUT — the actual evidence
  });

  it("a codex turn is never audited as empty — the inertness class", () => {
    // The failure was silent: empty content in, "no-claim" out, telemetry green.
    expect(readLastAssistantMessage(fixture).length).toBeGreaterThan(0);
    expect(readReceiptsTail(fixture).length).toBeGreaterThan(0);
  });
});
