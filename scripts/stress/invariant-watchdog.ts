#!/usr/bin/env node
/**
 * Production invariant watchdog.
 *
 * This is deliberately a separate process from the stress driver. It observes the same
 * scratch HOME, repo, queue, telemetry, transcripts, and /proc process tree that a real
 * install uses. It never imports product code and never redirects veritaserum's state
 * paths, so it cannot accidentally make a broken install look healthy.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

interface ExpectedTurn {
  id: string;
  harness: "claude-code" | "codex" | "goose";
  repo: string;
  transcriptPath?: string;
  finalMessage?: string;
  turnRef?: string;
  expectedClaimToken?: string;
  expectedPassedDemand?: boolean;
  expectedAudit: boolean;
  hookExit?: number;
  hookLatencyMs?: number;
  note?: string;
}

interface TelemetryRow {
  ts?: string;
  harness?: string;
  event?: string;
  verdict?: string;
  dir?: string;
  claim?: string;
  caught?: string;
  turn_ref?: string;
  passed_law_ids?: string[];
  [key: string]: unknown;
}

interface ProcessSample {
  pid: number;
  ppid: number | null;
  cwd: string | null;
  command: string;
  auditorChild: boolean;
}

interface RepoBaseline {
  status: string[];
}

interface Violation {
  ts: string;
  invariant: string;
  message: string;
  context: {
    jobs: Array<{ path: string; body: string }>;
    transcript?: { path: string; tail: string };
    telemetry?: TelemetryRow;
    processes: ProcessSample[];
  };
}

interface WatchdogOptions {
  repo: string;
  home: string;
  expected: string;
  baseline: string;
  violations: string;
  samples: string;
  summary: string;
  stopFile?: string;
  intervalMs: number;
  latencyBudgetMs: number;
  maxRuntimeMs: number;
  once: boolean;
  allowedRepoPrefixes: string[];
}

const argv = process.argv.slice(2);
function option(name: string, fallback?: string): string {
  const i = argv.indexOf(`--${name}`);
  const value = i >= 0 ? argv[i + 1] : undefined;
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

const repo = resolve(option("repo"));
const home = resolve(option("home"));
const outDir = resolve(option("out"));
const opts: WatchdogOptions = {
  repo,
  home,
  expected: resolve(option("expected", join(outDir, "expected-turns.jsonl"))),
  baseline: resolve(option("baseline", join(outDir, "repo-baseline.json"))),
  violations: join(outDir, "violations.jsonl"),
  samples: join(outDir, "samples.jsonl"),
  summary: join(outDir, "watchdog-summary.json"),
  ...(argv.includes("--stop-file") ? { stopFile: resolve(option("stop-file")) } : {}),
  intervalMs: Number(option("interval-ms", "100")),
  latencyBudgetMs: Number(option("latency-budget-ms", "50")),
  maxRuntimeMs: Number(option("max-runtime-ms", String(6 * 60 * 60 * 1000))),
  once: argv.includes("--once"),
  allowedRepoPrefixes: option("allow-repo-prefixes", "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
};
mkdirSync(outDir, { recursive: true });

const queueKey = createHash("sha256").update(resolve(repo)).digest("hex").slice(0, 16);
const queueDir = join(home, ".veritaserum", "queue", queueKey);
const telemetryPath = join(home, ".veritaserum", "telemetry.jsonl");
const seenViolations = new Set<string>();
const seenTelemetryErrors = new Set<string>();
const seenDeadJobs = new Set<string>();
const demandStatuses = new Map<string, Set<number>>();
let lastDemandInspectionSignature = "";
let demandStageRetries = 0;
let demandStageFailures = 0;
const observedDemandPaths = new Set<string>();
let maxQueueDepth = 0;
let maxRelevantProcesses = 0;
let shuttingDown = false;

function readJsonl<T>(path: string): { rows: T[]; malformed: number } {
  if (!existsSync(path)) return { rows: [], malformed: 0 };
  const rows: T[] = [];
  let malformed = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      malformed++;
    }
  }
  return { rows, malformed };
}

function queueJobs(): Array<{ path: string; body: string }> {
  if (!existsSync(queueDir)) return [];
  return readdirSync(queueDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const path = join(queueDir, name);
      try {
        return { path, body: readFileSync(path, "utf8").slice(0, 16 * 1024) };
      } catch (error) {
        return { path, body: `<unreadable: ${error instanceof Error ? error.message : String(error)}>` };
      }
    });
}

function deadJobs(): string[] {
  const path = join(queueDir, "dead");
  if (!existsSync(path)) return [];
  return readdirSync(path).sort().map((name) => join(path, name));
}

function processTree(): ProcessSample[] {
  const out: ProcessSample[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return out;
  }
  for (const entry of entries) {
    const pid = Number(entry);
    try {
      const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      if (!command) continue;
      let cwd: string | null = null;
      try {
        cwd = readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        // A process can exit between reads.
      }
      let auditorChild = false;
      try {
        auditorChild = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes("VS_AUDIT_CHILD=1");
      } catch {
        // Same-user /proc is normally readable; if not, command + cwd remain useful.
      }
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = close >= 0 ? stat.slice(close + 2).split(" ") : [];
      const ppid = Number(fields[1]);
      const inObservedRepo = cwd !== null && resolve(cwd) === repo;
      const relevant =
        inObservedRepo &&
        (command.includes("--vs-audit-runner") ||
          auditorChild ||
          /\bcodex\s+exec\b/.test(command) ||
          /\bclaude\s+-p\b/.test(command) ||
          command.includes(join(queueDir, "demands")) ||
          /(?:^|\s)(?:veritaserum|\S*\/cli\.js)\s+demands(?:\s|$)/.test(command));
      if (relevant) out.push({ pid, ppid: Number.isFinite(ppid) ? ppid : null, cwd, command: command.slice(0, 1000), auditorChild });
    } catch {
      // Process disappeared.
    }
  }
  return out.sort((a, b) => a.pid - b.pid);
}

function latestTranscript(): { path: string; tail: string } | undefined {
  const { rows } = readJsonl<ExpectedTurn>(opts.expected);
  const item = [...rows].reverse().find((row) => row.transcriptPath && existsSync(row.transcriptPath));
  if (!item?.transcriptPath) return undefined;
  try {
    const content = readFileSync(item.transcriptPath, "utf8");
    return { path: item.transcriptPath, tail: content.slice(-16 * 1024) };
  } catch {
    return undefined;
  }
}

function violation(invariant: string, message: string, telemetry?: TelemetryRow): void {
  const key = `${invariant}\0${message}`;
  if (seenViolations.has(key)) return;
  seenViolations.add(key);
  const record: Violation = {
    ts: new Date().toISOString(),
    invariant,
    message,
    context: {
      jobs: queueJobs(),
      ...(latestTranscript() ? { transcript: latestTranscript() } : {}),
      ...(telemetry ? { telemetry } : {}),
      processes: processTree(),
    },
  };
  appendFileSync(opts.violations, JSON.stringify(record) + "\n");
}

function sleep(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function copyRepoStageOnce(stage: string): { ok: boolean; message?: string } {
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
const { cpSync, rmSync } = require("node:fs");
const [repo, stage] = process.argv.slice(1);
try {
  rmSync(stage, { recursive: true, force: true });
  cpSync(repo, stage, { recursive: true });
} catch (error) {
  const message = error && typeof error === "object" && "stack" in error ? error.stack : String(error);
  console.error(message);
  process.exit(1);
}
      `,
      repo,
      stage,
    ],
    {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
      },
    },
  );
  if (child.status === 0) return { ok: true };
  const message = [child.error?.message, child.stderr, child.signal ? `signal ${child.signal}` : `exit ${child.status ?? "unknown"}`]
    .filter((part) => part && String(part).trim().length > 0)
    .map((part) => String(part).trim())
    .join(" | ");
  return { ok: false, message: message || "stage copy failed" };
}

function copyRepoStage(stage: string): boolean {
  const backoffs = [25, 50, 100] as const;
  let lastError: string | undefined;
  for (let attempt = 0; attempt < backoffs.length + 1; attempt++) {
    try {
      const result = copyRepoStageOnce(stage);
      if (result.ok) return true;
      lastError = result.message;
      if (attempt === backoffs.length) break;
      demandStageRetries += 1;
      appendFileSync(
        opts.samples,
        JSON.stringify({
          ts: new Date().toISOString(),
          note: `demand stage copy retried after a transient stage-copy failure while sampling the repo`,
        }) + "\n",
      );
      sleep(backoffs[attempt]!);
      continue;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      break;
    }
  }
  demandStageFailures += 1;
  appendFileSync(
    opts.samples,
    JSON.stringify({
      ts: new Date().toISOString(),
      note: `demand stage copy skipped after ${backoffs.length + 1} attempt(s): ${lastError ?? "unknown error"}`,
    }) + "\n",
  );
  return false;
}

/** Parse `git status --porcelain=v1 -z` records. Rename/copy records carry a
 *  second NUL-separated origin-path field; a plain NUL split would misread it
 *  as a standalone prefixless record. */
