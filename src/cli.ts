#!/usr/bin/env node
/**
 * `veritaserum` CLI (DESIGN §4) — the enforcement door a hook shells out to.
 *   veritaserum install <harness>              wire veritaserum's sync path into a harness
 *   veritaserum doctor                        which auditor rule fired and why (SPEC §2)
 *   veritaserum telemetry                      what the auditor caught
 *
 * Exit codes: errors -> 2.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveAuditor, doctorReport } from "./resolve.js";
import { enqueue, queueRoot, takePendingFeedback, drainAllPendingFeedback, takeStrayFeedback, recordDeliveredWarning, writePendingFeedback, type AuditJob } from "./audit-runner.js";
import { hasToolActivitySince, defaultGooseSessionsDb } from "./goose.js";
import { audit, type AuditJob as AuditContentJob } from "./auditor.js";
import { logFiring, readFirings, summarize } from "./telemetry.js";
import { installTarget, detectHarnesses, isTarget, TARGETS, type Target } from "./install.js";
import { selfcheck } from "./selfcheck.js";
import * as style from "./style.js";
import { typesafeApiKey } from "./llm.js";
import { loadTurnMaterial, buildFeedbackLine } from "./run-audit.js";
import {
  isBlockEnabled,
  isBlockExplicitlyOff,
  blockCap,
  readBlockCount,
  writeBlockCount,
  shouldBlock,
  formatBlockReason,
  emitBlock,
} from "./block.js";

/** Which harness fired us (installer sets VS_HARNESS). */
function harnessName(): string {
  return process.env.VS_HARNESS || "unknown";
}

/**
 * The verdict has to reach the MODEL, not just the human — and the two harnesses disagree
 * about how.
 *
 * codex prints a Stop hook's output as a warning in its TUI and drops it on the floor: there
 * is no StopHookSpecificOutput in its wire schema, so nothing a Stop hook says can ever enter
 * the model's context. Its ONLY injection doors are SessionStart and UserPromptSubmit, and
 * both require a structured envelope on stdout:
 *   {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"…"}}
 * Plain stdout — which is what this hook emitted — is not context to codex. So a codex agent
 * saw the warning banner on the user's screen and nothing in its own transcript, and said so:
 * "I did not see that stop-hook output. It wasn't included in any terminal/tool output
 * visible to me." Every verdict, every demand, silently addressed to no one.
 *
 * The AGENT'S REPLY is the only channel proven to reach the human on every surface. A
 * controlled canary (twice) showed additionalContext reliably reaches the MODEL, but
 * Claude Code's systemMessage does NOT render on the human's main chat surface — per the
 * docs it lands in the ctrl+r transcript view, which nobody watches (the owner saw nothing
 * across two deliveries and 18h of production). So we make the agent the display: the model
 * channel carries the verdict PLUS a directive telling the agent to surface the verdict line
 * verbatim at the top of its reply. systemMessage is KEPT (it still renders in the transcript
 * view, and future clients may surface it) but PLAIN — rendering there is transcript-raw at
 * best, so ANSI escapes are garbage. The directive lives in the model CONTEXT only: never in
 * systemMessage, telemetry, the dedupe store, or the delivered-warning ledger (that ledger
 * keeps the bare verdict line so the advisory-outcome audit quotes the right thing).
 */
const SHOW_DIRECTIVE =
  "\nShow the italicized line above to the user verbatim at the top of your reply, then leave a blank line before the rest of your reply.";

/** Wrap in markdown italics for the model channel only — deterministic
 *  formatting, not left to agent discretion. Guard against double-wrapping
 *  a line that already arrives asterisk-delimited. */
function italicize(line: string): string {
  return line.startsWith("*") && line.endsWith("*") ? line : `*${line}*`;
}

/**
 * `event` selects the hook slot the envelope names. UserPromptSubmit is the normal
 * feedback door; SessionStart is Door 2 (stray delivery on a fresh session). For
 * SessionStart, additionalContext IS a documented injection channel in Claude Code
 * (SessionStart stdout becomes the session's initial context), and codex's own
 * injection doors are SessionStart + UserPromptSubmit — so the same envelope shape
 * applies, only the hookEventName differs. HONESTY NOTE: SessionStart-via-envelope is
 * verified against the Claude Code docs but not a controlled canary here (as
 * UserPromptSubmit was), so if a harness ignores it the failure mode is silence, not
 * error — R8-safe.
 */
