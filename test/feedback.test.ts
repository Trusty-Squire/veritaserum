/**
 * Claude Code feedback channel (SPEC.md §2 "Feedback channels", §1 R7/R8):
 * run-audit.ts writes a compact pending-feedback JSON (one per repo,
 * latest-wins) whenever a verdict has warnings/unaccountable; cli.ts's
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
import { pendingFeedbackPath, takePendingFeedback, writePendingFeedback, takeStrayFeedback, takeDeliveredWarnings, type AuditJob } from "../src/audit-runner.js";
import { writeFile as writeFileP } from "node:fs/promises";
import { readFirings } from "../src/telemetry.js";

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

async function hookPrompt(sessionId?: string): Promise<{ code: number; out: string }> {
  const payload: Record<string, unknown> = { cwd: repoDir };
  if (sessionId) payload.session_id = sessionId;
  const r = await execa(RUNNER, [CLI, "hook-prompt"], { cwd: repoDir, input: JSON.stringify(payload), reject: false });
  return { code: r.exitCode ?? 1, out: r.stdout };
}

async function hookSessionStart(sessionId?: string): Promise<{ code: number; out: string }> {
  const payload: Record<string, unknown> = { cwd: repoDir };
  if (sessionId) payload.session_id = sessionId;
  const r = await execa(RUNNER, [CLI, "hook-session-start"], { cwd: repoDir, input: JSON.stringify(payload), reject: false });
  return { code: r.exitCode ?? 1, out: r.stdout };
}

/** Plant a feedback file for `sessionId` with an explicit age (ms) — strays need a
 *  controlled ts, and writePendingFeedback always stamps now. */
async function plantFeedback(sessionId: string, line: string, ageMs: number): Promise<void> {
  const p = pendingFeedbackPath(repoDir, sessionId);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFileP(p, JSON.stringify({ ts: Date.now() - ageMs, line }), "utf8");
}

const MIN = 60 * 1000;

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

    const line = takePendingFeedback(repoDir, "s1");
    expect(line).not.toBeNull();
    expect(line).toContain("veritaserum:");
    expect(line).toContain("fixed the bug");
    // CHANGE 1 correction: the delivered line is the colloquial direct-address
    // form, so it no longer contains the bare verdict word "unsupported".
    expect(line).toContain("you have no basis to claim");
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

    expect(takePendingFeedback(repoDir, "s1")).toBeNull();
  });

  it("latest-wins WITHIN a session: a second audit for the same session replaces its pending line", async () => {
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
    await runAudit(job("s1", await transcript("Done — claim B.")));

    const line = takePendingFeedback(repoDir, "s1");
    expect(line).toContain("claim B");
    expect(line).not.toContain("claim A");
  });

  it("two sessions in one repo keep SEPARATE pending feedback — neither overwrites the other", async () => {
    const a = JSON.stringify({
      claims: [{ claim: "claim A", verdict: "unsupported", basis: "basis A", evidence: "" }],
      unaccountable: false,
      note: "",
    });
    await codexShim(a);
    await runAudit(job("session-A", await transcript("Done — claim A.")));

    const b = JSON.stringify({
      claims: [{ claim: "claim B", verdict: "unsupported", basis: "basis B", evidence: "" }],
      unaccountable: false,
      note: "",
    });
    await codexShim(b);
    await runAudit(job("session-B", await transcript("Done — claim B.")));

    expect(takePendingFeedback(repoDir, "session-A")).toContain("claim A");
    expect(takePendingFeedback(repoDir, "session-B")).toContain("claim B");
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

    const r1 = await hookPrompt("s1");
    expect(r1.code).toBe(0);
    expect(r1.out.trim()).toContain("veritaserum:");
    expect(r1.out.trim()).toContain("fixed the bug");

    const r2 = await hookPrompt("s1");
    expect(r2.code).toBe(0);
    expect(r2.out.trim()).toBe("");
  });

  it("session A's warning goes to A's next prompt and NOT to B's, in the same repo (both directions)", async () => {
    writePendingFeedback(repoDir, "session-A", "veritaserum: A's warning");
    writePendingFeedback(repoDir, "session-B", "veritaserum: B's warning");

    // B prompts first — gets only B's, A's is untouched.
    const toB = await hookPrompt("session-B");
    expect(toB.out).toContain("B's warning");
    expect(toB.out).not.toContain("A's warning");

    // A prompts next — still has A's, never saw B's.
    const toA = await hookPrompt("session-A");
    expect(toA.out).toContain("A's warning");
    expect(toA.out).not.toContain("B's warning");

    // the session path is tagged `session` in telemetry
    expect(readFirings().some((f) => f.feedback_scope === "session")).toBe(true);
  });

  it("a prompt payload WITHOUT session_id drains repo-scoped (fallback) and tags it", async () => {
    writePendingFeedback(repoDir, "session-X", "veritaserum: stranded warning");

    const r = await hookPrompt(); // no session_id in the payload
    expect(r.code).toBe(0);
    expect(r.out).toContain("stranded warning");
    expect(readFirings().some((f) => f.feedback_scope === "repo-fallback")).toBe(true);
  });

  it("no pending feedback at all → silent, exit 0", async () => {
    const r = await hookPrompt("s1");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("");
  });

  it("stale pending feedback (>= 24h old) is dropped, never printed", async () => {
    const p = pendingFeedbackPath(repoDir, "s-stale");
    await mkdir(join(p, ".."), { recursive: true });
    const staleTs = Date.now() - 25 * 60 * 60 * 1000;
    await writeFile(p, JSON.stringify({ ts: staleTs, line: "veritaserum: this should never print" }), "utf8");

    const r = await hookPrompt("s-stale");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("");
    // consumed, not left to wedge a later turn
    expect(takePendingFeedback(repoDir, "s-stale")).toBeNull();
  });

  it("R8: a corrupt pending-feedback file never blocks — exit 0, no crash, no output", async () => {
    const p = pendingFeedbackPath(repoDir, "s-corrupt");
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, "{ not: valid json", "utf8");

    const r = await hookPrompt("s-corrupt");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("");
  });
});

