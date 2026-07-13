#!/usr/bin/env node
/**
 * `veritaserum` CLI (DESIGN §4) — the enforcement door a hook shells out to.
 *   veritaserum install <harness>              wire veritaserum's sync path into a harness
 *   veritaserum doctor                        which auditor rule fired and why (SPEC §2)
 *   veritaserum retire <law-id> "<reason>"      retire a standing case-law entry
 *   veritaserum demands                        run the demands the auditor materialized
 *   veritaserum telemetry                      what the auditor caught
 *
 * Exit codes: errors -> 2.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { commitPaths, currentTreeHash } from "./git.js";
import { loadLaw, retireDemandLaw, retireLaw, runnableChecks, LAW_FILENAME } from "./law.js";
import { resolveAuditor, doctorReport } from "./resolve.js";
import { enqueue, queueRoot, lawCheckMarkerPath, takePendingFeedback, type AuditJob } from "./audit-runner.js";
import { runDemands, retireDemand } from "./demands.js";
import { hasToolActivitySince, readGooseSession, defaultGooseSessionsDb } from "./goose.js";
import { audit, type AuditJob as AuditContentJob } from "./auditor.js";
import { logFiring, readFirings, summarize } from "./telemetry.js";
import { installTarget, detectHarnesses, isTarget, TARGETS } from "./install.js";
import * as style from "./style.js";
import { writeHookLawState } from "./hook-state.js";

/** Which harness fired us (installer sets VS_HARNESS). */
function harnessName(): string {
  return process.env.VS_HARNESS || "unknown";
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
 * hook-stop-goose-block's per-session block cap (R3: never deadlock a
 * synchronous blocking loop) — ~/.veritaserum/queue/<repo-key>/block-count/
 * <session>.json, a counter of how many times THIS session has already been
 * blocked (exit 2), not how many times it's been audited. Same best-effort,
 * never-throws shape as audit-runner.ts's session-warnings store.
 */
function sanitizeForFile(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function blockCountPath(qdir: string, sessionId: string): string {
  return join(qdir, "block-count", `${sanitizeForFile(sessionId)}.json`);
}
function readBlockCount(qdir: string, sessionId: string): number {
  try {
    const v = JSON.parse(readFileSync(blockCountPath(qdir, sessionId), "utf8")) as { count?: number };
    return typeof v.count === "number" ? v.count : 0;
  } catch {
    return 0;
  }
}
function writeBlockCount(qdir: string, sessionId: string, count: number): void {
  try {
    const p = blockCountPath(qdir, sessionId);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ count }), "utf8");
  } catch {
    /* best-effort (R8) */
  }
}

/**
 * Sync step 2 (SPEC R7): standing law exists and the tree hasn't been
 * confirmed green at its current state — print ONE terse line, never a
 * block. The marker (src/audit-runner.ts's lawCheckMarkerPath) is the tree
 * hash at the last GREEN mechanical run of every runnable check
 * (src/run-audit.ts writes it after a passing async audit) — this is
 * precise, not a once-per-hash print dedupe: the line fires on every due
 * turn until an actual green run clears it, and again the moment the tree
 * next moves.
 */
