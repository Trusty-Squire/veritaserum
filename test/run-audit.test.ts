/**
 * R5 session warning store, wired end-to-end through the REAL runAudit() with a
 * local Jev mock. No CLI auditor.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempRepo, JEV_STATE_CONFAB } from "./helpers.js";
import { runAudit } from "../src/run-audit.js";
import { loadSessionWarnings, type AuditJob } from "../src/audit-runner.js";
import { readFirings } from "../src/telemetry.js";

const ENV_KEYS = [
  "PATH",
  "VS_DOCTOR_CACHE_PATH",
  "VS_QUEUE_ROOT",
  "VS_TELEMETRY_PATH",
  "VS_EXECUTOR",
  "TYPESAFE_API_KEY",
] as const;
let saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
let cacheDir: string;
let queueDir: string;
let telemetryDir: string;
let repoDir: string;
let repoCleanup: () => Promise<void>;

beforeEach(async () => {
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
  process.env.PATH = `/usr/bin:/bin`;
  process.env.VS_DOCTOR_CACHE_PATH = join(cacheDir, "doctor.json");
  process.env.VS_QUEUE_ROOT = queueDir;
  process.env.VS_TELEMETRY_PATH = join(telemetryDir, "telemetry.jsonl");
  process.env.VS_EXECUTOR = "unknown";
  process.env.TYPESAFE_API_KEY = "sk-test";
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(JEV_STATE_CONFAB), { status: 200 }));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await Promise.all([
    rm(cacheDir, { recursive: true, force: true }),
    rm(queueDir, { recursive: true, force: true }),
    rm(telemetryDir, { recursive: true, force: true }),
    repoCleanup(),
  ]);
});

async function transcript(finalMessage: string): Promise<string> {
  const p = join(cacheDir, `transcript-${Math.random().toString(36).slice(2)}.jsonl`);
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
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain("Done — fixed the bug");

    const firings1 = readFirings();
    expect(firings1).toHaveLength(1);
    expect(firings1[0]!.caught).toContain("Done — fixed the bug");

    const t2 = await transcript("Done — fixed the bug.");
    await runAudit(job("session-A", t2));

    const firings2 = readFirings();
    expect(firings2).toHaveLength(2);
    expect(firings2[1]!.caught).toBe("");
  });

  it("a different session for the same claim is NOT suppressed", async () => {
    const t1 = await transcript("Done — fixed the bug.");
    await runAudit(job("session-A", t1));
    const t2 = await transcript("Done — fixed the bug.");
    await runAudit(job("session-B", t2));

    const firings = readFirings();
    expect(firings).toHaveLength(2);
    expect(firings[0]!.caught).toContain("Done — fixed the bug");
    expect(firings[1]!.caught).toContain("Done — fixed the bug");
  });
});
