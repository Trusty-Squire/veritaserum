#!/usr/bin/env node
/** Minimal CommonJS Stop entry point: cold-start budget is part of correctness. */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

interface HookPayload {
  session_id?: string;
  working_dir?: string;
  transcript_path?: string | null;
  cwd?: string;
  turn_id?: string;
  last_assistant_message?: string | null;
}

interface LastAudit {
  ts: number;
  ccTranscriptSize?: Record<string, number>;
}

interface AuditJob {
  dir: string;
  sessionId: string;
  turnRef: string;
  mode: "live" | "testbed";
  transcriptPath?: string;
  finalMessage?: string;
  harness?: string;
  executor?: string;
  auditor?: string;
  demandMode?: "script" | "urge";
}

function repoKey(dir: string): string {
  return createHash("sha256").update(resolve(dir)).digest("hex").slice(0, 16);
}

function queueRoot(dir: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || require("node:os").homedir();
  return join(process.env.VS_QUEUE_ROOT || join(home, ".veritaserum", "queue"), repoKey(dir));
}

function statePath(dir: string, name: string): string {
  return join(queueRoot(dir), "state", name);
}

function readLastAudit(dir: string): LastAudit {
  try {
    return JSON.parse(readFileSync(statePath(dir, "last-audit.json"), "utf8")) as LastAudit;
  } catch {
    return { ts: 0 };
  }
}

function writeLastAudit(dir: string, value: LastAudit): void {
  try {
    const path = statePath(dir, "last-audit.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value), "utf8");
  } catch {
    // Re-auditing after a lost watermark is safer than failing the hook.
  }
}

function transcriptActivity(path: string, marker: LastAudit): boolean {
  try {
    return statSync(path).size > (marker.ccTranscriptSize?.[path] ?? 0);
  } catch {
    return false;
  }
}

function gooseActivity(sessionId: string, sinceMs: number): boolean {
  const home = process.env.HOME || process.env.USERPROFILE || require("node:os").homedir();
  const dbPath = process.env.VS_GOOSE_SESSIONS_DB || join(home, ".local", "share", "goose", "sessions", "sessions.db");
  if (!existsSync(dbPath)) return false;
  let db: InstanceType<typeof DatabaseSyncType> | undefined;
  try {
    const DatabaseSync: typeof DatabaseSyncType = require("node:sqlite").DatabaseSync;
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND created_timestamp > ?")
      .get(sessionId, Math.floor(sinceMs / 1000)) as { n?: number } | undefined;
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // Best-effort read-only handle cleanup.
    }
  }
}

/** Mirrors src/git.ts's porcelainStatusEntries — rename/copy records carry a
 *  second NUL-separated origin-path field that a plain split would misread. */
function porcelainStatusPaths(stdout: string): string[] {
  const fields = stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (!record) continue;
    const hasPrefix = record.length > 3 && record[2] === " ";
    paths.push(hasPrefix ? record.slice(3) : record);
    if (hasPrefix && /[RC]/.test(record.slice(0, 2))) i++;
  }
  return paths;
}

/** MUST stay byte-identical to src/git.ts's currentTreeHash — this compares
 *  against the last-green marker src/run-audit.ts writes with that hash. */