/**
 * Stray delivery (autonomous-fleet fix): a warning earned by an AUTONOMOUS session
 * (a one-shot scheduled run, or a turn ended by a task notification) never reaches a
 * human at that session's own prompt — it never prompts again. Two extra doors sweep
 * these "strays" — another session's undelivered feedback in the SAME repo, past a
 * 10-min grace, under the 24h expiry: Door 1 (any session's prompt) and Door 2
 * (any session start).
 */
describe("feedback channel — stray sweep (Door 1: hook-prompt)", () => {
  it("delivers a >10min stray at another session's prompt WITH attribution, after that session's own line; consumes it; ledgers ONLY the own line", async () => {
    writePendingFeedback(repoDir, "session-A", "veritaserum: A's own warning"); // fresh, A's own
    await plantFeedback("session-B", "veritaserum: B's stray warning", 11 * MIN); // past grace

    const r = await hookPrompt("session-A");
    expect(r.code).toBe(0);
    // A's own line first, then the attributed stray.
    expect(r.out).toContain("A's own warning");
    expect(r.out).toContain("from an earlier session in this repo");
    expect(r.out).toContain("B's stray warning");
    expect(r.out.indexOf("A's own warning")).toBeLessThan(r.out.indexOf("B's stray warning"));

    // B's file is consumed — never redelivered.
    expect(takePendingFeedback(repoDir, "session-B")).toBeNull();

    // Ledger records ONLY A's own line, never B's stray (advisory-outcome discipline).
    const delivered = takeDeliveredWarnings(repoDir, "session-A");
    expect(delivered).toEqual(["veritaserum: A's own warning"]);
    expect(delivered.join("")).not.toContain("B's stray");

    // A stray sweep is tagged `stray` in telemetry.
    expect(readFirings().some((f) => f.feedback_scope === "stray")).toBe(true);
  });

  it("a stray YOUNGER than 10min is NOT swept (grace gives its owner first claim)", async () => {
    await plantFeedback("session-B", "veritaserum: B's fresh warning", 5 * MIN); // within grace

    const r = await hookPrompt("session-A"); // A has no own feedback
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(""); // nothing delivered
    // B's file untouched — still there for B's own next prompt.
    expect(takePendingFeedback(repoDir, "session-B")).toContain("B's fresh warning");
  });

  it("a stray older than 24h is dropped, never delivered", async () => {
    await plantFeedback("session-B", "veritaserum: B's ancient warning", 25 * 60 * MIN); // > 24h

    const r = await hookPrompt("session-A");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("");
  });

  it("caps at 3: with 5 strays present, only the 3 oldest are delivered in one prompt", async () => {
    // ages descending → oldest is stray-B (20min), newest stray-F (16min).
    await plantFeedback("session-B", "veritaserum: stray-B", 20 * MIN);
    await plantFeedback("session-C", "veritaserum: stray-C", 19 * MIN);
    await plantFeedback("session-D", "veritaserum: stray-D", 18 * MIN);
    await plantFeedback("session-E", "veritaserum: stray-E", 17 * MIN);
    await plantFeedback("session-F", "veritaserum: stray-F", 16 * MIN);

    const r = await hookPrompt("session-A");
    expect(r.code).toBe(0);
    // the 3 oldest delivered...
    for (const id of ["stray-B", "stray-C", "stray-D"]) expect(r.out).toContain(id);
    // ...the 2 newest not.
    for (const id of ["stray-E", "stray-F"]) expect(r.out).not.toContain(id);
    // and the 2 undelivered files remain for a later sweep.
    expect(takePendingFeedback(repoDir, "session-E")).toContain("stray-E");
    expect(takePendingFeedback(repoDir, "session-F")).toContain("stray-F");
  });
});

describe("feedback channel — stray sweep (Door 2: hook-session-start)", () => {
  it("delivers strays on a fresh session id, with attribution, exit 0", async () => {
    await plantFeedback("session-B", "veritaserum: B's stray warning", 11 * MIN);

    const r = await hookSessionStart("fresh-session");
    expect(r.code).toBe(0);
    expect(r.out).toContain("from an earlier session in this repo");
    expect(r.out).toContain("B's stray warning");
    // consumed
    expect(takePendingFeedback(repoDir, "session-B")).toBeNull();
  });

  it("silent (exit 0, no output) when there are no strays", async () => {
    const r = await hookSessionStart("fresh-session");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("");
  });
});

