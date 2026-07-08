import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readLastAssistantMessage } from "../src/transcript.js";

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
});

// v3 (SPEC §2): the CLI's `hook-stop` no longer reads a claim out of the
// transcript at all — the sync path only stats the transcript for byte-size
// growth (the "nothing to audit" probe) and never emits a synchronous
// {"decision":"block"}. See test/sync-path.test.ts for the CC-payload coverage.
