/**
 * The v3 sync path (SPEC.md §2 "the mechanism", §1 R2/R3/R8): `veritaserum
 * hook-stop` is deterministic dispatch-only now — no claim regex, no LLM, and
 * it never emits a synchronous block decision (that died with the v1 CLI hook
 * contract; see test/transcript.test.ts for the removed transcript-claim
 * coverage). These tests drive the BUILT-FROM-SOURCE CLI as a real subprocess
 * (via tsx) so the stdin/stdout/exit-code contract is exercised end-to-end,
 * same as a harness would see it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { execa } from "execa";
import { tempRepo, write } from "./helpers.js";
import { queueRoot, lawCheckMarkerPath, type AuditJob } from "../src/audit-runner.js";
import { runAudit } from "../src/run-audit.js";
import { appendDemand } from "../src/law.js";
import { currentTreeHash } from "../src/git.js";
import { readFirings, type Firing } from "../src/telemetry.js";

const CLI = resolve(import.meta.dirname, "../src/cli.ts");
const RUNNER = resolve(import.meta.dirname, "../node_modules/.bin/tsx");
// See src/goose.ts for why this isn't a static `import ... from "node:sqlite"`.
const DatabaseSync: typeof DatabaseSyncType = createRequire(import.meta.url)("node:sqlite").DatabaseSync;

let queueRootTmp: string;
let telemetryPath: string;
let cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  queueRootTmp = mkdtempSync(join(tmpdir(), "vs-sync-queue-"));
  telemetryPath = join(mkdtempSync(join(tmpdir(), "vs-sync-telemetry-")), "telemetry.jsonl");
  process.env.VS_QUEUE_ROOT = queueRootTmp;
  process.env.VS_TELEMETRY_PATH = telemetryPath;
});

afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
  await rm(queueRootTmp, { recursive: true, force: true });
  delete process.env.VS_QUEUE_ROOT;
  delete process.env.VS_TELEMETRY_PATH;
});

async function repo(): Promise<string> {
  const { dir, cleanup } = await tempRepo();
  cleanups.push(cleanup);
  return dir;
}

async function hookStop(dir: string, payload: object, env: Record<string, string> = {}) {
  const r = await execa(RUNNER, [CLI, "hook-stop"], { cwd: dir, input: JSON.stringify(payload), reject: false, env });
  return { code: r.exitCode ?? 1, out: r.stdout, err: r.stderr };
}

/** Block audit-runner's triggerRunner from spawning a detached drain process —
 *  a live pid at the lockfile makes it a no-op — so an enqueued job file stays
 *  put for inspection instead of racing a background drain. */
function blockRunner(dir: string): void {
  const qdir = queueRoot(dir);
  mkdirSync(qdir, { recursive: true });
  writeFileSync(join(qdir, ".lock"), String(process.pid), "utf8");
}

function pendingJobs(dir: string): AuditJob[] {
  const qdir = queueRoot(dir);
  if (!existsSync(qdir)) return [];
  return readdirSync(qdir)
    .filter((f) => f.endsWith(".json") && f !== "last-audit.json") // last-audit.json is the sync-path marker, not a job
    .map((f) => JSON.parse(readFileSync(join(qdir, f), "utf8")) as AuditJob);
}

