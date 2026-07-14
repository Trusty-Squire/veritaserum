import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdirSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queueJob, queueRoot, runQueue, type AuditJob, type RunAudit } from "../src/audit-runner.js";

let root: string;
// chmod-based denial is a no-op for uid 0: the kernel ignores permission bits
// for root, so these scenarios cannot be staged there.
const runningAsRoot = process.getuid?.() === 0;
const dir = "/fake/repo/for/audit-runner-tests"; // never touched as a real path — only hashed for the queue key
const origRoot = process.env.VS_QUEUE_ROOT;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vs-queue-"));
  process.env.VS_QUEUE_ROOT = root;
});

afterEach(async () => {
  if (origRoot === undefined) delete process.env.VS_QUEUE_ROOT;
  else process.env.VS_QUEUE_ROOT = origRoot;
  try {
    chmodSync(root, 0o755);
  } catch {
    /* best-effort cleanup */
  }
  await rm(root, { recursive: true, force: true });
});

function job(sessionId: string, turnRef: string, mode: AuditJob["mode"]): AuditJob {
  return { dir, sessionId, turnRef, mode };
}

function addQueueNoise(qdir: string, count: number): void {
  mkdirSync(qdir, { recursive: true });
  for (let i = 0; i < count; i++) {
    writeFileSync(
      join(qdir, `${String(i).padStart(13, "0")}__noise__${i}.json`),
      JSON.stringify({ noise: i, payload: "x".repeat(128) }),
    );
  }
}

describe("runQueue — TESTBED drain", () => {
  it("drains every job, in enqueue order, regardless of session", async () => {
    queueJob(dir, job("s1", "t1", "testbed"));
    queueJob(dir, job("s1", "t2", "testbed"));
    queueJob(dir, job("s2", "t3", "testbed"));

    const ran: string[] = [];
    await runQueue(dir, async (j) => {
      ran.push(j.turnRef);
    });

    expect(ran).toEqual(["t1", "t2", "t3"]);
    const qdir = queueRoot(dir);
    expect(readdirSync(qdir).filter((f) => f.endsWith(".json"))).toHaveLength(0);
  });
});

describe("runQueue — LIVE supersede", () => {
  it("drops older queued jobs for the same session; only the newest runs", async () => {
    queueJob(dir, job("s1", "t1", "live"));
    queueJob(dir, job("s1", "t2", "live"));
    queueJob(dir, job("s1", "t3", "live"));

    const ran: string[] = [];
    await runQueue(dir, async (j) => {
      ran.push(j.turnRef);
    });

    expect(ran).toEqual(["t3"]);
    const qdir = queueRoot(dir);
    expect(readdirSync(qdir).filter((f) => f.endsWith(".json"))).toHaveLength(0); // dropped, not left behind
  });

  it("does not supersede across different sessions", async () => {
    queueJob(dir, job("s1", "t1", "live"));
    queueJob(dir, job("s2", "t2", "live"));

    const ran: string[] = [];
    await runQueue(dir, async (j) => {
      ran.push(j.turnRef);
    });

    expect(ran.sort()).toEqual(["t1", "t2"]);
  });
});

describe("runQueue — crash safety (R8)", () => {
  it("a job that throws is moved to dead/ with its error; the drain keeps going; the lock is released", async () => {
    queueJob(dir, job("s1", "bad", "testbed"));
    queueJob(dir, job("s2", "good", "testbed"));

    const ran: string[] = [];
    await runQueue(dir, async (j) => {
      if (j.turnRef === "bad") throw new Error("audit blew up");
      ran.push(j.turnRef);
    });

    expect(ran).toEqual(["good"]);
    const qdir = queueRoot(dir);
    expect(existsSync(join(qdir, ".lock"))).toBe(false);
    const deadFiles = readdirSync(join(qdir, "dead"));
    expect(deadFiles.some((f) => f.includes("bad") && f.endsWith(".json"))).toBe(true);
    expect(deadFiles.some((f) => f.endsWith(".error.txt"))).toBe(true);
  });

  it("the runner survives a crashed job — a later runQueue call processes normally", async () => {
    queueJob(dir, job("s1", "bad", "testbed"));
    await runQueue(dir, async () => {
      throw new Error("boom");
    });

    queueJob(dir, job("s2", "next", "testbed"));
    const ran: string[] = [];
    await runQueue(dir, async (j) => {
      ran.push(j.turnRef);
    });
    expect(ran).toEqual(["next"]);
  });

  it("runQueue never throws even if runAudit is pathological", async () => {
    queueJob(dir, job("s1", "t1", "testbed"));
    await expect(
      runQueue(dir, async () => {
        throw new Error("nope");
      }),
    ).resolves.toBeUndefined();
  });
});

