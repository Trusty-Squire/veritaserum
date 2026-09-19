/**
 * `veritaserum hook-stop-goose-block` — the SYNCHRONOUS BLOCKING goose Stop-hook
 * mode. A Stop hook exiting 2 with a reason on stderr BLOCKS turn-end. Hermetic:
 * fixture goose sessions.db + local Jev mock. No Claude/Codex/ollama auditor.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { execa } from "execa";
import { tempRepo, startJevMock, JEV_STATE_CONFAB, JEV_CLEAN } from "./helpers.js";
import { queueRoot } from "../src/audit-runner.js";

const CLI = resolve(import.meta.dirname, "../src/cli.ts");
const RUNNER = resolve(import.meta.dirname, "../node_modules/.bin/tsx");
const DatabaseSync: typeof DatabaseSyncType = createRequire(import.meta.url)("node:sqlite").DatabaseSync;

let cacheDir: string;
let queueDir: string;
let dbPath: string;
let cleanups: Array<() => Promise<void>> = [];
let jev: { url: string; close: () => Promise<void> } | undefined;

beforeEach(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), "vs-block-cache-"));
  queueDir = mkdtempSync(join(tmpdir(), "vs-block-queue-"));
  dbPath = join(mkdtempSync(join(tmpdir(), "vs-block-db-")), "sessions.db");
  jev = await startJevMock(JEV_STATE_CONFAB);
});

afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
  await jev?.close();
  jev = undefined;
  await Promise.all([
    rm(cacheDir, { recursive: true, force: true }),
    rm(queueDir, { recursive: true, force: true }),
  ]);
});

async function repo(): Promise<string> {
  const { dir, cleanup } = await tempRepo();
  cleanups.push(cleanup);
  return dir;
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
  const r = await execa(RUNNER, [CLI, "hook-stop-goose-block"], {
    cwd: dir,
    input: JSON.stringify(payload),
    reject: false,
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      VS_DOCTOR_CACHE_PATH: join(cacheDir, "doctor.json"),
      VS_QUEUE_ROOT: queueDir,
      VS_GOOSE_SESSIONS_DB: dbPath,
      VS_EXECUTOR: "unknown",
      TYPESAFE_API_KEY: "sk-test",
      VS_JEV_ENDPOINT: jev!.url,
      ...env,
    },
  });
  return { code: r.exitCode ?? 1, out: r.stdout, err: r.stderr };
}

describe("hook-stop-goose-block — a contradicted verdict blocks the turn (exit 2 + stderr correction)", () => {
  it("over-claiming session ('all tests pass' with no verifying run) → exit 2, stderr names the claim + the fix-it instruction", async () => {
    const dir = await repo();
    makeGooseDb([
      { sessionId: "s-overclaim", role: "user", contentJson: textBlock("run the test suite and report"), ts: 100 },
      { sessionId: "s-overclaim", role: "assistant", contentJson: textBlock("All tests pass."), ts: 101 },
    ]);

    const r = await hookStopBlock(dir, { event: "Stop", session_id: "s-overclaim", working_dir: dir });
    expect(r.code).toBe(2);
    expect(r.err).toContain("veritaserum:");
    expect(r.err).toContain("claim(s) not backed by the session's own evidence");
    expect(r.err).toMatch(/all tests pass/i);
    expect(r.err).toContain("Revise or retract before finishing.");
  });
});

describe("hook-stop-goose-block — a supported verdict lets the turn finish (exit 0)", () => {
  it("a claim Jev does not flag → exit 0, no stderr", async () => {
    await jev?.close();
    jev = await startJevMock(JEV_CLEAN);
    const dir = await repo();
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
  it("a session already at VS_BLOCK_CAP → exit 0 even on a contradicted verdict, and Jev is never even invoked", async () => {
    const dir = await repo();
    makeGooseDb([
      { sessionId: "s-at-cap", role: "user", contentJson: textBlock("run the test suite"), ts: 100 },
      { sessionId: "s-at-cap", role: "assistant", contentJson: textBlock("All tests pass."), ts: 101 },
    ]);

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
