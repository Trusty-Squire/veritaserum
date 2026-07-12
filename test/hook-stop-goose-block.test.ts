/**
 * `veritaserum hook-stop-goose-block` — the SYNCHRONOUS BLOCKING goose Stop-hook
 * mode (an alternative to the async `hook-stop` path; see adapters/goose/README.md
 * "Blocking/corrective variant"). Proven this session against a live goose 1.41.0
 * run: a Stop hook exiting 2 with a reason on stderr BLOCKS turn-end and feeds the
 * reason back to the agent. This suite exercises the CLI end-to-end (BUILT-FROM-SOURCE
 * via tsx, same pattern as test/sync-path.test.ts) with a fixture goose sessions.db
 * (test/goose-session.test.ts's node:sqlite pattern) and a PATH-shimmed fake `codex`
 * CLI standing in for the auditor (same pattern as test/resolve-auditor.test.ts /
 * test/run-audit.test.ts) — no real codex/claude/goose/DeepSeek involved.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { execa } from "execa";
import { tempRepo } from "./helpers.js";
import { queueRoot } from "../src/audit-runner.js";

const CLI = resolve(import.meta.dirname, "../src/cli.ts");
const RUNNER = resolve(import.meta.dirname, "../node_modules/.bin/tsx");
// See src/goose.ts for why this isn't a static `import ... from "node:sqlite"`.
const DatabaseSync: typeof DatabaseSyncType = createRequire(import.meta.url)("node:sqlite").DatabaseSync;

let shimDir: string;
let cacheDir: string;
let queueDir: string;
let dbPath: string;
let cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  shimDir = mkdtempSync(join(tmpdir(), "vs-block-shim-"));
  cacheDir = mkdtempSync(join(tmpdir(), "vs-block-cache-"));
  queueDir = mkdtempSync(join(tmpdir(), "vs-block-queue-"));
  dbPath = join(mkdtempSync(join(tmpdir(), "vs-block-db-")), "sessions.db");
});

afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
  await Promise.all([
    rm(shimDir, { recursive: true, force: true }),
    rm(cacheDir, { recursive: true, force: true }),
    rm(queueDir, { recursive: true, force: true }),
  ]);
});

async function repo(): Promise<string> {
  const { dir, cleanup } = await tempRepo();
  cleanups.push(cleanup);
  return dir;
}

/** A fake `codex` CLI on PATH: ignores its args (both the doctor smoke call AND
 *  the real audit invocation land here), always prints `reply`, exits 0. */
function writeCodexShim(reply: string): void {
  const p = join(shimDir, "codex");
  writeFileSync(p, `#!/bin/sh\necho '${reply}'\nexit 0\n`, "utf8");
  chmodSync(p, 0o755);
}

function makeGooseDb(rows: { sessionId: string; role: string; contentJson: string; ts: number }[]): void {
  const db = new DatabaseSync(dbPath);
  db.exec(
    `CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_timestamp INTEGER NOT NULL
    )`,
  );
  const insert = db.prepare(
    "INSERT INTO messages (session_id, role, content_json, created_timestamp) VALUES (?, ?, ?, ?)",
  );
  for (const r of rows) insert.run(r.sessionId, r.role, r.contentJson, r.ts);
  db.close();
}

const textBlock = (text: string) => JSON.stringify([{ type: "text", text }]);

