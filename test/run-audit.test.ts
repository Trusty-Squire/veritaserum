/**
 * R5 session warning store, wired end-to-end (SPEC §6.5): run-audit.ts loads
 * priorWarnings from the session store before auditing and appends the run's
 * new warnings after. Exercised through the REAL runAudit() — a codex PATH
 * shim stands in for the auditor CLI (same pattern as test/resolve-auditor.test.ts),
 * a Claude-Code-shaped transcript file stands in for the harness record, and
 * observability is via telemetry (`caught`) + the session-warning store itself,
 * since runAudit()'s return type is void by design (SPEC §2 "async audit dispatch").
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempRepo } from "./helpers.js";
import { runAudit } from "../src/run-audit.js";
import { loadSessionWarnings, type AuditJob } from "../src/audit-runner.js";
import { readFirings } from "../src/telemetry.js";

const ENV_KEYS = [
  "PATH",
  "VS_DOCTOR_CACHE_PATH",
  "VS_QUEUE_ROOT",
  "VS_TELEMETRY_PATH",
  "VS_EXECUTOR",
  "VS_AUDITOR",
  "VS_AUDITOR_METERED",
  "OPENROUTER_API_KEY",
] as const;
let saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
let shimDir: string;
let cacheDir: string;
let queueDir: string;
let telemetryDir: string;
let repoDir: string;
let repoCleanup: () => Promise<void>;

const REPLY =
  '{"claims":[{"claim":"fixed the bug","verdict":"unsupported","basis":"no diff shows this change","evidence":""}],"demands":[],"unaccountable":false,"note":""}';

beforeEach(async () => {
  shimDir = await mkdtemp(join(tmpdir(), "vs-run-audit-shim-"));
  cacheDir = await mkdtemp(join(tmpdir(), "vs-run-audit-cache-"));
  queueDir = await mkdtemp(join(tmpdir(), "vs-run-audit-queue-"));
  telemetryDir = await mkdtemp(join(tmpdir(), "vs-run-audit-telemetry-"));
  const { dir, cleanup } = await tempRepo();
  repoDir = dir;
  repoCleanup = cleanup;

  saved = {};
  for (const k of ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) saved[k] = v;
  }
  process.env.PATH = `${shimDir}:/usr/bin:/bin`;
  process.env.VS_DOCTOR_CACHE_PATH = join(cacheDir, "doctor.json");
  process.env.VS_QUEUE_ROOT = queueDir;
  process.env.VS_TELEMETRY_PATH = join(telemetryDir, "telemetry.jsonl");
  process.env.VS_EXECUTOR = "unknown";
  delete process.env.VS_AUDITOR;
  delete process.env.VS_AUDITOR_METERED;
  delete process.env.OPENROUTER_API_KEY;

  // codex on PATH, family "other" != openai → rule1 picks it as the agentic auditor.
  const codex = join(shimDir, "codex");
  await writeFile(codex, `#!/bin/sh\necho '${REPLY}'\nexit 0\n`, "utf8");
  await chmod(codex, 0o755);
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await Promise.all([
    rm(shimDir, { recursive: true, force: true }),
    rm(cacheDir, { recursive: true, force: true }),
    rm(queueDir, { recursive: true, force: true }),
    rm(telemetryDir, { recursive: true, force: true }),
    repoCleanup(),
  ]);
});

async function transcript(finalMessage: string): Promise<string> {
  const p = join(shimDir, `transcript-${Math.random().toString(36).slice(2)}.jsonl`);
  const lines = [
    JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "please fix the bug" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: finalMessage }] } }),
  ];
  await writeFile(p, lines.join("\n") + "\n", "utf8");
  return p;
}

function job(sessionId: string, transcriptPath: string): AuditJob {
  return { dir: repoDir, sessionId, turnRef: "t1", mode: "live", transcriptPath };
}

describe("run-audit.ts — R5 session warning store, wired end-to-end", () => {
  it("the same claim audited twice in one session: the second run's warning is suppressed", async () => {
    const t1 = await transcript("Done — fixed the bug.");
    await runAudit(job("session-A", t1));

    const stored = loadSessionWarnings(repoDir, "session-A");
    expect(stored).toEqual(["fixed the bug — unsupported: no diff shows this change"]);

    const firings1 = readFirings();
    expect(firings1).toHaveLength(1);
    expect(firings1[0]!.caught).toContain("fixed the bug — unsupported");

    // Same session, same claim, a second turn.
    const t2 = await transcript("Done — fixed the bug.");
    await runAudit(job("session-A", t2));

    const firings2 = readFirings();
    expect(firings2).toHaveLength(2);
    expect(firings2[1]!.caught).toBe(""); // suppressed — no verbatim repeat within the session
  });

  it("a different session for the same claim is NOT suppressed", async () => {
    const t1 = await transcript("Done — fixed the bug.");
    await runAudit(job("session-A", t1));

    const t2 = await transcript("Done — fixed the bug.");
    await runAudit(job("session-B", t2));

    const firings = readFirings();
    expect(firings).toHaveLength(2);
    expect(firings[0]!.caught).toContain("fixed the bug — unsupported");
    expect(firings[1]!.caught).toContain("fixed the bug — unsupported"); // different session — still surfaced

    expect(loadSessionWarnings(repoDir, "session-B")).toEqual(["fixed the bug — unsupported: no diff shows this change"]);
  });
});
