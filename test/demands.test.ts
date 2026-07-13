/**
 * Demand materialization (docs/DEMANDS.md: "a demand IS a failing test").
 *
 * The regression that motivated this file: the provenance header is prepended to the
 * authored script, so a script opening with `#!/usr/bin/env node` — the natural shape when
 * an LLM is asked for "a standalone node script" — put its shebang on line 9. Node only
 * tolerates a shebang on line 1, so the oracle died with `SyntaxError: Invalid or
 * unexpected token` and reported UNMET forever, whatever the executor did. An oracle that
 * cannot pass discriminates nothing; the whole mechanism silently rots.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demandLawCommand, materializeDemand, runDemands, type AuthoredDemand } from "../src/demands.js";
import { runGate } from "../src/gate-run.js";
import { tempRepo } from "./helpers.js";

let cleanups: Array<() => Promise<void>> = [];
let repoDir: string;
let savedQueueRoot: string | undefined;

beforeEach(async () => {
  savedQueueRoot = process.env.VS_QUEUE_ROOT;
  const queue = await mkdtemp(join(tmpdir(), "vs-demands-q-"));
  cleanups.push(() => rm(queue, { recursive: true, force: true }));
  process.env.VS_QUEUE_ROOT = queue;

  const { dir, cleanup } = await tempRepo();
  repoDir = dir;
  cleanups.push(cleanup);
});

afterEach(async () => {
  if (savedQueueRoot === undefined) delete process.env.VS_QUEUE_ROOT;
  else process.env.VS_QUEUE_ROOT = savedQueueRoot;
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
});

const demand = (test_file: string): AuthoredDemand => ({
  origin_claim: "the widget is wired up",
  gap: "no evidence the widget exists",
  remedy: "make widget.txt exist",
  accept: "widget.txt is present in the repo root",
  rung: "oracle",
  test_file,
});

const FAILS_NOW = `const fs = require('node:fs');
if (!fs.existsSync('widget.txt')) { console.error('widget.txt missing'); process.exit(1); }
process.exit(0);
`;

describe("materializeDemand — the authored oracle must actually RUN", () => {
  it("a script that opens with a shebang is still runnable (it fails on merit, not SyntaxError)", async () => {
    const out = await materializeDemand(repoDir, demand(`#!/usr/bin/env node\n${FAILS_NOW}`));
    expect(out.action).toBe("added"); // it failed against the tree, so it is a real demand

    // The shebang must NOT survive into the body — Node only allows it on line 1, and the
    // provenance header occupies the top of the file.
    const body = await readFile(out.path!, "utf8");
    expect(body).not.toContain("#!/usr/bin/env node");

    // And it must fail for the RIGHT reason: unmet, not a crashed interpreter.
    const [result] = await runDemands(repoDir);
    expect(result!.passed).toBe(false);
    expect(result!.exitCode).toBe(1); // 1 = our own process.exit(1), NOT a SyntaxError exit
  });

  it("the same demand PASSES once the acceptance condition is genuinely met", async () => {
    const out = await materializeDemand(repoDir, demand(`#!/usr/bin/env node\n${FAILS_NOW}`));
    expect(out.action).toBe("added");

    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(repoDir, "widget.txt"), "built\n", "utf8");

    const [result] = await runDemands(repoDir);
    expect(result!.passed).toBe(true); // an oracle that can never pass is worthless
  });

  it("the portable law record locates the hidden state oracle and fails if it is missing", async () => {
    const out = await materializeDemand(repoDir, demand(`#!/usr/bin/env node\n${FAILS_NOW}`));
    expect(out.action).toBe("added");
    const command = demandLawCommand(out.slug!);

    expect((await runGate(command, repoDir)).exitCode).toBe(1);

    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(repoDir, "widget.txt"), "built\n", "utf8");
    expect((await runGate(command, repoDir)).exitCode).toBe(0);

    await rm(out.path!);
    expect((await runGate(command, repoDir)).exitCode).toBe(1);
  });

  it("runs real CommonJS auditor output beneath an ESM package boundary", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(repoDir, "package.json"), '{"type":"module"}\n', "utf8");

    const out = await materializeDemand(repoDir, demand(`#!/usr/bin/env node\n${FAILS_NOW}`));
    expect(out.action).toBe("added");
    expect(out.path).toMatch(/\.cjs$/);

    await writeFile(join(repoDir, "widget.txt"), "built\n", "utf8");
    const [result] = await runDemands(repoDir);
    expect(result!.passed).toBe(true);
  });

  it("runs real ESM output that derives the repo from import.meta.url", async () => {
    const source = `#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const REPO = dirname(fileURLToPath(import.meta.url));
process.exit(existsSync(join(REPO, "widget.txt")) ? 0 : 1);
`;
    const out = await materializeDemand(repoDir, demand(source));
    expect(out.action).toBe("added");
    expect(out.path).toMatch(/\.mjs$/);

    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(repoDir, "widget.txt"), "built\n", "utf8");
    const [result] = await runDemands(repoDir);
    expect(result!.passed).toBe(true);
  });

  it("discards authored scripts that crash in the interpreter", async () => {
    const out = await materializeDemand(repoDir, demand("#!/usr/bin/env node\nconst broken = ;\n"));
    expect(out.action).toBe("discarded_invalid");
  });

  it("rejects the captured self-recursive demand before it spawns a child", async () => {
    const source = `const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
fs.writeFileSync('recursive-demand-executed', 'bad');
const root = process.cwd();
const cli = path.join(root, 'dist', 'cli.js');
const run = cp.spawnSync(process.execPath, [cli, 'demands'], { cwd: root, encoding: 'utf8' });
process.exit(run.status === 0 ? 0 : 1);
`;
    const out = await materializeDemand(repoDir, demand(source));
    expect(out.action).toBe("discarded_invalid");
    expect((await import("node:fs")).existsSync(join(repoDir, "recursive-demand-executed"))).toBe(false);
  });

  it("a demand that already passes against the current tree is discarded (it discriminates nothing)", async () => {
    const out = await materializeDemand(repoDir, demand("#!/usr/bin/env node\nprocess.exit(0);\n"));
    expect(out.action).toBe("discarded_passing");
  });
});