function injectionFor(harness: string, line: string, event: "UserPromptSubmit" | "SessionStart" = "UserPromptSubmit"): string {
  const italic = italicize(line);
  if (harness === "codex") {
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: italic + SHOW_DIRECTIVE },
    });
  }
  if (harness === "claude-code") {
    // Model channel (additionalContext): the italicized verdict + a directive to
    // surface it in the reply — the reply is the only surface the human reliably
    // sees. Human channel (systemMessage): PLAIN "⚠️ <verdict>" — no asterisks, no
    // ANSI (transcript-raw rendering makes escapes garbage), no directive (that's
    // model-only guidance). "⚠️ " marks the line in every renderer.
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: italic + SHOW_DIRECTIVE },
      systemMessage: `⚠️ ${line}`,
    });
  }
  // goose/unknown: bare stdout reaches the model too — append the directive there.
  return italic + SHOW_DIRECTIVE;
}

/** Read the harness hook payload (JSON HookContext) from stdin. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

interface HookPayload {
  // goose Stop: {event, session_id, working_dir} — deliberately no message
  // content (SPEC §3): the final message + receipts are read from goose's own
  // sessions.db (./goose.js), keyed by session_id, never from an ephemeral hook field.
  event?: string;
  session_id?: string;
  working_dir?: string;
  // Claude Code Stop: {transcript_path, cwd, stop_hook_active}.
  transcript_path?: string;
  cwd?: string;
  stop_hook_active?: boolean;
  hook_event_name?: string;
  turn_id?: string;
  /** Codex Stop's documented, stable content field. Codex does not promise a
   * stable transcript wire format, so this is authoritative for its final text. */
  last_assistant_message?: string | null;
}
function parsePayload(raw: string): HookPayload {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as HookPayload) : {};
  } catch {
    return {};
  }
}
/** The repo dir to verify against, across harnesses. */
function payloadDir(p: HookPayload, fallback: string): string {
  return p.working_dir || p.cwd || fallback;
}
/** goose carries its own session_id; Claude Code doesn't, so the transcript
 *  path stands in (stable per session, unique enough for the audit queue key). */
function sessionIdOf(p: HookPayload, fallback: string): string {
  return p.session_id || p.transcript_path || fallback;
}

function flag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}
function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
/** Positional args = everything before the first --flag. */
function positional(args: string[]): string[] {
  const cut = args.findIndex((a) => a.startsWith("--"));
  return (cut === -1 ? args : args.slice(0, cut)).filter((a) => a.length > 0);
}

// --- v3 sync path (SPEC §2 "the mechanism") ---------------------------------
// Deterministic, no LLM, no claim regex (R2). Everything here is best-effort:
// a marker read/write failure just means we re-check next turn (safe), never
// a reason to skip the actual audit dispatch.

/** ~/.veritaserum/queue/<repo-key>/last-audit.json — "has anything happened
 *  since we last looked" watermark, shared by both harness shapes. */
interface LastAudit {
  /** epoch ms of the last turn-end that found new activity. */
  ts: number;
  /** Claude Code: transcript byte-size last seen, per transcript path (goose
   *  is queried directly against sessions.db instead — see hasNewToolActivity). */
  ccTranscriptSize?: Record<string, number>;
}
function lastAuditPath(qdir: string): string {
  // MUST live outside the queue root's top level: the drain loop scans every
  // top-level *.json there as a job, and a marker parsed as an empty job
  // "succeeds" vacuously and gets deleted — which silently killed live
  // auditing (watermark reset every drain cycle, zero telemetry).
  return join(qdir, "state", "last-audit.json");
}
function readLastAudit(qdir: string): LastAudit {
  try {
    return JSON.parse(readFileSync(lastAuditPath(qdir), "utf8")) as LastAudit;
  } catch {
    return { ts: 0 };
  }
}
function writeLastAudit(qdir: string, next: LastAudit): void {
  try {
    mkdirSync(dirname(lastAuditPath(qdir)), { recursive: true });
    writeFileSync(lastAuditPath(qdir), JSON.stringify(next), "utf8");
  } catch {
    /* best-effort marker */
  }
}

