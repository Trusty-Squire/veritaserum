import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queueJob, queueRoot, runQueue, type AuditJob, type RunAudit } from "../src/audit-runner.js";

let root: string;
const dir = "/fake/repo/for/audit-runner-tests"; // never touched as a real path — only hashed for the queue key
const origRoot = process.env.VS_QUEUE_ROOT;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vs-queue-"));
  process.env.VS_QUEUE_ROOT = root;
});

afterEach(async () => {
  if (origRoot === undefined) delete process.env.VS_QUEUE_ROOT;
  else process.env.VS_QUEUE_ROOT = origRoot;
  await rm(root, { recursive: true, force: true });
});

function job(sessionId: string, turnRef: string, mode: AuditJob["mode"]): AuditJob {
  return { dir, sessionId, turnRef, mode };
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
});