function porcelainRecords(stdout: string): Array<{ record: string; path: string }> {
  const fields = stdout.split("\0");
  const records: Array<{ record: string; path: string }> = [];
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (!record) continue;
    const hasPrefix = record.length > 3 && record[2] === " ";
    const path = hasPrefix ? record.slice(3) : record;
    if (hasPrefix && /[RC]/.test(record.slice(0, 2))) i++; // consume the origin-path field
    records.push({ record, path });
  }
  return records;
}

function repoStatus(): string[] {
  const result = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: repo,
    encoding: "utf8",
  });
  if (result.status !== 0) return [`<git-status-error:${(result.stderr || "").trim()}>`];
  return porcelainRecords(result.stdout || "")
    .filter(({ record }) => !record.endsWith(" veritaserum.law.yaml"))
    .filter(({ path }) => !opts.allowedRepoPrefixes.some((prefix) => path.startsWith(prefix)))
    .map(({ record }) => record)
    .sort();
}

// Re-executing every demand on each 100ms tick would starve the sample loop
// (each script may block up to 30s). Signature changes trigger a pass, but
// never more often than this floor — and an oracle whose own side effects
// dirty the repo can no longer force a re-run feedback loop on every tick.
const DEMAND_INSPECTION_MIN_INTERVAL_MS = 5_000;
let lastDemandInspectionAt = 0;

