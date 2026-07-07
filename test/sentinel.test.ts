import { describe, it, expect, afterEach } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { tempRepo } from "./helpers.js";
import { runSentinel } from "../src/sentinel.js";
import { MockLlmClient, type LlmRequest } from "../src/llm.js";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
});

/** A tempRepo with one real change on top of the initial commit, so `git diff`/`status` are non-empty. */
async function repoWithChange(): Promise<string> {
  const { dir, cleanup } = await tempRepo();
  cleanups.push(cleanup);
  const file = join(dir, "answer.txt");
  await writeFile(file, "42\n", "utf8");
  await execa("git", ["add", "-A"], { cwd: dir });
  await execa("git", ["commit", "-q", "-m", "add answer"], { cwd: dir });
  await writeFile(file, "43\n", "utf8");
  return dir;
}

function counting(responder: (req: LlmRequest) => string): { client: MockLlmClient; calls: () => number } {
  let n = 0;
  const client = new MockLlmClient("codex", (req) => {
    n++;
    return responder(req);
  });
  return { client, calls: () => n };
}

describe("runSentinel (hermetic — injected MockLlmClient, no network/subprocess LLM)", () => {
  it("grounded: passes through as grounded, no block", async () => {
    const dir = await repoWithChange();
    const mock = new MockLlmClient("codex", () => '{"grounded": true, "unsupported": ""}');
    const r = await runSentinel(dir, "Added answer.txt", "claude", mock);
    expect(r.block).toBe(false);
    expect(r.verdict).toBe("grounded");
    expect(r.grounded).toBe(true);
  });

  it("contradicted: blocks and surfaces the unsupported claim", async () => {
    const dir = await repoWithChange();
    const mock = new MockLlmClient(
      "codex",
      () => '{"grounded": false, "unsupported": "claims tests pass but no test ran"}',
    );
    const r = await runSentinel(dir, "Done, tests pass!", "claude", mock);
    expect(r.block).toBe(true);
    expect(r.verdict).toBe("blocked");
    expect(r.caught).toContain("claims tests pass but no test ran");
  });

  it("fails open on a malformed (non-JSON) reply — never blocks", async () => {
    const dir = await repoWithChange();
    const mock = new MockLlmClient("codex", () => "not json at all");
    const r = await runSentinel(dir, "Done, tests pass!", "claude", mock);
    expect(r.block).toBe(false);
    expect(r.verdict).toBe("error");
  });

  it("fails open when the client throws", async () => {
    const dir = await repoWithChange();
    const mock = new MockLlmClient("codex", () => {
      throw new Error("boom");
    });
    const r = await runSentinel(dir, "Done, tests pass!", "claude", mock);
    expect(r.block).toBe(false);
    expect(r.verdict).toBe("error");
  });

  it("empty claim: no block, and the judge is never called", async () => {
    const dir = await repoWithChange();
    const { client, calls } = counting(() => '{"grounded": false, "unsupported": "should never be reached"}');
    const r = await runSentinel(dir, "", "codex", client);
    expect(r.block).toBe(false);
    expect(calls()).toBe(0);
  });

  it("parses JSON embedded in prose", async () => {
    const dir = await repoWithChange();
    const groundedMock = new MockLlmClient(
      "codex",
      () => `Sure, here's my assessment: {"grounded": true, "unsupported": ""} — hope that helps!`,
    );
    const grounded = await runSentinel(dir, "Added answer.txt", "claude", groundedMock);
    expect(grounded.block).toBe(false);
    expect(grounded.verdict).toBe("grounded");

    const blockedMock = new MockLlmClient(
      "codex",
      () =>
        `Looking at the evidence, I conclude: {"grounded": false, "unsupported": "no test was run"} is my verdict.`,
    );
    const blocked = await runSentinel(dir, "Done, tests pass!", "claude", blockedMock);
    expect(blocked.block).toBe(true);
    expect(blocked.verdict).toBe("blocked");
    expect(blocked.caught).toContain("no test was run");
  });
});
