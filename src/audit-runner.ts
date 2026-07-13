/**
 * Async audit dispatch (SPEC.md §2 "audit scheduling", §6.3): a single,
 * lockfile-serialized runner per repo drains a job queue. The actual audit is a
 * caller-injected function (`RunAudit`) — this module is only the dispatcher;
 * another surface (the auditor) supplies the real work.
 *
 * LIVE mode supersedes: a fresher turn-end for the same session makes an
 * older, not-yet-started job for that session noise (SPEC §2) — it's dropped,
 * never run. TESTBED mode drains every job, in enqueue order (§6.6 needs every
 * turn audited). Crash safety: the lock is released on exit or error, a job
 * that throws is moved to dead/ with its error, and the entry point (runQueue)
 * NEVER throws — any internal error becomes an R8 telemetry error event.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logFiring } from "./telemetry.js";

export interface AuditJob {
  /** The repo this turn happened in — runAudit's own git probes and law reads run here. */
  dir: string;
  sessionId: string;
  turnRef: string;
  mode: "live" | "testbed";
  /** Claude Code only: the transcript path from the Stop hook payload. Its
   *  presence is how runAudit (src/run-audit.ts) tells a Claude Code turn
   *  (read via src/transcript.ts) apart from a goose turn (sessionId keys
   *  goose's own sessions.db, read via src/goose.ts). */
  transcriptPath?: string;
  /** Codex Stop supplies the final text directly. Its transcript format is not a
   * public contract, so never discard this documented payload field. */
  finalMessage?: string;
  userRequest?: string;
  /** Resolution and telemetry context belongs to the turn, not to whichever
   * detached runner wins the per-repo drain race. */
  harness?: string;
  executor?: string;
  auditor?: string;
  demandMode?: "script" | "urge";
}
export type RunAudit = (job: AuditJob) => Promise<void>;

interface QueuedJob {
  file: string;
  job: AuditJob;
}

// --- locations -----------------------------------------------------------------

/** Stable per-repo key so unrelated repos never share a queue directory. */
export function repoKey(dir: string): string {
  return createHash("sha256").update(resolve(dir)).digest("hex").slice(0, 16);
}

/** ~/.veritaserum/queue/<repo-key> (VS_QUEUE_ROOT overrides the root — tests use this). */
export function queueRoot(dir: string): string {
  const root = process.env.VS_QUEUE_ROOT || join(homedir(), ".veritaserum", "queue");
  return join(root, repoKey(dir));
}
function lockPath(qdir: string): string {
  return join(qdir, ".lock");
}
/**
 * ~/.veritaserum/queue/<repo-key>/law-check-hash.txt — the tree hash at the
 * last GREEN mechanical standing-law run (src/run-audit.ts writes it once all
 * runnable checks pass). src/cli.ts's terse state line reads it to decide
 * whether standing law is still unverified against the current tree (SPEC
 * R7) — precise ("still not confirmed since the tree moved"), not a
 * once-per-hash print dedupe.
 */
export function lawCheckMarkerPath(dir: string): string {
  return join(queueRoot(dir), "law-check-hash.txt");
}
function deadDir(qdir: string): string {
  return join(qdir, "dead");
}
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * R5 session warning store (SPEC §6.5): ~/.veritaserum/queue/<repo-key>/warnings/
 * <session>.json — the warning lines already surfaced to this session, so
 * run-audit.ts can pass them as `priorWarnings` and the same claim's warning
 * never repeats verbatim within one session. Scoped per session id, so a
 * different session (or a different repo, via queueRoot's repo-key) is never
 * suppressed by another session's warnings.
 */
export function sessionWarningsPath(dir: string, sessionId: string): string {
  return join(queueRoot(dir), "warnings", `${sanitize(sessionId)}.json`);
}

/** Best-effort read (R8): a missing or corrupt store is just "no warnings yet". */
export function loadSessionWarnings(dir: string, sessionId: string): string[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(sessionWarningsPath(dir, sessionId), "utf8"));
    return Array.isArray(raw) ? raw.filter((w): w is string => typeof w === "string") : [];
  } catch {
    return [];
  }
}

/** Best-effort merge-append (R8): never throws, never blocks the audit on a write failure. */
export function appendSessionWarnings(dir: string, sessionId: string, warnings: string[]): void {
  if (!warnings.length) return;
  try {
    const p = sessionWarningsPath(dir, sessionId);
    mkdirSync(dirname(p), { recursive: true });
    const merged = [...new Set([...loadSessionWarnings(dir, sessionId), ...warnings])];
    writeFileSync(p, JSON.stringify(merged), "utf8");
  } catch {
    /* best-effort (R8) */
  }
}

/**
 * Claude Code feedback channel (SPEC §2 "Feedback channels", R7): one pending
 * feedback line per REPO (not per session — the queue root is already keyed by
 * repoKey), latest-wins. run-audit.ts writes here when a verdict has
 * warnings/demands/unaccountable; cli.ts's `hook-prompt` case reads + clears it
 * at the next UserPromptSubmit so it injects exactly once.
 *
 * Lives under a `feedback/` subdirectory, NOT directly in queueRoot — listPending()
 * (the drain loop, below) scans every top-level `*.json` in queueRoot as a
 * candidate job file; a stray sibling file there would be misread as a
 * malformed job (same reason session warnings live under `warnings/`).
 */