/**
 * Sync step 1 (SPEC §2): has there been tool activity since the last audit?
 * goose: a real query against sessions.db (session_id + timestamp — the harness's
 * own record, R1). Claude Code: transcript byte-size growth stands in for "tail" at
 * the ~0ms budget — cheap and sufficient (no reason to parse JSONL just to answer
 * yes/no). Unknown payload shape → nothing to audit (fail toward silence, R8-adjacent).
 */
/**
 * Never audit the auditor. The agentic auditor IS a coding agent (codex/claude) and it
 * runs inside the audited repo, so veritaserum's own Stop hook fires on ITS turn-end and
 * enqueues a job — whose audit spawns another auditor, which enqueues again. That loop
 * never converges: it floods the queue with empty-content self-audits and starves the
 * real session's job. resolve.ts stamps VS_AUDIT_CHILD on every auditor subprocess; the
 * hook that sees it does nothing.
 */
function isAuditorChild(): boolean {
  return process.env.VS_AUDIT_CHILD === "1";
}

function hasNewToolActivity(p: HookPayload, marker: LastAudit): boolean {
  // transcript_path FIRST: Claude Code sends BOTH fields, and its session_id is
  // meaningless to goose's sessions.db — querying that DB for it always answers
  // "no activity", so every Claude Code turn was silently skipped, never audited.
  // Only goose (session_id, no transcript) takes the DB path.
  if (p.transcript_path) {
    try {
      const size = statSync(p.transcript_path).size;
      const prev = marker.ccTranscriptSize?.[p.transcript_path] ?? 0;
      return size > prev;
    } catch {
      return false; // missing/unreadable transcript — nothing to audit
    }
  }
  if (p.session_id) {
    const dbPath = process.env.VS_GOOSE_SESSIONS_DB || defaultGooseSessionsDb();
    return hasToolActivitySince(dbPath, p.session_id, marker.ts);
  }
  return false;
}

/**
 * Captain override of R5: a synchronous Jev (or test-double) audit that can
 * block the turn. Fail-open: any error, absent auditor, or missing key returns
 * {blocked:false} and never throws.
 */