/** A minimal goose sessions.db fixture — same shape as ../src/goose.ts expects. */
function makeGooseDb(path: string, rows: { sessionId: string; role: string; contentJson: string; ts: number }[]): void {
  const db = new DatabaseSync(path);
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

describe("hook-stop — nothing-to-audit gate (SPEC §2 sync step 1, ~0ms path)", () => {
  it("goose: no tool-bearing message for the session → exit 0, silent, no job enqueued", async () => {
    const dir = await repo();
    const dbPath = join(dir, "sessions.db");
    makeGooseDb(dbPath, [{ sessionId: "s-idle", role: "user", contentJson: JSON.stringify([{ type: "text", text: "hi" }]), ts: 1000 }]);

    const r = await hookStop(dir, { event: "Stop", session_id: "s-idle", working_dir: dir }, { VS_GOOSE_SESSIONS_DB: dbPath });
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(pendingJobs(dir)).toHaveLength(0);
  });

  it("Claude Code: an unreadable/missing transcript_path → exit 0, silent, no job enqueued", async () => {
    const dir = await repo();
    const r = await hookStop(dir, { transcript_path: join(dir, "no-such-transcript.jsonl"), cwd: dir, stop_hook_active: false });
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(pendingJobs(dir)).toHaveLength(0);
  });
});

describe("hook-stop — enqueue (SPEC §2 sync step 3, payload parsing across harnesses)", () => {
  it("goose payload shape ({event, session_id, working_dir}) with tool activity → job enqueued with matching sessionId", async () => {
    const dir = await repo();
    blockRunner(dir);
    const dbPath = join(dir, "sessions.db");
    makeGooseDb(dbPath, [
      { sessionId: "s-active", role: "user", contentJson: JSON.stringify([{ type: "text", text: "do the thing" }]), ts: 1000 },
      {
        sessionId: "s-active",
        role: "assistant",
        contentJson: JSON.stringify([{ type: "toolRequest", id: "c1", toolCall: { value: { name: "shell", arguments: { command: "echo hi" } } } }]),
        ts: 1001,
      },
    ]);

    const r = await hookStop(dir, { event: "Stop", session_id: "s-active", working_dir: dir }, { VS_GOOSE_SESSIONS_DB: dbPath });
    expect(r.code).toBe(0);
    const jobs = pendingJobs(dir);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.sessionId).toBe("s-active");
    expect(jobs[0]!.mode).toBe("live"); // VS_AUDIT_MODE unset → default live
  });

  it("Claude Code payload shape ({transcript_path, cwd, stop_hook_active}) → job enqueued", async () => {
    const dir = await repo();
    blockRunner(dir);
    const tpath = join(dir, "transcript.jsonl");
    writeFileSync(tpath, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }) + "\n");

    const r = await hookStop(dir, { transcript_path: tpath, cwd: dir, stop_hook_active: false });
    expect(r.code).toBe(0);
    const jobs = pendingJobs(dir);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.sessionId).toBe(tpath); // no session_id on CC payloads — transcript path stands in
  });

  it("VS_AUDIT_MODE=testbed threads through to the enqueued job's mode", async () => {
    const dir = await repo();
    blockRunner(dir);
    const tpath = join(dir, "transcript.jsonl");
    writeFileSync(tpath, "seed content\n");

    const r = await hookStop(dir, { transcript_path: tpath, cwd: dir }, { VS_AUDIT_MODE: "testbed" });
    expect(r.code).toBe(0);
    expect(pendingJobs(dir)[0]!.mode).toBe("testbed");
  });
});