export function pendingFeedbackPath(dir: string): string {
  return join(queueRoot(dir), "feedback", "pending.json");
}

interface PendingFeedback {
  /** epoch ms when the verdict landed — staleness (SPEC R7: <24h) is judged from this. */
  ts: number;
  /** the exact terse line to print (already R7-shaped by run-audit.ts). */
  line: string;
}

const PENDING_FEEDBACK_MAX_AGE_MS = 24 * 60 * 60 * 1000; // R7: "non-stale (< 24h)"

/** Best-effort write (R8): latest-wins — a fresh verdict always overwrites whatever
 *  was pending, since a newer turn's feedback supersedes an older unread one. */
export function writePendingFeedback(dir: string, line: string): void {
  try {
    const p = pendingFeedbackPath(dir);
    mkdirSync(dirname(p), { recursive: true });
    const payload: PendingFeedback = { ts: Date.now(), line };
    writeFileSync(p, JSON.stringify(payload), "utf8");
  } catch {
    /* best-effort (R8) */
  }
}

/**
 * Read + unconditionally clear pending feedback (R8: corrupt/stale is consumed
 * too, never left to wedge future turns). Returns null when absent, corrupt, or
 * stale (>= 24h) — only a present, parseable, fresh line is injected.
 */
export function takePendingFeedback(dir: string): string | null {
  const p = pendingFeedbackPath(dir);
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return null; // nothing pending
  }
  rmSafely(p);
  try {
    const parsed = JSON.parse(raw) as Partial<PendingFeedback>;
    if (typeof parsed.line !== "string" || typeof parsed.ts !== "number") return null; // corrupt (R8)
    if (Date.now() - parsed.ts >= PENDING_FEEDBACK_MAX_AGE_MS) return null; // stale
    return parsed.line;
  } catch {
    return null; // corrupt (R8)
  }
}

let seqCounter = 0;
function nextSeq(): string {
  seqCounter += 1;
  // wall-clock primary key (cross-process rough ordering) + a monotonic
  // in-process counter tie-break (guarantees strict ordering for back-to-back
  // enqueues within one process, e.g. the same audit run enqueuing supersedes).
  return `${Date.now().toString().padStart(14, "0")}-${process.pid}-${seqCounter.toString().padStart(6, "0")}-${randomUUID().slice(0, 8)}`;
}

// --- enqueue ---------------------------------------------------------------------

/** Write a job file (no spawn) — the pure half, used directly by tests. */
export function queueJob(dir: string, job: AuditJob): string {
  const qdir = queueRoot(dir);
  mkdirSync(qdir, { recursive: true });
  mkdirSync(deadDir(qdir), { recursive: true });
  const file = join(qdir, `${nextSeq()}__${sanitize(job.sessionId)}__${sanitize(job.turnRef)}.json`);
  writeFileSync(file, JSON.stringify(job), "utf8");
  return file;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Spawn the detached runner, unless one is already draining this repo's queue
 *  (in which case its own loop will pick up the freshly-written job file). */
function triggerRunner(dir: string): void {
  const qdir = queueRoot(dir);
  const lp = lockPath(qdir);
  if (existsSync(lp)) {
    const held = Number(readFileSync(lp, "utf8").trim());
    if (Number.isFinite(held) && isAlive(held)) return;
  }
  const self = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [self, "--vs-audit-runner", dir], { detached: true, stdio: "ignore" });
  child.unref();
}

/** Enqueue a job and (best-effort) trigger the runner. Never throws (R8). */
export function enqueue(dir: string, job: AuditJob): void {
  try {
    queueJob(dir, job);
    triggerRunner(dir);
  } catch (err) {
    logFiring({
      harness: "audit-runner",
      event: "verify",
      claim: `enqueue ${job.sessionId}/${job.turnRef}`,
      verdict: "error",
      caught: err instanceof Error ? err.message : String(err),
      blocked: false,
      dir,
    });
  }
}

// --- drain -----------------------------------------------------------------------

function listPending(qdir: string): QueuedJob[] {
  if (!existsSync(qdir)) return [];
  return readdirSync(qdir)
    .filter((f) => f.endsWith(".json") && f.includes("__")) // only enqueue-pattern names (<seq>__<session>__<turn>.json): the queue root also holds non-job state files, and one parsed as an empty job "succeeds" vacuously and gets deleted (this silently killed live auditing)
    .sort()
    .flatMap((f) => {
      const file = join(qdir, f);
      try {
        const job = JSON.parse(readFileSync(file, "utf8")) as AuditJob;
        if (typeof job.dir !== "string" || typeof job.sessionId !== "string") return []; // not a job — never list it, never delete it
        return [{ file, job }];
      } catch {
        return []; // unreadable/corrupt job file — skip, don't wedge the drain
      }
    });
}

function rmSafely(p: string): void {
  try {
    rmSync(p, { force: true });
  } catch {
    /* best-effort */
  }
}

