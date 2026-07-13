/**
 * Claude Code feedback channel (SPEC.md §2 "Feedback channels", §1 R7/R8):
 * run-audit.ts writes a compact pending-feedback JSON (one per repo,
 * latest-wins) whenever a verdict has warnings/demands/unaccountable; cli.ts's
 * `hook-prompt` case is the ONLY injection door — it reads + clears that file
 * at the next UserPromptSubmit, printing ONE terse line to stdout (which a
 * harness's UserPromptSubmit hook turns into additionalContext), non-stale
 * (<24h), never blocking (R8-wrapped).
 *
 * The emission half is exercised through the REAL runAudit() (a codex PATH
 * shim stands in for the auditor CLI, same pattern as test/run-audit.test.ts);
 * the injection half drives the BUILT-FROM-SOURCE CLI as a real subprocess
 * (via tsx), same as test/sync-path.test.ts, so the stdin/stdout/exit-code
 * contract is exercised end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";
import { execa } from "execa";
import { tempRepo } from "./helpers.js";
import { runAudit } from "../src/run-audit.js";
import { pendingFeedbackPath, takePendingFeedback, type AuditJob } from "../src/audit-runner.js";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const RUNNER = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;

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

/** A heredoc (not `echo '...'`) so an apostrophe in the reply JSON (e.g. "it's
 *  working well") can't break the shim's shell quoting. */
async function codexShim(replyJson: string): Promise<void> {
  const p = join(shimDir, "codex");
  await writeFile(p, `#!/bin/sh\ncat <<'JSON'\n${replyJson}\nJSON\n`, "utf8");
  await chmod(p, 0o755);
}

