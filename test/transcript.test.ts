import { describe, it, expect, afterEach } from "vitest";
import { execa } from "execa";
import { resolve } from "node:path";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { tempRepo, write } from "./helpers.js";
import { seed } from "../src/seed.js";
import { readLastAssistantMessage } from "../src/transcript.js";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
});

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

describe("CLI hook-stop via Claude Code transcript payload", () => {
  const CLI = resolve(import.meta.dirname, "../src/cli.ts");
  const RUNNER = resolve(import.meta.dirname, "../node_modules/.bin/tsx");

  it("blocks a false done-claim delivered via transcript_path + cwd", async () => {
    const { dir, cleanup } = await tempRepo();
    cleanups.push(cleanup);
    await seed(dir, "toy: produce answer.txt");
    // broken build (no answer.txt). CC-style transcript with a done claim.
    const tpath = join(dir, "transcript.jsonl");
    await writeFile(
      tpath,
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done — shipped it." }] } }) + "\n",
    );
    const payload = { hook_event_name: "Stop", transcript_path: tpath, cwd: dir };
    const r = await execa(RUNNER, [CLI, "hook-stop"], { cwd: dir, input: JSON.stringify(payload), reject: false });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.decision).toBe("block");
  });
});