describe("feedback channel — stray consumption is race-safe (consume-once)", () => {
  it("consuming the same stray twice yields the line exactly once", async () => {
    await plantFeedback("session-B", "veritaserum: B's stray warning", 11 * MIN);

    const first = takeStrayFeedback(repoDir, "session-A");
    const second = takeStrayFeedback(repoDir, "session-A");

    expect(first).toHaveLength(1);
    expect(first[0]).toContain("from an earlier session in this repo");
    expect(first[0]).toContain("B's stray warning");
    expect(second).toEqual([]); // already consumed — never a second delivery
  });
});

/**
 * The verdict has to reach the MODEL, not just the human.
 *
 * codex renders a Stop hook's output as a TUI warning and drops it — its wire schema has no
 * StopHookSpecificOutput, so nothing a Stop hook says can enter the model's context. Its only
 * injection doors are SessionStart and UserPromptSubmit, and both require a structured
 * envelope on stdout. This hook emitted bare text, which codex is not obliged to read — so a
 * codex agent saw the warning banner on the user's screen and nothing in its own transcript:
 * "I did not see that stop-hook output. It wasn't included in any terminal/tool output
 * visible to me." Every verdict and demand was addressed to no one.
 */
describe("feedback channel — the injection envelope each harness actually reads", () => {
  async function hookPromptAs(harness: string): Promise<string> {
    const env: NodeJS.ProcessEnv = { ...process.env, VS_HARNESS: harness };
    const r = await execa(RUNNER, [CLI, "hook-prompt"], {
      cwd: repoDir,
      input: JSON.stringify({ cwd: repoDir }),
      env,
      reject: false,
    });
    return r.stdout;
  }

  // eslint-disable-next-line no-control-regex
  const ANSI = /\x1b\[[0-9;]*m/;
  const WARN = 'veritaserum: Agent, you have no basis to claim "tests pass" — no test run on record.';
  // The one directive sentence appended to the MODEL channel (context only): it
  // makes the agent surface the verdict in its reply — the only surface the human
  // reliably sees. NEVER in systemMessage or the delivered-warning ledger.
  const DIRECTIVE =
    "\nShow the italicized line above to the user verbatim at the top of your reply, then leave a blank line before the rest of your reply.";

  it("codex: additionalContext = verdict + directive, byte-exact, no systemMessage, no styling", async () => {
    writePendingFeedback(repoDir, "s-env", WARN);
    const out = await hookPromptAs("codex");

    const parsed = JSON.parse(out) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
      systemMessage?: string;
    };
    // Shape is codex's, verbatim: additionalProperties:false, hookEventName is a const.
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(Object.keys(parsed.hookSpecificOutput).sort()).toEqual(["additionalContext", "hookEventName"]);
    // byte-exact: the verdict line is italicized then differs from that ONLY by
    // the appended directive sentence — nothing else. codex has no human channel
    // in the reply, so no systemMessage, no emoji, no ANSI.
    expect(parsed.hookSpecificOutput.additionalContext).toBe(`*${WARN}*` + DIRECTIVE);
    expect(parsed.systemMessage).toBeUndefined();
    expect(out).not.toContain("⚠️");
    expect(out).not.toMatch(ANSI);
  });

  it("claude-code: model channel = italicized verdict + directive; human channel = plain ⚠️ line (no asterisks, no ANSI, no directive)", async () => {
    writePendingFeedback(repoDir, "s-env", WARN);
    const out = await hookPromptAs("claude-code");

    const parsed = JSON.parse(out) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
      systemMessage: string;
    };
    // model channel: italicized verdict + the surface-it directive.
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toBe(`*${WARN}*` + DIRECTIVE);
    // human channel (transcript view at best): plain emoji-marked verdict —
    // no asterisks, no ANSI (garbage there), no directive (that's model-only guidance).
    expect(parsed.systemMessage).toBe(`⚠️ ${WARN}`);
    expect(parsed.systemMessage).not.toContain("*");
    expect(parsed.systemMessage).not.toMatch(ANSI);
    expect(parsed.systemMessage).not.toContain("Show the italicized line above");
  });

  it("goose/unknown: bare stdout = italicized verdict + directive, no envelope", async () => {
    writePendingFeedback(repoDir, "s-env", WARN);
    const out = await hookPromptAs("goose");
    expect(out).toBe(`*${WARN}*` + DIRECTIVE);
  });

  it("the delivered-warning ledger stores the BARE verdict line — never the directive", async () => {
    writePendingFeedback(repoDir, "s-ledger", WARN);
    const r = await hookPrompt("s-ledger");
    expect(r.code).toBe(0);
    const delivered = takeDeliveredWarnings(repoDir, "s-ledger");
    expect(delivered).toEqual([WARN]);
    expect(delivered[0]).not.toContain("*");
    expect(delivered[0]).not.toContain("Show the italicized line above");
  });
});
