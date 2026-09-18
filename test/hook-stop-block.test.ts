/**
 * VS_BLOCK=1 on hook-stop — captain override of R5. Hermetic: PATH-shimmed
 * auditor, no live Jev/network. Fail-open and the session cap are the load-bearing
 * contracts; the goose plugin path is covered in hook-stop-goose-block.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execa } from "execa";
import { tempRepo } from "./helpers.js";
import { queueRoot } from "../src/audit-runner.js";

const CLI = resolve(import.meta.dirname, "../src/cli.ts");
const RUNNER = resolve(import.meta.dirname, "../node_modules/.bin/tsx");

let shimDir: string;
let cacheDir: string;
let queueDir: string;
let telemetryDir: string;
let cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  shimDir = mkdtempSync(join(tmpdir(), "vs-vsblock-shim-"));
  cacheDir = mkdtempSync(join(tmpdir(), "vs-vsblock-cache-"));
  queueDir = mkdtempSync(join(tmpdir(), "vs-vsblock-queue-"));
  telemetryDir = mkdtempSync(join(tmpdir(), "vs-vsblock-telemetry-"));
});

afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
  await Promise.all([
    rm(shimDir, { recursive: true, force: true }),
    rm(cacheDir, { recursive: true, force: true }),
    rm(queueDir, { recursive: true, force: true }),
    rm(telemetryDir, { recursive: true, force: true }),
  ]);
});

async function repo(): Promise<string> {
  const { dir, cleanup } = await tempRepo();
  cleanups.push(cleanup);
  return dir;
}

function writeCodexShim(reply: string): void {
  const p = join(shimDir, "codex");
  writeFileSync(p, `#!/bin/sh\necho '${reply}'\nexit 0\n`, "utf8");
  chmodSync(p, 0o755);
}

const CONTRADICTED =
  '{"claims":[{"claim":"PRE-EXISTING - fails on clean tree too","verdict":"contradicted","basis":"no clean-tree run in the receipts; HEAD only touches README","evidence":"git show --stat HEAD","reliance":"the user treats the suite as pre-broken and skips the real failure in this tree"}],"unaccountable":false,"note":""}';

async function hookStop(dir: string, payload: object, env: Record<string, string> = {}) {
  const r = await execa(RUNNER, [CLI, "hook-stop"], {
    cwd: dir,
    input: JSON.stringify(payload),
    reject: false,
    env: {
      PATH: `${shimDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
      VS_DOCTOR_CACHE_PATH: join(cacheDir, "doctor.json"),
      VS_QUEUE_ROOT: queueDir,
      VS_TELEMETRY_PATH: join(telemetryDir, "telemetry.jsonl"),
      VS_EXECUTOR: "unknown",
      VS_HARNESS: "claude-code",
      TYPESAFE_API_KEY: "",
      ...env,
    },
  });
  return { code: r.exitCode ?? 1, out: r.stdout, err: r.stderr };
}

function transcript(dir: string, text: string): string {
  const tdir = mkdtempSync(join(tmpdir(), "vs-vsblock-t-"));
  cleanups.push(() => rm(tdir, { recursive: true, force: true }));
  const tpath = join(tdir, "transcript.jsonl");
  writeFileSync(
    tpath,
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n",
  );
  return tpath;
}

describe("hook-stop VS_BLOCK=1 — captain override", () => {
  it("a confident unbacked state claim blocks Claude Code with JSON decision:block", async () => {
    const dir = await repo();
    writeCodexShim(CONTRADICTED);
    const tpath = transcript(dir, "PRE-EXISTING - fails on clean tree too");
    const r = await hookStop(
      dir,
      { transcript_path: tpath, cwd: dir, last_assistant_message: "PRE-EXISTING - fails on clean tree too" },
      { VS_BLOCK: "1", VS_AUDITOR: "codex" },
    );
    expect(r.code).toBe(0);
    const body = JSON.parse(r.out.trim().split("\n").pop()!) as { decision: string; reason: string };
    expect(body.decision).toBe("block");
    expect(body.reason).toContain("PRE-EXISTING");
  });

  it("an auditor outage (jev override, no key) does NOT block", async () => {
    const dir = await repo();
    const tpath = transcript(dir, "PRE-EXISTING - fails on clean tree too");
    const r = await hookStop(
      dir,
      { transcript_path: tpath, cwd: dir, last_assistant_message: "PRE-EXISTING - fails on clean tree too" },
      { VS_BLOCK: "1", VS_AUDITOR: "jev", TYPESAFE_API_KEY: "" },
    );
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('"decision":"block"');
  });

  it("a session already at cap 2 does not block again", async () => {
    const dir = await repo();
    writeCodexShim(CONTRADICTED);
    const tpath = transcript(dir, "PRE-EXISTING - fails on clean tree too");
    const prev = process.env.VS_QUEUE_ROOT;
    process.env.VS_QUEUE_ROOT = queueDir;
    try {
      const qdir = queueRoot(dir);
      mkdirSync(join(qdir, "block-count"), { recursive: true });
      writeFileSync(join(qdir, "block-count", tpath.replace(/[^a-zA-Z0-9._-]/g, "_") + ".json"), JSON.stringify({ count: 2 }), "utf8");
    } finally {
      if (prev === undefined) delete process.env.VS_QUEUE_ROOT;
      else process.env.VS_QUEUE_ROOT = prev;
    }
    const r = await hookStop(
      dir,
      { transcript_path: tpath, cwd: dir, last_assistant_message: "PRE-EXISTING - fails on clean tree too" },
      { VS_BLOCK: "1", VS_AUDITOR: "codex", VS_BLOCK_CAP: "2" },
    );
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('"decision":"block"');
  });
});