async function hookStopBlock(dir: string, payload: object, env: Record<string, string> = {}) {
  const baseEnv = {
    // Hermetic PATH (no live codex/claude — same concern as test/resolve-auditor.test.ts):
    // shimDir first (so the fake `codex` wins over any real one further down), plus
    // ONLY the running node's own bin dir (tsx falls back to resolving `node` off
    // PATH, and node:sqlite in src/goose.ts needs the real Node 24+ interpreter,
    // not whatever /usr/bin/node happens to be) and bare system dirs. Deliberately
    // excludes the rest of the ambient PATH, where a real `claude` CLI lives on
    // this machine — resolveAuditor probes codex AND claude concurrently regardless
    // of which rule wins, so a real `claude` on PATH would mean a real API call.
    PATH: `${shimDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
    VS_DOCTOR_CACHE_PATH: join(cacheDir, "doctor.json"),
    VS_QUEUE_ROOT: queueDir,
    VS_GOOSE_SESSIONS_DB: dbPath,
    VS_EXECUTOR: "unknown",
  };
  const r = await execa(RUNNER, [CLI, "hook-stop-goose-block"], {
    cwd: dir,
    input: JSON.stringify(payload),
    reject: false,
    env: { ...baseEnv, ...env },
  });
  return { code: r.exitCode ?? 1, out: r.stdout, err: r.stderr };
}

const CONTRADICTED_REPLY =
  '{"claims":[{"claim":"all tests pass","verdict":"contradicted","basis":"no test run recorded in the receipts; git status shows uncommitted debug prints","evidence":"git status --porcelain"}],"demands":[],"unaccountable":false,"note":""}';
const SUPPORTED_REPLY =
  '{"claims":[{"claim":"added a reverse() helper","verdict":"supported","basis":"diff shows reverse() added and a matching test","evidence":"git diff"}],"demands":[],"unaccountable":false,"note":""}';

describe("hook-stop-goose-block — a contradicted verdict blocks the turn (exit 2 + stderr correction)", () => {
  it("over-claiming session ('all tests pass' with no verifying run) → exit 2, stderr names the claim + basis + the fix-it instruction", async () => {
    const dir = await repo();
    writeCodexShim(CONTRADICTED_REPLY);
    makeGooseDb([
      { sessionId: "s-overclaim", role: "user", contentJson: textBlock("run the test suite and report"), ts: 100 },
      { sessionId: "s-overclaim", role: "assistant", contentJson: textBlock("All tests pass."), ts: 101 },
    ]);

    const r = await hookStopBlock(dir, { event: "Stop", session_id: "s-overclaim", working_dir: dir });
    expect(r.code).toBe(2);
    expect(r.err).toContain("veritaserum:");
    expect(r.err).toContain("claim(s) not backed by a verification receipt");
    expect(r.err).toContain("all tests pass");
    expect(r.err).toContain("no test run recorded in the receipts");
    expect(r.err).toContain("Run the actual check and correct or retract before finishing.");
  });
});

describe("hook-stop-goose-block — a supported verdict lets the turn finish (exit 0)", () => {
  it("a claim backed by evidence → exit 0, no stderr", async () => {
    const dir = await repo();
    writeCodexShim(SUPPORTED_REPLY);
    makeGooseDb([
      { sessionId: "s-supported", role: "user", contentJson: textBlock("add a reverse() helper"), ts: 100 },
      { sessionId: "s-supported", role: "assistant", contentJson: textBlock("Done — added reverse(), with a test."), ts: 101 },
    ]);

    const r = await hookStopBlock(dir, { event: "Stop", session_id: "s-supported", working_dir: dir });
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
  });
});

describe("hook-stop-goose-block — R3 per-session block cap: never deadlock", () => {
  it("a session already at VS_BLOCK_CAP → exit 0 even on a contradicted verdict, and the auditor is never even invoked", async () => {
    const dir = await repo();
    // deliberately NO codex shim: proves the cap short-circuits before auditor resolution.
    makeGooseDb([
      { sessionId: "s-at-cap", role: "user", contentJson: textBlock("run the test suite"), ts: 100 },
      { sessionId: "s-at-cap", role: "assistant", contentJson: textBlock("All tests pass."), ts: 101 },
    ]);

    // queueRoot() reads process.env.VS_QUEUE_ROOT at call time — set it to the
    // same queueDir the child process gets (hookStopBlock's baseEnv) so the
    // pre-seeded block-count file lands where the CLI subprocess will look.
    const prevQueueRoot = process.env.VS_QUEUE_ROOT;
    process.env.VS_QUEUE_ROOT = queueDir;
    try {
      const qdir = queueRoot(dir);
      mkdirSync(join(qdir, "block-count"), { recursive: true });
      writeFileSync(join(qdir, "block-count", "s-at-cap.json"), JSON.stringify({ count: 2 }), "utf8");

      const r = await hookStopBlock(dir, { event: "Stop", session_id: "s-at-cap", working_dir: dir }, { VS_BLOCK_CAP: "2" });
      expect(r.code).toBe(0);
      expect(r.err).toBe("");
    } finally {
      if (prevQueueRoot === undefined) delete process.env.VS_QUEUE_ROOT;
      else process.env.VS_QUEUE_ROOT = prevQueueRoot;
    }
  });
});

describe("hook-stop-goose-block — R8 fail-open on a corrupt/missing session", () => {
  it("an unknown session_id (no rows in sessions.db) → exit 0, silent, never blocks", async () => {
    const dir = await repo();
    makeGooseDb([{ sessionId: "s-other", role: "user", contentJson: textBlock("hi"), ts: 100 }]);

    const r = await hookStopBlock(dir, { event: "Stop", session_id: "s-no-such-session", working_dir: dir });
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
  });

  it("a missing sessions.db file entirely → exit 0, silent, never blocks", async () => {
    const dir = await repo();
    const r = await hookStopBlock(
      dir,
      { event: "Stop", session_id: "s1", working_dir: dir },
      { VS_GOOSE_SESSIONS_DB: join(dir, "does-not-exist.db") },
    );
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
  });
});
