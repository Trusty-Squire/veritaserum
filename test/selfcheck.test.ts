/**
 * The install is only real if the hook RUNS. These tests replay the failures that actually
 * happened — each one shipped green, each one left veritaserum installed and inert — and
 * assert the self-check turns red for every single one.
 *
 * A check that cannot fail is decoration, so every case here is paired: the defect must be
 * caught, and the healthy install must stay silent.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfcheck } from "../src/selfcheck.js";

const NODE = process.execPath;
const DIST = join(process.cwd(), "dist");
const REAL_STOP = `VS_HARNESS=codex '${NODE}' '${join(DIST, "hook-cli.cjs")}'`;
const REAL_PROMPT = `VS_HARNESS=codex '${NODE}' '${join(DIST, "cli.js")}' hook-prompt`;

let home = "";
let savedHome: string | undefined;

async function wire(stop: string, prompt: string, extraPrompt?: string): Promise<void> {
  const hooks = {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: stop }] }],
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: prompt }] },
        ...(extraPrompt ? [{ hooks: [{ type: "command", command: extraPrompt }] }] : []),
      ],
    },
  };
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, ".codex", "hooks.json"), JSON.stringify(hooks), "utf8");
}

const failures = async () => (await selfcheck("codex")).filter((c) => !c.ok);

beforeEach(async () => {
  savedHome = process.env.HOME;
  home = await mkdtemp(join(tmpdir(), "vs-selfcheck-home-"));
  process.env.HOME = home;
});
afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  await rm(home, { recursive: true, force: true });
});

describe("selfcheck — a green install must be demonstrably green", () => {
  it("a correct install passes every check", async () => {
    await wire(REAL_STOP, REAL_PROMPT);
    expect(await failures()).toEqual([]);
  });

  it("a legitimate hook from ANOTHER tool on the same event does not cry wolf", async () => {
    // It may rely on the user's real PATH. Failing it here would train the user to ignore
    // the check — and an ignored check is no better than no check.
    await wire(REAL_STOP, REAL_PROMPT, "/bin/true");
    expect(await failures()).toEqual([]);
  });
});

describe("selfcheck — every 'installed but inert' failure that actually shipped", () => {
  it("a Stop hook that exits 0 but enqueues NOTHING (the goose-DB defect: clean and dead)", async () => {
    await wire("VS_HARNESS=codex true", REAL_PROMPT);
    const bad = await failures();
    expect(bad.map((c) => c.name)).toContain("Stop hook enqueues an audit");
    expect(bad[0]!.detail).toMatch(/queued NOTHING/i);
  });

  it("a prompt hook that prints BARE TEXT to codex (a verdict addressed to no one)", async () => {
    await wire(REAL_STOP, `VS_HARNESS=codex /bin/echo 'veritaserum: selfcheck probe'`);
    const bad = await failures();
    expect(bad.map((c) => c.name)).toContain("UserPromptSubmit hook reaches the model");
    expect(bad.find((c) => c.name.includes("reaches the model"))!.detail).toMatch(/does NOT read this/i);
  });

  it("a hook whose command does not exist (exit 127 — 'hook exited with code 127')", async () => {
    await wire(REAL_STOP, `VS_HARNESS=codex /no/such/hook.sh`);
    const bad = await failures();
    expect(bad.map((c) => c.name)).toContain("UserPromptSubmit hook runs");
  });

  it("a BROKEN hook from another tool on our event — the harness reports the event failed", async () => {
    await wire(REAL_STOP, REAL_PROMPT, "/no/such/leftover-probe.sh");
    const bad = await failures();
    expect(bad.map((c) => c.name)).toContain("UserPromptSubmit: another tool's hook runs");
    expect(bad[0]!.detail).toMatch(/shares this event and breaks it/);
  });

  it("our hook silently missing from an event we depend on", async () => {
    await wire(REAL_STOP, "/bin/true");
    const bad = await failures();
    expect(bad.map((c) => c.name)).toContain("UserPromptSubmit hook installed");
  });
});