function currentTreeHash(dir: string): string | null {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const stdout = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const hash = createHash("sha256").update(stdout).update("\0");
    for (const path of porcelainStatusPaths(stdout)) {
      try {
        const stat = statSync(join(dir, path), { bigint: true });
        hash.update(`${path}\0${stat.size}\0${stat.mtimeNs}\0${stat.mode}\0`);
      } catch {
        hash.update(`${path}\0missing\0`);
      }
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

/**
 * The R7 terse state line: standing law exists and the tree hasn't been
 * confirmed green at its current state. Reads the runnable-check count cached
 * by `veritaserum install` / each audit (src/hook-state.ts) so the fast hook
 * never loads the law file; the single git spawn runs only when that cached
 * count is nonzero. Best-effort — never blocks the hook.
 */
function printLawStateLineIfDue(dir: string): void {
  try {
    const state = JSON.parse(readFileSync(statePath(dir, "law.json"), "utf8")) as { runnableCount?: number };
    const count = state.runnableCount;
    if (typeof count !== "number" || count <= 0) return;
    let lastGreen = "";
    try {
      lastGreen = readFileSync(join(queueRoot(dir), "law-check-hash.txt"), "utf8").trim();
    } catch {
      // No green run recorded yet — the line is due.
    }
    const hash = currentTreeHash(dir);
    if (hash === null || hash === lastGreen) return;
    const line = `veritaserum: ${count} standing check(s) unverified against current tree`;
    // Codex Stop rejects plain stdout even on exit 0; systemMessage is the
    // documented non-blocking output field. Claude Code accepts the terse text.
    process.stdout.write((process.env.VS_HARNESS === "codex" ? JSON.stringify({ systemMessage: line }) : line) + "\n");
  } catch {
    // Advisory only (R8).
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function enqueue(job: AuditJob): boolean {
  const qdir = queueRoot(job.dir);
  mkdirSync(join(qdir, "dead"), { recursive: true });
  const file = join(
    qdir,
    `${Date.now().toString().padStart(14, "0")}-${process.pid}-${process.hrtime.bigint()}__${job.sessionId.replace(/[^a-zA-Z0-9._-]/g, "_")}__${job.turnRef.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`,
  );
  writeFileSync(file, JSON.stringify(job), "utf8");
  const lock = join(qdir, ".lock");
  try {
    const held = Number(readFileSync(lock, "utf8").trim());
    if (Number.isFinite(held) && isAlive(held)) return false;
  } catch {
    // Let an exclusive runner decide ownership.
  }
  return true;
}

function startRunner(dir: string): void {
  const runner = join(__dirname, "audit-runner.js");
  // A burst of turn-end hooks must not compete with the first detached child's
  // expensive ESM/module startup. A tiny async launch delay keeps that work off
  // every parent's <50ms critical path; the queue is already durable on disk.
  const child = spawn(
    "sh",
    ["-c", 'sleep 0.05; exec "$@"', "veritaserum-runner", process.execPath, runner, "--vs-audit-runner", dir],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  if (process.env.VS_AUDIT_CHILD === "1") return;
  try {
    const parsed = JSON.parse(await readStdin()) as unknown;
    const p: HookPayload = parsed && typeof parsed === "object" ? (parsed as HookPayload) : {};
    const dir = p.working_dir || p.cwd || process.cwd();
    const marker = readLastAudit(dir);
    const active = p.transcript_path
      ? transcriptActivity(p.transcript_path, marker)
      : p.session_id
        ? gooseActivity(p.session_id, marker.ts)
        : false;
    if (!active) return;
    printLawStateLineIfDue(dir);
    const harness = process.env.VS_HARNESS || "unknown";
    const now = Date.now();
    const shouldStartRunner = enqueue({
      dir,
      sessionId: p.session_id || p.transcript_path || dir,
      turnRef: p.turn_id || String(now),
      mode: process.env.VS_AUDIT_MODE === "testbed" ? "testbed" : "live",
      ...(p.transcript_path ? { transcriptPath: p.transcript_path } : {}),
      ...(typeof p.last_assistant_message === "string" ? { finalMessage: p.last_assistant_message } : {}),
      harness,
      executor: process.env.VS_EXECUTOR || "unknown",
      ...(process.env.VS_AUDITOR ? { auditor: process.env.VS_AUDITOR } : {}),
      demandMode: process.env.VS_DEMAND_MODE === "urge" ? "urge" : "script",
    });
    const next: LastAudit = { ts: now, ccTranscriptSize: marker.ccTranscriptSize };
    if (p.transcript_path) {
      // Guarded individually (like cli.ts's hook-stop): a transcript deleted
      // between the activity check and here must not abort the runner start.
      try {
        next.ccTranscriptSize = { ...next.ccTranscriptSize, [p.transcript_path]: statSync(p.transcript_path).size };
      } catch {
        // Best-effort watermark — re-auditing is safer than a lost runner start.
      }
    }
    writeLastAudit(dir, next);
    // Start expensive module loading only after every synchronous hook task has
    // completed, so the auditor child cannot steal the hook's latency budget.
    if (shouldStartRunner) startRunner(dir);
  } catch {
    // R8: every internal error is silent and exits zero.
  }
}

void main();