async function runSynchronousBlock(args: {
  wd: string;
  sessionId: string;
  payload: HookPayload;
  force: boolean;
}): Promise<number> {
  const qdir = queueRoot(args.wd);
  const cap = blockCap();
  const priorBlocks = readBlockCount(qdir, args.sessionId);
  if (priorBlocks >= cap) return 0;

  const executor = process.env.VS_EXECUTOR || "unknown";
  const auditor =
    typesafeApiKey() && !process.env.VS_AUDITOR
      ? await resolveAuditor(executor, "jev")
      : args.force || process.env.VS_AUDITOR
        ? await resolveAuditor(executor)
        : null;
  if (!auditor || auditor.tier === "absent") return -1; // caller fail-opens (enqueue)

  const job: AuditJob = {
    dir: args.wd,
    sessionId: args.sessionId,
    turnRef: String(Date.now()),
    mode: process.env.VS_AUDIT_MODE === "testbed" ? "testbed" : "live",
    ...(args.payload.transcript_path ? { transcriptPath: args.payload.transcript_path } : {}),
    ...(typeof args.payload.last_assistant_message === "string" ? { finalMessage: args.payload.last_assistant_message } : {}),
    harness: harnessName(),
    executor,
    ...(process.env.VS_AUDITOR ? { auditor: process.env.VS_AUDITOR } : {}),
  };
  const material = loadTurnMaterial(job);
  if (!material.finalMessage) return 0;

  const contentJob: AuditContentJob = {
    dir: args.wd,
    sessionId: args.sessionId,
    turnRef: job.turnRef,
    finalMessage: material.finalMessage,
    userRequest: material.userRequest,
    ...(material.receipts ? { receipts: material.receipts } : {}),
    ...(material.conversationTail ? { conversationTail: material.conversationTail } : {}),
    harness: job.harness,
    schedulingMode: job.mode,
    executor,
  };
  const verdict = await audit(contentJob, auditor);
  const flagged = verdict.claims.filter((c) => c.verdict === "unsupported" || c.verdict === "contradicted");
  const block = shouldBlock(verdict, priorBlocks, cap);
  const overall = verdict.error
    ? "error"
    : verdict.claims.some((c) => c.verdict === "contradicted")
      ? "contradicted"
      : flagged.length
        ? "unsupported"
        : verdict.claims.length
          ? "supported"
          : "no-claim";

  logFiring({
    harness: harnessName(),
    event: "stop",
    claim: material.finalMessage.slice(0, 400),
    verdict: overall,
    caught: flagged.map((c) => `${c.claim} — ${c.verdict}: ${c.basis}`).join("; "),
    blocked: block,
    dir: args.wd,
    auditor_tier: verdict.sameFamily ? "same_family" : verdict.auditorTier === "absent" ? "absent" : verdict.auditorTier,
    scheduling_mode: job.mode,
    turn_ref: job.turnRef,
    audit_duration_ms: verdict.auditDurationMs,
  });

  if (!block) {
    const line = buildFeedbackLine(verdict);
    if (line) writePendingFeedback(args.wd, args.sessionId, line);
    return 0;
  }

  writeBlockCount(qdir, args.sessionId, priorBlocks + 1);
  const emission = emitBlock(harnessName(), formatBlockReason(verdict), args.force);
  if (emission.stdout) process.stdout.write(emission.stdout);
  if (emission.stderr) process.stderr.write(emission.stderr + (emission.stderr.endsWith("\n") ? "" : "\n"));
  return emission.exitCode;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const dir = process.cwd();

  switch (cmd) {
    case "install": {
      const target = positional(rest)[0];
      const global = flag(rest, "global");
      const project = flag(rest, "project");
      console.log(style.banner("veritaserum · install", "ground-truth sentinel for coding agents"));
      console.log();
      if (!target) {
        console.log(`  usage: ${style.bold(`veritaserum install <${TARGETS.join("|")}>`)} ${style.dim("[--global]")}`);
        const found = detectHarnesses();
        console.log();
        if (found.length) {
          console.log(`  detected here: ${found.map((t) => style.cyan(t)).join(", ")}`);
          console.log(style.step(`e.g. ${style.bold(`veritaserum install ${found[0]}`)}`));
        } else {
          console.log(style.dim("  no harness config found (~/.claude, ~/.config/goose, ~/.codex)"));
        }
        return 0;
      }
      if (!isTarget(target)) {
        console.error(`  ${style.cross} unknown target ${style.bold(target)} — expected one of ${TARGETS.join(", ")}`);
        return 2;
      }
      const res = await installTarget(target, { global, project });
      for (const line of res.steps) console.log(line);
      if (res.manual.length) {
        console.log();
        console.log(`  ${style.yellow("finish by hand:")}`);
        for (const m of res.manual) console.log(`  ${m}`);
      }
      // PROVE IT. Writing a config file is not an install: five separate defects in one day
      // were all "installed, reported installed, did nothing". Execute the hook the harness
      // will actually execute, in a scrubbed environment, and assert its effect. Refuse to
      // claim success we have not demonstrated.
      const verdicts = target === "goose" ? [] : await selfcheck(target);
      if (verdicts.length) {
        console.log();
        console.log(`  ${style.bold("verifying the installed hook actually runs")}`);
        for (const c of verdicts) {
          console.log(`  ${c.ok ? style.check : style.cross} ${c.name} ${style.dim(`— ${c.detail}`)}`);
        }
      }
      const broken = verdicts.filter((c) => !c.ok);

      console.log();
      console.log(style.divider());
      if (broken.length) {
        console.log(`  ${style.cross} ${style.bold(target)} is NOT working — ${broken.length} check(s) failed above.`);
        console.log(style.step("the hook is written to config but does not do its job; fix the failures, then re-run install"));
        console.log(style.step(`re-check any time:  ${style.bold(`veritaserum selfcheck ${target}`)}`));
        return 1;
      }
      console.log(style.ok(`${style.bold(target)} wired — veritaserum now audits every turn-end.`));
      console.log(
        style.step(
          target === "goose"
            ? "Default is still warn-primary (R5). Goose has no prompt-injection channel; verdicts land in telemetry unless blocking is on."
            : "Default is still warn-primary (R5). A verdict lands as one line at your next prompt unless blocking is on.",
        ),
      );
      console.log(style.step(`Captain override: set ${style.bold("VS_BLOCK=1")} to block a confident confabulation (at most 2 times per session). Off: unset or ${style.bold("VS_BLOCK=0")}.`));
      console.log(style.step(`Jev auditor: set ${style.bold("TYPESAFE_API_KEY")} (never on argv; header only). Count detections: ${style.bold("veritaserum telemetry")}.`));
      return 0;
    }

    case "selfcheck": {
      // Drift is the norm, not the exception: an upgrade moves a path, a node version
      // changes, a harness revokes trust, someone edits a config. The install-time proof
      // expires. This re-runs it against whatever is installed RIGHT NOW.
      const targets = (positional(rest)[0] ? [positional(rest)[0]] : detectHarnesses()).filter((t): t is Target =>
        isTarget(String(t)),
      );
      if (!targets.length) {
        console.error(`  ${style.cross} no harness found — expected one of ${TARGETS.join(", ")}`);
        return 2;
      }
      let failed = 0;
      for (const t of targets) {
        if (t === "goose") continue;
        console.log(`  ${style.bold(t)}`);
        const results = await selfcheck(t);
        for (const c of results) {
          console.log(`  ${c.ok ? style.check : style.cross} ${c.name} ${style.dim(`— ${c.detail}`)}`);
          if (!c.ok) failed++;
        }
        console.log();
      }
      if (failed) {
        console.error(`  ${style.cross} ${failed} check(s) failed — veritaserum is installed but not doing its job`);
        return 1;
      }
      console.log(style.ok("every installed hook runs and reaches the model"));
      return 0;
    }

    case "telemetry": {
      console.log(summarize(readFirings()));
      return 0;
    }

    case "doctor": {
      const executor = process.env.VS_EXECUTOR || "unknown";
      const r = await doctorReport(executor);
      console.log(style.banner("veritaserum · doctor", "auditor resolution (SPEC §2)"));
      console.log();
      console.log(`  executor: ${style.bold(r.executor)} (family: ${r.family})`);
      console.log();
      console.log(`  candidates:`);
      for (const c of r.candidates) {
        const mark = c.ok ? style.ok(c.vendor) : style.cross + " " + c.vendor;
        const fired = c.firedRule ? style.dim(` — fired: ${c.firedRule}`) : "";
        console.log(`    ${mark}: ${c.detail}${fired}`);
      }
      console.log();
      console.log(`  chosen: ${style.bold(`${r.chosen.vendor}${r.chosen.model ? `:${r.chosen.model}` : ""}`)} (tier: ${r.chosen.tier}${r.chosen.sameFamily ? ", same-family" : ""})`);
      console.log(`  rule: ${r.chosen.rule}`);
      console.log();
      if (r.chosen.vendor === "jev") {
        console.log(style.step("Jev (typesafe System One) — Choice auditor, cross-family, ~350ms. Blocking uses this path when VS_BLOCK=1."));
      } else if (r.chosen.tier === "absent") {
        console.log(style.step("no auditor available — mechanical standing-law checks still run (R8); no LLM audit."));
        console.log(style.step("upgrade: set TYPESAFE_API_KEY for Jev, install codex or claude on PATH, or set OPENROUTER_API_KEY / VS_AUDITOR_METERED=<vendor:model>."));
      } else if (r.chosen.sameFamily) {
        console.log(style.step(`upgrade: install a cross-family CLI (${r.chosen.vendor === "codex" ? "claude" : "codex"}) to drop the same-family warning, or set TYPESAFE_API_KEY for Jev.`));
      } else if (r.chosen.tier === "pre-gathered") {
        console.log(style.step("upgrade: install codex or claude on PATH for an agentic auditor (own read-only probes, not pre-gathered evidence)."));
      } else {
        console.log(style.step("agentic, cross-family — no upgrade needed."));
      }
      console.log(style.step("override any rule with VS_AUDITOR=<vendor[:model]>."));
      return 0;
    }

    // --- harness hook entrypoints (Archetype A). Read JSON HookContext on stdin. ---
    case "hook-stop": {
      // v3 sync path (SPEC §2 "the mechanism"): deterministic, no LLM, no claim
      // regex (R2 — claim identification is the async auditor's judgment only).
      if (isAuditorChild()) return 0;
      try {
        const p = parsePayload(await readStdin());
        const wd = payloadDir(p, dir);
        const qdir = queueRoot(wd);
        const marker = readLastAudit(qdir);

        // a. Nothing-to-audit: no tool activity since the last audit marker → PASS, ~0ms.
        if (!hasNewToolActivity(p, marker)) return 0;

        // b. Captain override of R5: VS_BLOCK=1 runs a synchronous Jev audit and
        //    may block. Fail-open (return -1) falls through to the async enqueue.
        if (isBlockEnabled()) {
          const sessionId = sessionIdOf(p, wd);
          const blockCode = await runSynchronousBlock({ payload: p, wd, sessionId, force: false });
          const next: LastAudit = { ts: Date.now(), ccTranscriptSize: marker.ccTranscriptSize };
          if (p.transcript_path) {
            try {
              next.ccTranscriptSize = { ...next.ccTranscriptSize, [p.transcript_path]: statSync(p.transcript_path).size };
            } catch {
              /* best-effort */
            }
          }
          writeLastAudit(qdir, next);
          if (blockCode >= 0) return blockCode;
          // Jev unavailable — fall through to async enqueue, never block on our own absence.
        }

        // c. Enqueue the async audit job; dispatch is fire-and-forget (audit-runner.js
        //    owns lockfile serialization + LIVE-supersede/TESTBED-drain scheduling).
        const job: AuditJob = {
          dir: wd,
          sessionId: sessionIdOf(p, wd),
          turnRef: String(Date.now()),
          mode: process.env.VS_AUDIT_MODE === "testbed" ? "testbed" : "live",
          ...(p.transcript_path ? { transcriptPath: p.transcript_path } : {}),
          ...(typeof p.last_assistant_message === "string" ? { finalMessage: p.last_assistant_message } : {}),
          harness: harnessName(),
          executor: process.env.VS_EXECUTOR || "unknown",
          ...(process.env.VS_AUDITOR ? { auditor: process.env.VS_AUDITOR } : {}),
        };
        enqueue(wd, job);

        const next: LastAudit = { ts: Date.now(), ccTranscriptSize: marker.ccTranscriptSize };
        if (p.transcript_path) {
          try {
            next.ccTranscriptSize = { ...next.ccTranscriptSize, [p.transcript_path]: statSync(p.transcript_path).size };
          } catch {
            /* best-effort */
          }
        }
        writeLastAudit(qdir, next);
        return 0;
      } catch (err) {
        // d. R8: any internal error → exit 0, never surface to (or stall) the executor.
        logFiring({
          harness: harnessName(),
          event: "stop",
          claim: "",
          verdict: "error",
          caught: err instanceof Error ? err.message : String(err),
          blocked: false,
          dir,
        });
        return 0;
      }
    }

    // Goose blocking plugin (adapters/goose/hooks/hooks-block.json). Same
    // captain-override path as VS_BLOCK=1 on hook-stop. VS_BLOCK=0 is the off
    // switch even for this plugin.
    case "hook-stop-goose-block": {
      if (isAuditorChild()) return 0;
      if (isBlockExplicitlyOff()) return 0;
      try {
        const p = parsePayload(await readStdin());
        const wd = payloadDir(p, dir);
        const sessionId = sessionIdOf(p, wd);
        const code = await runSynchronousBlock({ payload: p, wd, sessionId, force: true });
        return code < 0 ? 0 : code;
      } catch (err) {
        logFiring({
          harness: harnessName(),
          event: "stop",
          claim: "",
          verdict: "error",
          caught: err instanceof Error ? err.message : String(err),
          blocked: false,
          dir,
        });
        return 0;
      }
    }

    case "hook-prompt": {
      // v3 feedback channel (SPEC §2 "Feedback channels", R7): the ONLY
      // injection door — stdout at UserPromptSubmit becomes the harness's
      // additionalContext. Never a prompt-time challenge (SPEC §4: the
      // prompt-time challenge is deleted, and the Knight behind it is gone).
      // Terse, sharp, non-stale (<24h), printed once then cleared. Never
      // blocks (R8): any internal error just means no line this turn.
      try {
        const p = parsePayload(await readStdin());
        const wd = payloadDir(p, dir);
        // Deliver ONLY the prompting session's feedback (both Stop and
        // UserPromptSubmit carry session_id; Claude Code's transcript_path stands
        // in as the session key, matching hook-stop's sessionIdOf). A payload that
        // omits BOTH has no session identity — fall back to the old repo-scoped
        // drain (R8) so a payload-shape change never strands feedback; tag which
        // path delivered.
        const sid = p.session_id || p.transcript_path;
        // The verdict looks BACKWARD (what the last turn claimed — inherently next-turn
        // news, since the audit is async), delivered at the only moment the executor can
        // still act on it.
        const scope: "session" | "repo-fallback" = sid ? "session" : "repo-fallback";
        const own = sid ? takePendingFeedback(wd, sid) : drainAllPendingFeedback(wd);
        // Door 1 (autonomous-fleet delivery): after this session's OWN line, sweep up
        // to 3 strays — another session's undelivered feedback in this repo, past the
        // 10-min grace. This is the only way an autonomous session's catches (a
        // one-shot scheduled run, or a turn ended by a task notification) ever reach a
        // human. No sid → drainAllPendingFeedback already swept EVERY file above, so
        // there are no strays left to gather.
        const strays = sid ? takeStrayFeedback(wd, sid) : [];
        const combined = [own, ...strays].filter((l): l is string => !!l).join("\n");
        if (combined) {
          console.log(injectionFor(harnessName(), combined));
          // SPEC §7 ledger discipline: record ONLY this session's OWN line for the
          // advisory-outcome audit — the next audit must never be asked whether this
          // session acted on ANOTHER session's warning. Strays were consumed from the
          // store (never redelivered) but are deliberately NOT ledgered here.
          if (sid && own) recordDeliveredWarning(wd, sid, own);
          logFiring({
            harness: harnessName(),
            event: "prompt",
            claim: "",
            verdict: "delivered",
            // caught stays empty: the audit that earned this warning already
            // counted it — re-counting the delivery would inflate summarize()'s
            // catch total. The delivery path itself is the payload here.
            caught: "",
            blocked: false,
            dir: wd,
            // A stray sweep is the new door; tag it so telemetry separates
            // autonomous-fleet delivery from the normal own-session path.
            feedback_scope: strays.length ? "stray" : scope,
          });
        }
        return 0;
      } catch (err) {
        logFiring({
          harness: harnessName(),
          event: "prompt",
          claim: "",
          verdict: "error",
          caught: err instanceof Error ? err.message : String(err),
          blocked: false,
          dir,
        });
        return 0;
      }
    }

    case "hook-session-start": {
      // Door 2 (autonomous-fleet delivery): SessionStart fires before any prompt, so
      // there is no OWN-session feedback yet — sweep ONLY strays (another session's
      // undelivered feedback in this repo, past the 10-min grace). SessionStart stdout
      // becomes the session's initial context, so a fresh interactive session drains
      // the autonomous fleet's rotting catches on the way in. Same injection shape as
      // UserPromptSubmit, only the hookEventName differs. Fail-open (R8): any error →
      // exit 0, silent when there are no strays.
      try {
        const p = parsePayload(await readStdin());
        const wd = payloadDir(p, dir);
        // A fresh session's own id (if any): pass it as the exclude key so a stray that
        // happens to key to this same id is left for its owner. There is normally no
        // own file yet, so excluding is belt-and-suspenders.
        const sid = p.session_id || p.transcript_path || "";
        const strays = takeStrayFeedback(wd, sid);
        if (strays.length) {
          console.log(injectionFor(harnessName(), strays.join("\n"), "SessionStart"));
          // No recordDeliveredWarning: strays are never ledgered to the delivering
          // session (SPEC §7 — see takeStrayFeedback), and this session has no own line.
          logFiring({
            harness: harnessName(),
            event: "prompt", // reuse the prompt event (least invasive: no telemetry
            claim: "",        // union change); the "stray" scope marks it as Door 2.
            verdict: "delivered",
            caught: "",
            blocked: false,
            dir: wd,
            feedback_scope: "stray",
          });
        }
        return 0;
      } catch (err) {
        logFiring({
          harness: harnessName(),
          event: "prompt",
          claim: "",
          verdict: "error",
          caught: err instanceof Error ? err.message : String(err),
          blocked: false,
          dir,
        });
        return 0;
      }
    }

    default:
      return usage("<install|selfcheck|doctor|telemetry|hook-stop|hook-stop-goose-block|hook-prompt|hook-session-start>");
  }
}

function usage(spec: string): number {
  console.error(`usage: veritaserum ${spec}`);
  return 2;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`ser: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) console.error(err.stack.split("\n").slice(1, 3).join("\n"));
    process.exit(2);
  });