beforeEach(async () => {
  shimDir = await mkdtemp(join(tmpdir(), "vs-fb-shim-"));
  cacheDir = await mkdtemp(join(tmpdir(), "vs-fb-cache-"));
  queueDir = await mkdtemp(join(tmpdir(), "vs-fb-queue-"));
  telemetryDir = await mkdtemp(join(tmpdir(), "vs-fb-telemetry-"));
  const { dir, cleanup } = await tempRepo();
  repoDir = dir;
  repoCleanup = cleanup;

  saved = {};
  for (const k of ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) saved[k] = v;
  }
  // shimDir (codex) + this process's own real `node` dir (hook-prompt's tsx
  // subprocess needs a real `node` to run at all) — NOT the full real PATH,
  // which drags in slow/irrelevant dirs and (worse) real codex/claude CLIs
  // that would make auditor resolution do real, slow network probes.
  process.env.PATH = `${shimDir}:${dirname(process.execPath)}:/usr/bin:/bin`;
  process.env.VS_DOCTOR_CACHE_PATH = join(cacheDir, "doctor.json");
  process.env.VS_QUEUE_ROOT = queueDir;
  process.env.VS_TELEMETRY_PATH = join(telemetryDir, "telemetry.jsonl");
  process.env.VS_EXECUTOR = "unknown";
  delete process.env.VS_AUDITOR;
  delete process.env.VS_AUDITOR_METERED;
  delete process.env.OPENROUTER_API_KEY;
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

async function hookPrompt(): Promise<{ code: number; out: string }> {
  const r = await execa(RUNNER, [CLI, "hook-prompt"], { cwd: repoDir, input: JSON.stringify({ cwd: repoDir }), reject: false });
  return { code: r.exitCode ?? 1, out: r.stdout };
}

describe("feedback channel — emission (run-audit.ts)", () => {
  it("an unsupported-claim verdict writes pending feedback (warn)", async () => {
    const codex = JSON.stringify({
      claims: [{ claim: "fixed the bug", verdict: "unsupported", basis: "no diff shows this change", evidence: "" }],
      demands: [],
      unaccountable: false,
      note: "",
    });
    await codexShim(codex);
    await runAudit(job("s1", await transcript("Done — fixed the bug.")));

    const line = takePendingFeedback(repoDir);
    expect(line).not.toBeNull();
    expect(line).toContain("veritaserum:");
    expect(line).toContain("fixed the bug");
    expect(line).toContain("unsupported");
  });

  it("a demand's remedy + accept are included verbatim in the pending feedback line (the instruction, not a nudge)", async () => {
    const codex = JSON.stringify({
      claims: [{ claim: "wrote an MCCFR solver, it's working well", verdict: "unsupported", basis: "no oracle test found", evidence: "" }],
      demands: [
        {
          origin_claim: "wrote an MCCFR solver, it's working well",
          gap: "no oracle demonstrates convergence to the known Kuhn equilibrium",
          remedy: "add a Kuhn-poker anchor test",
          accept: "strategy within 1e-3 of the known values",
          test_file: "process.exit(1);\n",
          rung: "oracle",
        },
      ],
      unaccountable: false,
      note: "",
    });
    await codexShim(codex);
    await runAudit(job("s1", await transcript("Done — wrote an MCCFR solver, it's working well.")));

    const line = takePendingFeedback(repoDir);
    expect(line).toContain("DEMAND: add a Kuhn-poker anchor test");
    expect(line).toContain("accept: strategy within 1e-3 of the known values");
  });

  it("a fully-supported verdict (nothing to warn about) writes NO pending feedback", async () => {
    const codex = JSON.stringify({
      claims: [{ claim: "fixed the bug", verdict: "supported", basis: "diff shows the fix", evidence: "diff --stat" }],
      demands: [],
      unaccountable: false,
      note: "",
    });
    await codexShim(codex);
    await runAudit(job("s1", await transcript("Done — fixed the bug.")));

    expect(takePendingFeedback(repoDir)).toBeNull();
  });

  it("latest-wins: a second audit's pending feedback replaces the first, one file per repo", async () => {
    const first = JSON.stringify({
      claims: [{ claim: "claim A", verdict: "unsupported", basis: "basis A", evidence: "" }],
      demands: [],
      unaccountable: false,
      note: "",
    });
    await codexShim(first);
    await runAudit(job("s1", await transcript("Done — claim A.")));

    const second = JSON.stringify({
      claims: [{ claim: "claim B", verdict: "unsupported", basis: "basis B", evidence: "" }],
      demands: [],
      unaccountable: false,
      note: "",
    });
    await codexShim(second);
    await runAudit(job("s2", await transcript("Done — claim B.")));

    const line = takePendingFeedback(repoDir);
    expect(line).toContain("claim B");
    expect(line).not.toContain("claim A");
  });
});

describe("feedback channel — injection (cli.ts hook-prompt)", () => {
  it("prints the pending line once, then clears it — a second UserPromptSubmit gets nothing", async () => {
    const codex = JSON.stringify({
      claims: [{ claim: "fixed the bug", verdict: "unsupported", basis: "no receipt", evidence: "" }],
      demands: [],
      unaccountable: false,
      note: "",
    });
    await codexShim(codex);
    await runAudit(job("s1", await transcript("Done — fixed the bug.")));

    const r1 = await hookPrompt();
    expect(r1.code).toBe(0);
    expect(r1.out.trim()).toContain("veritaserum:");
    expect(r1.out.trim()).toContain("fixed the bug");

    const r2 = await hookPrompt();
    expect(r2.code).toBe(0);
    expect(r2.out.trim()).toBe("");
  });

  it("no pending feedback at all → silent, exit 0", async () => {
    const r = await hookPrompt();
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("");
  });

  it("stale pending feedback (>= 24h old) is dropped, never printed", async () => {
    const p = pendingFeedbackPath(repoDir);
    await mkdir(join(p, ".."), { recursive: true });
    const staleTs = Date.now() - 25 * 60 * 60 * 1000;
    await writeFile(p, JSON.stringify({ ts: staleTs, line: "veritaserum: this should never print" }), "utf8");

    const r = await hookPrompt();
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("");
    // consumed, not left to wedge a later turn
    expect(takePendingFeedback(repoDir)).toBeNull();
  });

  it("R8: a corrupt pending-feedback file never blocks — exit 0, no crash, no output", async () => {
    const p = pendingFeedbackPath(repoDir);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, "{ not: valid json", "utf8");

    const r = await hookPrompt();
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("");
  });
});