function inspectDemands(): void {
  const dir = join(queueDir, "demands");
  if (!existsSync(dir)) return;
  const names = readdirSync(dir).filter((item) => /\.(?:cjs|mjs|js)$/.test(item)).sort();
  for (const name of names) observedDemandPaths.add(join(dir, name));
  const status = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: repo,
    encoding: "utf8",
  });
  const signature = createHash("sha256").update(status.stdout || "");
  for (const name of names) {
    const path = join(dir, name);
    try {
      const stat = statSync(path, { bigint: true });
      signature.update(`${name}\0${stat.size}\0${stat.mtimeNs}\0`);
    } catch {
      signature.update(`${name}\0missing\0`);
    }
  }
  for (const { path: relative } of porcelainRecords(status.stdout || "")) {
    try {
      const stat = statSync(join(repo, relative), { bigint: true });
      signature.update(`${relative}\0${stat.size}\0${stat.mtimeNs}\0`);
    } catch {
      signature.update(`${relative}\0missing\0`);
    }
  }
  const digest = signature.digest("hex");
  if (digest === lastDemandInspectionSignature) return;
  if (Date.now() - lastDemandInspectionAt < DEMAND_INSPECTION_MIN_INTERVAL_MS) return;
  lastDemandInspectionSignature = digest;
  lastDemandInspectionAt = Date.now();

  // Pure observer: oracles run against a disposable COPY of the repo with a
  // minimal environment — a side-effecting oracle can neither mutate the
  // watched tree (and be misattributed to the product by the non-interference
  // baseline) nor read API keys out of the watchdog's inherited env.
  const stage = join(outDir, `demand-stage-${process.pid}`);
  if (!copyRepoStage(stage)) {
    lastDemandInspectionSignature = "";
    return;
  }
  try {
    for (const name of names) {
      const path = join(dir, name);
      const source = readFileSync(path, "utf8");
      if (
        /\b(?:veritaserum|ser)\s+demands\b/i.test(source) ||
        /\b(?:spawnSync|spawn|execFileSync|execFile)\s*\([\s\S]{0,1200}?["'`]demands["'`]/i.test(source)
      ) {
        const statuses = demandStatuses.get(path) ?? new Set<number>();
        statuses.add(1);
        demandStatuses.set(path, statuses);
        violation("oracle-integrity", `${name} recursively invokes the demand runner`);
        continue;
      }
      const inputType = name.endsWith(".mjs") ? "module" : "commonjs";
      const recursionSentinel = `${path}.watchdog-recursion-${process.pid}`;
      const run = spawnSync(process.execPath, [`--input-type=${inputType}`], {
        cwd: stage,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          VS_DEMAND_PATH: path,
          VS_REPO_DIR: stage,
          VS_DEMAND_EVALUATION_SENTINEL: recursionSentinel,
        },
        input: source,
        timeout: 30_000,
      });
      const code = run.status ?? (run.signal ? 128 : 127);
      const statuses = demandStatuses.get(path) ?? new Set<number>();
      statuses.add(code);
      demandStatuses.set(path, statuses);
      const stderr = run.stderr || "";
      if (existsSync(recursionSentinel)) {
        rmSync(recursionSentinel, { force: true });
        violation("oracle-integrity", `${name} dynamically invoked the demand runner recursively`);
      }
      if (run.signal || run.error || (code !== 0 && code !== 1)) {
        violation("oracle-integrity", `${name} did not exit 0 or 1 (code=${code}, signal=${run.signal ?? "none"})`);
      }
      if (/SyntaxError:|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find module|bad interpreter|ReferenceError: require is not defined/i.test(stderr)) {
        violation("oracle-integrity", `${name} crashed before testing its acceptance condition: ${stderr.slice(0, 500)}`);
      }
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function sample(): void {
  const jobs = queueJobs();
  const dead = deadJobs();
  const telemetry = readJsonl<TelemetryRow>(telemetryPath);
  const processes = processTree();
  maxQueueDepth = Math.max(maxQueueDepth, jobs.length);
  maxRelevantProcesses = Math.max(maxRelevantProcesses, processes.length);
  if (processes.length > 32) {
    violation("termination", `process proliferation: observed ${processes.length} runner/auditor/demand processes`);
  }

  for (const row of telemetry.rows) {
    if (row.event !== "audit" || row.verdict !== "error" || resolve(String(row.dir || "")) !== repo) continue;
    const key = `${row.ts ?? ""}:${row.caught ?? ""}`;
    if (seenTelemetryErrors.has(key)) continue;
    seenTelemetryErrors.add(key);
    violation("liveness", `audit telemetry ended in error: ${String(row.caught || row.claim || "unknown")}`, row);
  }
  if (telemetry.malformed > 0) violation("liveness", `telemetry contains ${telemetry.malformed} malformed JSONL row(s)`);
  for (const path of dead) {
    if (seenDeadJobs.has(path)) continue;
    seenDeadJobs.add(path);
    violation("termination", `audit job moved to dead/: ${path}`);
  }

  if (existsSync(opts.baseline)) {
    try {
      const baseline = JSON.parse(readFileSync(opts.baseline, "utf8")) as RepoBaseline;
      const current = repoStatus();
      if (JSON.stringify(current) !== JSON.stringify(baseline.status)) {
        violation("non-interference", `repo status changed outside veritaserum.law.yaml: ${JSON.stringify(current)}`);
      }
    } catch (error) {
      violation("non-interference", `could not read repo baseline: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  inspectDemands();
  const lockPath = join(queueDir, ".lock");
  let lockPid: number | null = null;
  if (existsSync(lockPath)) {
    try {
      lockPid = Number(readFileSync(lockPath, "utf8").trim());
    } catch {
      lockPid = -1;
    }
  }
  appendFileSync(
    opts.samples,
    JSON.stringify({
      ts: new Date().toISOString(),
      queueDepth: jobs.length,
      deadJobs: dead.length,
      telemetryRows: telemetry.rows.length,
      telemetryBytes: existsSync(telemetryPath) ? statSync(telemetryPath).size : 0,
      lockPid,
      processes,
    }) + "\n",
  );
}

function finalize(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  // The last pass must not be lost to the inspection-interval floor: a demand
  // queued moments before shutdown still deserves one inspection attempt.
  lastDemandInspectionAt = 0;
  sample();
  const expectedRead = readJsonl<ExpectedTurn>(opts.expected);
  const expected = expectedRead.rows.filter((turn) => turn.expectedAudit && resolve(turn.repo) === repo);
  const telemetryRead = readJsonl<TelemetryRow>(telemetryPath);
  const audits = telemetryRead.rows.filter((row) => row.event === "audit" && resolve(String(row.dir || "")) === repo);
  const errors = audits.filter((row) => row.verdict === "error");
  const jobs = queueJobs();
  const dead = deadJobs();
  const processes = processTree();
  const overBudget = expected.filter((turn) => typeof turn.hookLatencyMs === "number" && turn.hookLatencyMs > opts.latencyBudgetMs);
  const nonzeroHooks = expectedRead.rows.filter((turn) => typeof turn.hookExit === "number" && turn.hookExit !== 0);

  if (audits.length !== expected.length) {
    violation("coverage", `expected exactly ${expected.length} audit telemetry row(s), observed ${audits.length}`);
  }
  const contentMisses = expected.filter(
    (turn) =>
      turn.expectedClaimToken &&
      !audits.some(
        (row) =>
          row.harness === turn.harness &&
          (!turn.turnRef || row.turn_ref === turn.turnRef) &&
          String(row.claim || "").includes(turn.expectedClaimToken as string),
      ),
  );
  for (const turn of contentMisses) {
    violation(
      "coverage",
      `${turn.id} produced no ${turn.harness} audit whose claim contains expected turn token ${JSON.stringify(turn.expectedClaimToken)}`,
    );
  }
  const evidenceMemoryMisses = expected.filter((turn) => {
    if (!turn.expectedPassedDemand) return false;
    const row = audits.find(
      (candidate) =>
        candidate.harness === turn.harness &&
        (!turn.turnRef || candidate.turn_ref === turn.turnRef) &&
        (!turn.expectedClaimToken || String(candidate.claim || "").includes(turn.expectedClaimToken)),
    );
    return !row || !row.passed_law_ids?.some((id) => id.startsWith("demand:")) || row.verdict === "unsupported";
  });
  for (const turn of evidenceMemoryMisses) {
    violation(
      "evidence-memory",
      `${turn.id} did not count a passed authored demand as evidence, or re-flagged its origin claim unsupported`,
    );
  }
  if (jobs.length !== 0) violation("termination", `queue did not drain: ${jobs.length} job(s) remain`);
  if (dead.length !== 0) violation("termination", `${dead.length} job artifact(s) remain in dead/`);
  if (processes.length !== 0) violation("termination", `${processes.length} runner/auditor process(es) remain at watchdog shutdown`);
  for (const turn of overBudget) {
    violation("non-interference", `${turn.id} hook latency ${turn.hookLatencyMs}ms exceeded ${opts.latencyBudgetMs}ms budget`);
  }
  for (const turn of nonzeroHooks) violation("non-interference", `${turn.id} hook exited ${turn.hookExit}`);
  for (const path of [...observedDemandPaths].sort()) {
    if (demandStatuses.has(path)) continue;
    violation(
      "oracle-integrity",
      `demand oracle ${basename(path)} was queued but never inspected: ${demandStageFailures} demand stage copy failure(s)`,
    );
  }

  const demandSummary = [...observedDemandPaths]
    .sort()
    .map((path) => ({ path, exitCodesSeen: [...(demandStatuses.get(path) ?? [])].sort() }));
  const recordedViolations = readJsonl<Violation>(opts.violations).rows;
  const demandsSatisfiable = demandSummary.length === 0 ? "not-applicable" : demandSummary.every((item) => item.exitCodesSeen.includes(0)) ? "pass" : "unverified";
  const summary = {
    generatedAt: new Date().toISOString(),
    repo,
    home,
    measurements: {
      expectedTurns: expected.length,
      auditedTurns: audits.length,
      erroredAudits: errors.length,
      neverAuditedTurns: Math.max(0, expected.length - audits.length),
      contentMismatchedTurns: contentMisses.length,
      evidenceMemoryMisses: evidenceMemoryMisses.length,
      unrunnableDemands: recordedViolations.filter((v) => v.invariant === "oracle-integrity").length,
      maxQueueDepth,
      telemetryRows: telemetryRead.rows.length,
      telemetryBytes: existsSync(telemetryPath) ? statSync(telemetryPath).size : 0,
      maxRelevantProcesses,
      demandStageRetries,
      demandStageFailures,
      hookLatenciesMs: expectedRead.rows.map((turn) => ({ id: turn.id, latencyMs: turn.hookLatencyMs ?? null })),
      auditDurationsMs: audits.map((row) => ({ harness: row.harness ?? null, durationMs: row.audit_duration_ms ?? null })),
    },
    invariants: {
      coverage: audits.length === expected.length && contentMisses.length === 0 ? "pass" : "fail",
      liveness: errors.length === 0 && telemetryRead.malformed === 0 ? "pass" : "fail",
      termination:
        jobs.length === 0 &&
        dead.length === 0 &&
        processes.length === 0 &&
        !recordedViolations.some((v) => v.invariant === "termination")
          ? "pass"
          : "fail",
      oracleInterpreterIntegrity: recordedViolations.some((v) => v.invariant === "oracle-integrity") ? "fail" : "pass",
      oracleSatisfiableInPrinciple: demandsSatisfiable,
      evidenceMemory: evidenceMemoryMisses.length === 0 ? "pass" : "fail",
      nonInterference:
        overBudget.length === 0 &&
        nonzeroHooks.length === 0 &&
        !recordedViolations.some((v) => v.invariant === "non-interference")
          ? "pass"
          : "fail",
      auditorCostPerTurn: "unverified",
    },
    demands: demandSummary,
    violations: recordedViolations.length,
  };
  writeFileSync(opts.summary, JSON.stringify(summary, null, 2) + "\n");
}

process.on("SIGTERM", () => {
  finalize();
  process.exit(0);
});
process.on("SIGINT", () => {
  finalize();
  process.exit(130);
});

if (opts.once) {
  finalize();
} else {
  // Orphan protection: if the harness dies without writing the stop file
  // (SIGKILL, OOM), this process is reparented — detect that (or the hard
  // runtime deadline) and finalize instead of sampling forever.
  const initialParent = process.ppid;
  const deadline = Date.now() + Math.max(60_000, opts.maxRuntimeMs);
  sample();
  setInterval(() => {
    if (opts.stopFile && existsSync(opts.stopFile)) {
      finalize();
      process.exit(0);
    }
    if (process.ppid !== initialParent || Date.now() > deadline) {
      violation("termination", process.ppid !== initialParent ? "watchdog orphaned: parent process died without writing the stop file" : "watchdog exceeded its maximum runtime");
      finalize();
      process.exit(0);
    }
    sample();
  }, Math.max(25, opts.intervalMs));
}