describe("runQueue — lock", () => {
  function freezeQueueAfterLock(qdir: string) {
    return spawn(
      process.execPath,
      [
        "-e",
        `
const fs = require("node:fs");
const path = require("node:path");
const qdir = process.argv[1];
const lock = path.join(qdir, ".lock");
const deadline = Date.now() + 5000;
(function poll() {
  try {
    if (fs.existsSync(lock)) {
      fs.chmodSync(qdir, 0o555);
      setTimeout(() => {
        try { fs.chmodSync(qdir, 0o755); } catch {}
        process.exit(0);
      }, 650);
      return;
    }
  } catch {}
  if (Date.now() > deadline) process.exit(2);
  setTimeout(poll, 1);
})();
        `,
        qdir,
      ],
      { stdio: "ignore" },
    );
  }

  it("a stale lock (dead pid) is reclaimed rather than blocking forever", async () => {
    const qdir = queueRoot(dir);
    mkdirSync(qdir, { recursive: true });
    // A pid guaranteed to be dead: spawn a child synchronously, capture its
    // pid, and only use it after the process has already exited.
    const { pid } = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    writeFileSync(join(qdir, ".lock"), String(pid), "utf8");

    queueJob(dir, job("s1", "t1", "testbed"));
    const ran: string[] = [];
    await runQueue(dir, async (j) => {
      ran.push(j.turnRef);
    });

    expect(ran).toEqual(["t1"]);
    expect(existsSync(join(qdir, ".lock"))).toBe(false);
  });

  it("serializes two concurrent runQueue calls — jobs never run concurrently, none are lost", async () => {
    queueJob(dir, job("s1", "t1", "testbed"));
    queueJob(dir, job("s2", "t2", "testbed"));

    let concurrent = 0;
    let maxConcurrent = 0;
    const ran: string[] = [];
    const slow: RunAudit = async (j) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 30));
      ran.push(j.turnRef);
      concurrent--;
    };

    await Promise.all([runQueue(dir, slow), runQueue(dir, slow)]);

    expect(maxConcurrent).toBe(1); // never two jobs (or two drains) running at once
    expect(ran.sort()).toEqual(["t1", "t2"]); // both jobs still got processed by whichever runner held the lock
  });

  it.skipIf(runningAsRoot)("backs off and terminates when a real filesystem race blocks queue claiming", async () => {
    const qdir = queueRoot(dir);
    mkdirSync(qdir, { recursive: true });
    addQueueNoise(qdir, 8000);
    queueJob(dir, job("s1", "t1", "testbed"));

    const freezer = freezeQueueAfterLock(qdir);
    const exit = new Promise<number | null>((resolve) => {
      freezer.once("exit", (code) => resolve(code));
    });

    const ran: string[] = [];
    const started = Date.now();
    await runQueue(dir, async (j) => {
      ran.push(j.turnRef);
    });
    const elapsed = Date.now() - started;

    freezer.kill("SIGKILL");
    await exit;
    chmodSync(qdir, 0o755);

    expect(ran).toEqual([]);
    expect(elapsed).toBeLessThan(2_000);
    expect(readdirSync(qdir).some((name) => name.endsWith(".json"))).toBe(true);
  });

  it.skipIf(runningAsRoot)("backs off and terminates when a superseded head cannot be removed", async () => {
    const qdir = queueRoot(dir);
    mkdirSync(qdir, { recursive: true });
    addQueueNoise(qdir, 8000);
    queueJob(dir, job("s1", "t1", "live"));
    queueJob(dir, job("s1", "t2", "live"));

    const freezer = freezeQueueAfterLock(qdir);
    const exit = new Promise<number | null>((resolve) => {
      freezer.once("exit", (code) => resolve(code));
    });

    const ran: string[] = [];
    const started = Date.now();
    await runQueue(dir, async (j) => {
      ran.push(j.turnRef);
    });
    const elapsed = Date.now() - started;

    freezer.kill("SIGKILL");
    await exit;
    chmodSync(qdir, 0o755);

    expect(ran).toEqual([]);
    expect(elapsed).toBeLessThan(2_000);
    expect(readdirSync(qdir).filter((name) => name.endsWith(".json")).length).toBeGreaterThan(0);
  });
});

describe("listPending hygiene — the drain must never consume non-job JSON (the silent-sentinel bug)", () => {
  it("leaves the sync-path watermark and foreign JSON untouched while consuming real jobs", async () => {
    const qdir = queueRoot(dir);
    mkdirSync(join(qdir, "state"), { recursive: true });
    queueJob(dir, job("s1", "t1", "live"));
    // The exact file the drain used to eat: the sync-path watermark, plus an
    // arbitrary foreign JSON. Neither matches the enqueue pattern.
    writeFileSync(join(qdir, "last-audit.json"), JSON.stringify({ ts: 42 }));
    writeFileSync(join(qdir, "state", "last-audit.json"), JSON.stringify({ ts: 77 }));
    writeFileSync(join(qdir, "notes.json"), JSON.stringify({ foo: 1 }));
    // Enqueue-pattern name but not a job shape: listed by filename, rejected by validation.
    writeFileSync(join(qdir, "0000000000000-01__x__y.json"), JSON.stringify({ nope: true }));

    const ran: string[] = [];
    await runQueue(dir, async (j) => {
      ran.push(j.turnRef);
    });

    expect(ran).toEqual(["t1"]);
    expect(existsSync(join(qdir, "last-audit.json"))).toBe(true);
    expect(existsSync(join(qdir, "state", "last-audit.json"))).toBe(true);
    expect(existsSync(join(qdir, "notes.json"))).toBe(true);
    expect(existsSync(join(qdir, "0000000000000-01__x__y.json"))).toBe(true);
    expect(readdirSync(join(qdir, "dead"))).toEqual([]);
  });
});