describe("hook-stop — standing-law state line (SPEC R7: terse, state-gated; precise, not once-only)", () => {
  const AUDITOR_ENV_KEYS = ["PATH", "VS_DOCTOR_CACHE_PATH", "VS_AUDITOR", "VS_AUDITOR_METERED", "OPENROUTER_API_KEY"] as const;

  /**
   * Run the REAL runAudit hermetically: PATH scrubbed to a fresh empty shim dir
   * + the bare system dirs `sh`/`git` need, no OPENROUTER_API_KEY/VS_AUDITOR* —
   * every auditor resolution rule fails, landing on the R8 floor
   * (`tier: "absent"`). Mechanical standing-law checks run regardless of
   * auditor availability (R8), which is exactly what's under test here: a
   * GREEN mechanical run is what clears cli.ts's terse-line marker, with no
   * real codex/claude/openrouter call involved.
   */
  async function runAuditHermetically(job: AuditJob): Promise<void> {
    const saved: Partial<Record<(typeof AUDITOR_ENV_KEYS)[number], string>> = {};
    for (const k of AUDITOR_ENV_KEYS) {
      const v = process.env[k];
      if (v !== undefined) saved[k] = v;
    }
    const shimDir = mkdtempSync(join(tmpdir(), "vs-sync-shim-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "vs-sync-cache-"));
    process.env.PATH = `${shimDir}:/usr/bin:/bin`;
    process.env.VS_DOCTOR_CACHE_PATH = join(cacheDir, "doctor.json");
    delete process.env.VS_AUDITOR;
    delete process.env.VS_AUDITOR_METERED;
    delete process.env.OPENROUTER_API_KEY;
    try {
      await runAudit(job);
    } finally {
      for (const k of AUDITOR_ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      await rm(shimDir, { recursive: true, force: true });
      await rm(cacheDir, { recursive: true, force: true });
    }
  }

  it("prints while unverified, falls silent once a GREEN mechanical run clears it, and resumes when the tree next moves", async () => {
    const dir = await repo();
    blockRunner(dir);
    await write(dir, "tracked.txt", "a");
    await execa("git", ["add", "-A"], { cwd: dir });
    await execa("git", ["commit", "-q", "-m", "tracked file"], { cwd: dir });

    await appendDemand(dir, { run: "true", rung: "oracle", originClaim: "claims it works" });
    await execa("git", ["add", "-A"], { cwd: dir });
    await execa("git", ["commit", "-q", "-m", "law"], { cwd: dir });

    const tpath = join(dir, "transcript.jsonl");
    writeFileSync(tpath, "turn 1\n");
    const EXPECTED = "veritaserum: 1 standing check(s) unverified against current tree";

    // Due: nothing has ever confirmed this tree state green.
    let r = await hookStop(dir, { transcript_path: tpath, cwd: dir });
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(EXPECTED);

    // STILL due on a later turn at the SAME tree state — unlike the old
    // once-per-hash print dedupe, nothing has actually verified this state
    // yet, so the line keeps firing (this is "precise instead of once-only").
    writeFileSync(tpath, "turn 1\nturn 2\n");
    r = await hookStop(dir, { transcript_path: tpath, cwd: dir });
    expect(r.out.trim()).toBe(EXPECTED);

    // A real GREEN mechanical run (the async audit job) clears the marker for
    // this exact tree state.
    await runAuditHermetically({ dir, sessionId: "s1", turnRef: "t-green", mode: "live", transcriptPath: tpath });
    expect(readFileSync(lawCheckMarkerPath(dir), "utf8").trim()).toBe(await currentTreeHash(dir));

    // Now silent at the same tree state — confirmed green.
    writeFileSync(tpath, "turn 1\nturn 2\nturn 3\n");
    r = await hookStop(dir, { transcript_path: tpath, cwd: dir });
    expect(r.out).toBe("");

    // Tree moves — due again; the green marker is stale for the new state.
    await write(dir, "tracked.txt", "b");
    writeFileSync(tpath, "turn 1\nturn 2\nturn 3\nturn 4\n");
    r = await hookStop(dir, { transcript_path: tpath, cwd: dir });
    expect(r.out.trim()).toBe(EXPECTED);
  });

  it("no runnable law entries → never prints, even with a dirty tree", async () => {
    const dir = await repo();
    blockRunner(dir);
    await write(dir, "tracked.txt", "a");
    await execa("git", ["add", "-A"], { cwd: dir });
    await execa("git", ["commit", "-q", "-m", "tracked file"], { cwd: dir });
    await write(dir, "tracked.txt", "b"); // dirty, but no law.yaml at all

    const tpath = join(dir, "transcript.jsonl");
    writeFileSync(tpath, "turn 1\n");
    const r = await hookStop(dir, { transcript_path: tpath, cwd: dir });
    expect(r.out).toBe("");
  });
});

describe("hook-stop — R8 fail-open (any internal error → exit 0, telemetry error event, never the harness's problem)", () => {
  it("a malformed payload that breaks path resolution still exits 0 and logs an error firing", async () => {
    const dir = await repo();
    // working_dir as a JSON number (not a string) breaks node:path's resolve()
    // deep inside queueRoot() — a real, un-contrived internal failure, not a mock.
    const r = await hookStop(dir, { working_dir: 12345 });
    expect(r.code).toBe(0);
    expect(r.out).toBe("");

    const firings: Firing[] = readFirings();
    const errors = firings.filter((f) => f.verdict === "error" && f.harness !== "audit-runner");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[errors.length - 1]!.blocked).toBe(false);
  });
});