/** Move an errored job to dead/ with its error message alongside — never deleted. */
function moveToDead(qdir: string, q: QueuedJob, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const base = q.file.slice(qdir.length + 1);
  try {
    renameSync(q.file, join(deadDir(qdir), base));
    writeFileSync(join(deadDir(qdir), `${base}.error.txt`), message, "utf8");
  } catch {
    rmSafely(q.file); // even the move failed — don't leave a half-processed job wedging the queue
  }
  logFiring({
    harness: "audit-runner",
    event: "verify",
    claim: `audit job ${q.job.sessionId}/${q.job.turnRef}`,
    verdict: "error",
    caught: message,
    blocked: false,
    dir: qdir,
  });
}

/** LIVE mode: dropped (never run) if a newer pending job shares its sessionId. */
function isSuperseded(job: AuditJob, rest: QueuedJob[]): boolean {
  return job.mode === "live" && rest.some((q) => q.job.sessionId === job.sessionId);
}

async function drain(qdir: string, runAudit: RunAudit): Promise<void> {
  for (;;) {
    const pending = listPending(qdir);
    const head = pending[0];
    if (!head) return;
    if (isSuperseded(head.job, pending.slice(1))) {
      rmSafely(head.file); // superseded — dropped, not run, not an error
      continue;
    }
    try {
      await runAudit(head.job);
      rmSafely(head.file);
    } catch (err) {
      moveToDead(qdir, head, err);
    }
  }
}

/**
 * Acquire the queue's lockfile (stale-lock reclaim via a liveness check on the
 * held pid), run `fn`, then release. Returns without running `fn` if another
 * live runner already holds the lock — that runner's own loop will drain any
 * job enqueued meanwhile.
 */
async function withLock(qdir: string, fn: () => Promise<void>): Promise<void> {
  const lp = lockPath(qdir);
  try {
    writeFileSync(lp, String(process.pid), { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    let held = Number.NaN;
    try {
      held = Number(readFileSync(lp, "utf8").trim());
    } catch {
      /* a concurrent owner may be between create and write */
    }
    if (Number.isFinite(held) && isAlive(held)) return;
    // A stale owner cannot remove a newer owner's lock: the exclusive retry below
    // either wins exactly once or observes another contender and returns.
    rmSafely(lp);
    try {
      writeFileSync(lp, String(process.pid), { encoding: "utf8", flag: "wx" });
    } catch (retryErr) {
      if ((retryErr as NodeJS.ErrnoException).code === "EEXIST") return;
      throw retryErr;
    }
  }
  try {
    await fn();
  } finally {
    try {
      const owner = Number(readFileSync(lp, "utf8").trim());
      if (owner === process.pid) rmSafely(lp);
    } catch {
      /* lock already gone */
    }
  }
}

/**
 * Drain this repo's queue. NEVER throws (R8): any internal error is swallowed
 * and recorded as telemetry so a broken dispatcher never stalls the executor.
 */
export async function runQueue(dir: string, runAudit: RunAudit): Promise<void> {
  const qdir = queueRoot(dir);
  try {
    mkdirSync(qdir, { recursive: true });
    mkdirSync(deadDir(qdir), { recursive: true });
    await withLock(qdir, () => drain(qdir, runAudit));
  } catch (err) {
    logFiring({
      harness: "audit-runner",
      event: "verify",
      claim: "runQueue",
      verdict: "error",
      caught: err instanceof Error ? err.message : String(err),
      blocked: false,
      dir,
    });
  }
}

// --- detached-child bootstrap ------------------------------------------------------
// When spawned by triggerRunner, resolve the real auditor from VS_AUDIT_RUNNER_MODULE
// (a runtime-only specifier — deliberately not a static import, so this dispatcher
// has no compile-time dependency on whichever module ends up implementing RunAudit)
// if set, else the built run-audit module sitting alongside this one in dist/ —
// a plain sibling import specifier resolves whether this file is dist/audit-runner.js
// (the normal case: spawn only actually runs a built, executable file) or a future
// bundling layout, no pkgRoot()-style absolute-path guessing needed.
// Any resolution failure falls open to a no-op auditor (R8) rather than crashing.

function defaultRunAuditModule(): string {
  return new URL("./run-audit.js", import.meta.url).href;
}

async function bootstrap(): Promise<void> {
  const i = process.argv.indexOf("--vs-audit-runner");
  const dir = i === -1 ? undefined : process.argv[i + 1];
  if (!dir) return;
  let runAudit: RunAudit = async () => {};
  const modSpec = process.env.VS_AUDIT_RUNNER_MODULE || defaultRunAuditModule();
  try {
    const mod = (await import(modSpec)) as { runAudit?: RunAudit };
    if (typeof mod.runAudit === "function") runAudit = mod.runAudit;
  } catch {
    /* R8: no auditor available — mechanical dispatch still runs, job(s) no-op */
  }
  await runQueue(dir, runAudit);
}

if (process.argv[1] && (() => {
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  } catch {
    return false;
  }
})()) {
  void bootstrap();
}