async function printLawStateLineIfDue(dir: string): Promise<void> {
  const { law } = await loadLaw(dir);
  const runnable = runnableChecks(law);
  if (runnable.length === 0) return;
  const hash = await currentTreeHash(dir);
  let lastGreen = "";
  try {
    lastGreen = readFileSync(lawCheckMarkerPath(dir), "utf8").trim();
  } catch {
    /* no green run recorded yet for this repo */
  }
  if (lastGreen === hash) return;
  const line = `veritaserum: ${runnable.length} standing check(s) unverified against current tree`;
  // Codex Stop rejects plain stdout even on exit 0. `systemMessage` is the
  // documented non-blocking common output field; Claude Code accepts the terse
  // text directly.
  console.log(harnessName() === "codex" ? JSON.stringify({ systemMessage: line }) : line);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const dir = process.cwd();

  switch (cmd) {
    case "retire": {
      const lawId = rest[0];
      const reason = rest.slice(1).join(" ").trim();
      if (!lawId || !reason) return usage('retire <law-id|demand-slug> "<reason>"');
      // Demands live in the state dir (docs/DEMANDS.md phase 1) — try there first.
      if (retireDemand(dir, lawId)) {
        if (await retireDemandLaw(dir, lawId, reason)) {
          await commitPaths(dir, [LAW_FILENAME], `ser: retire demand ${lawId} (${reason})`);
        }
        console.log(`retired demand ${lawId}: ${reason} (moved to retired/, never resurrected)`);
        return 0;
      }
      const ok = await retireLaw(dir, lawId, reason);
      if (!ok) {
        console.log(`no active law entry or demand "${lawId}" to retire`);
        return 0;
      }
      await commitPaths(dir, [LAW_FILENAME], `ser: retire law ${lawId} (${reason})`);
      console.log(`retired ${lawId}: ${reason} (recorded, not deleted)`);
      return 0;
    }

    case "demands": {
      // A demand that invokes `veritaserum demands` would otherwise execute
      // itself recursively. Signal the outer evaluator and stop before reading
      // any oracle. runScript also rejects known source shapes pre-execution.
      const recursionSentinel = process.env.VS_DEMAND_EVALUATION_SENTINEL;
      if (recursionSentinel) {
        try {
          writeFileSync(recursionSentinel, String(process.pid), "utf8");
        } catch {
          /* the refusal itself does not depend on recording the sentinel */
        }
        console.error("refusing recursive demand evaluation");
        return 1;
      }
      // The demand store is invisible by design — this is the human window into it.
      const results = await runDemands(dir);
      if (!results.length) {
        console.log("no standing demands for this repo");
        return 0;
      }
      for (const d of results) {
        console.log(`${d.passed ? "✓ met  " : "✗ unmet"}  ${d.slug}`);
        if (d.remedy) console.log(`         ${d.remedy}${d.accept ? ` — accept: ${d.accept}` : ""}`);
      }
      console.log(`\nretire one: veritaserum retire <slug> "<reason>"`);
      return 0;
    }

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
      try {
        const { law } = await loadLaw(dir);
        writeHookLawState(dir, { runnableCount: runnableChecks(law).length });
      } catch {
        // A missing/empty/corrupt repo still gets a fail-open hook installation.
      }
      for (const line of res.steps) console.log(line);
      if (res.manual.length) {
        console.log();
        console.log(`  ${style.yellow("finish by hand:")}`);
        for (const m of res.manual) console.log(`  ${m}`);
      }
      console.log();
      console.log(style.divider());
      console.log(style.ok(`${style.bold(target)} wired — veritaserum now audits every turn-end.`));
      console.log(
        style.step(
          target === "goose"
            ? "warn-primary (R5): nothing blocks. Goose exposes no prompt injection channel; verdicts land in telemetry."
            : "warn-primary (R5): nothing blocks. A verdict lands as one line at your next prompt.",
        ),
      );
      console.log(style.step(`read catches:  ${style.bold("veritaserum telemetry")}`));
      console.log(style.step(`run demanded checks:  ${style.bold("veritaserum demands")}`));
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
      if (r.chosen.tier === "absent") {
        console.log(style.step("no auditor available — mechanical standing-law checks still run (R8); no LLM audit."));
        console.log(style.step("upgrade: install codex or claude on PATH, or set OPENROUTER_API_KEY / VS_AUDITOR_METERED=<vendor:model>."));
      } else if (r.chosen.sameFamily) {
        console.log(style.step(`upgrade: install a cross-family CLI (${r.chosen.vendor === "codex" ? "claude" : "codex"}) to drop the same-family warning.`));
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

        // b. Standing-law state line (R7): terse, best-effort, never blocks even
        //    on its own internal failure (a corrupt law file shouldn't cancel c).
        try {
          await printLawStateLineIfDue(wd);
        } catch {
          /* advisory only */
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
          demandMode: process.env.VS_DEMAND_MODE === "urge" ? "urge" : "script",
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

    // Alternative goose Stop mode (SPEC-adjacent experiment, not the v3 mechanism
    // above): goose 1.41.0 has no additionalContext-style injection channel, but a
    // Stop hook that exits 2 with a reason on stderr BLOCKS turn-end — goose prints
    // "Stop hook blocked ending this turn" and feeds the stderr text back to the
    // agent, which then acts on it (verified this session, DeepSeek). This mode
    // trades R3's "sync path is deterministic and near-free" for a SYNCHRONOUS,
    // BLOCKING audit so the corrective loop itself can be tested end-to-end.
    // `hook-stop` above is untouched — this is a separate, opt-in plugin variant
    // (adapters/goose/hooks/hooks-block.json).
    case "hook-stop-goose-block": {
      if (isAuditorChild()) return 0;
      try {
        const p = parsePayload(await readStdin());
        const wd = payloadDir(p, dir);
        const sessionId = sessionIdOf(p, wd);

        // a. Load the turn synchronously from goose's own sessions.db. No final
        //    message → nothing to audit, exit 0 (R8 fail-open).
        const session = readGooseSession(sessionId);
        if (!session.finalAssistantMessage) return 0;

        // b. Per-session block cap (R3): once this session has already been
        //    blocked >= cap times, let it finish no matter the verdict — never
        //    deadlock the turn. Checked BEFORE the (expensive) audit call.
        const qdir = queueRoot(wd);
        const capEnv = Number(process.env.VS_BLOCK_CAP);
        const cap = Number.isFinite(capEnv) && capEnv > 0 ? capEnv : 2;
        const priorBlocks = readBlockCount(qdir, sessionId);
        if (priorBlocks >= cap) return 0;

        // c. Resolve the cross-family auditor and run it SYNCHRONOUSLY — this is
        //    the blocking path (an agentic auditor call, ~30-60s, is expected here;
        //    that's the point of the experiment).
        const auditor = await resolveAuditor(process.env.VS_EXECUTOR || "unknown");
        const contentJob: AuditContentJob = {
          dir: wd,
          sessionId,
          finalMessage: session.finalAssistantMessage,
          userRequest: session.userRequest ?? "",
          ...(session.receiptsTail ? { receipts: session.receiptsTail } : {}),
        };
        const verdict = await audit(contentJob, auditor);

        // d. Flagged = unsupported/contradicted claims, or R9 unaccountable work.
        const flagged = verdict.claims.filter((c) => c.verdict === "unsupported" || c.verdict === "contradicted");
        const blocked = flagged.length > 0 || verdict.unaccountable;
        const overall = verdict.error
          ? "error"
          : verdict.claims.some((c) => c.verdict === "contradicted")
            ? "contradicted"
            : blocked
              ? "unsupported"
              : verdict.claims.length
                ? "supported"
                : "no-claim";

        logFiring({
          harness: harnessName(),
          event: "stop",
          claim: session.finalAssistantMessage.slice(0, 400),
          verdict: overall,
          caught: flagged.map((c) => `${c.claim} — ${c.verdict}: ${c.basis}`).join("; "),
          blocked,
          dir: wd,
        });

        if (!blocked) return 0;

        writeBlockCount(qdir, sessionId, priorBlocks + 1);

        const n = flagged.length + (verdict.unaccountable ? 1 : 0);
        const lines = [`veritaserum: ${n} claim(s) not backed by a verification receipt:`];
        for (const c of flagged) lines.push(`  - ${c.claim}: ${c.basis || c.evidence || "no basis given"}`);
        if (verdict.unaccountable) lines.push(`  - unaccountable work: ${verdict.note || "state what was done and how you know it works"}`);
        for (const d of verdict.demands) lines.push(`  demand: ${d.remedy || d.gap} — accept: ${d.accept}`);
        lines.push(`Run the actual check and correct or retract before finishing.`);
        console.error(lines.join("\n"));
        return 2;
      } catch (err) {
        // e. R8: any internal error → exit 0, never block on our own failure.
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
      // Knight's challenge only fires inside a live contract negotiation).
      // Terse, sharp, non-stale (<24h), printed once then cleared. Never
      // blocks (R8): any internal error just means no line this turn.
      try {
        const p = parsePayload(await readStdin());
        const wd = payloadDir(p, dir);
        const line = takePendingFeedback(wd);
        if (line) console.log(line);
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
      return usage("<install|doctor|retire|demands|telemetry|hook-stop|hook-stop-goose-block|hook-prompt>");
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
