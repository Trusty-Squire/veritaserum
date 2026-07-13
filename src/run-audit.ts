/**
 * The audit execution hub (SPEC.md §2 "audit job") — the piece `audit-runner.ts`
 * dispatches into and `resolve.ts`/`auditor.ts`/`goose.ts`/`transcript.ts` do the
 * real work for. `runAudit` is the `RunAudit` the detached runner bootstraps by
 * default (audit-runner.ts's `defaultRunAuditModule`); `VS_AUDIT_RUNNER_MODULE`
 * still overrides it.
 *
 * Steps (mirroring SPEC §2 "audit job"):
 *  1. load the turn's material — goose's sessions.db when the job carries a
 *     goose session id, or a Claude Code transcript when it carries one (the
 *     dispatch job's `transcriptPath` distinguishes the two harness shapes).
 *  2. resolve the cross-family auditor for VS_EXECUTOR and hand it + the
 *     material to `audit()` (src/auditor.ts) — one auditor invocation.
 *  3. after a run whose mechanical standing-law checks ALL pass, clear/update
 *     the "last green" tree-hash marker cli.ts's terse state line reads (SPEC
 *     R7) — this is what makes that line track real verification status
 *     instead of a once-per-hash print dedupe.
 *
 * Never throws (R8): audit-runner.ts's drain loop already treats a thrown
 * runAudit as a dead job + telemetry, but every step here is itself
 * defensive/best-effort so that path is a last resort, not the normal one.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readGooseSession } from "./goose.js";
import { readLastAssistantMessage, readLastUserMessage, readReceiptsTail } from "./transcript.js";
import { resolveAuditor } from "./resolve.js";
import { demandsCommand } from "./install.js";
import { audit, type AuditJob as AuditContentJob, type AuditVerdict } from "./auditor.js";
import {
  appendSessionWarnings,
  lawCheckMarkerPath,
  loadSessionWarnings,
  writePendingFeedback,
  type AuditJob,
  type RunAudit,
} from "./audit-runner.js";
import { currentTreeHash } from "./git.js";
import { writeHookLawState } from "./hook-state.js";

/** Step 1: the turn's final message, the user's request, and a receipt tail —
 *  from goose's sessions.db (session id) or a Claude Code transcript (path). */
function loadTurnMaterial(job: AuditJob): { finalMessage: string; userRequest: string; receipts?: string } {
  if (job.transcriptPath) {
    const finalMessage = job.finalMessage ?? readLastAssistantMessage(job.transcriptPath);
    const userRequest = job.userRequest ?? readLastUserMessage(job.transcriptPath);
    const receipts = readReceiptsTail(job.transcriptPath);
    return { finalMessage, userRequest, ...(receipts ? { receipts } : {}) };
  }
  const session = readGooseSession(job.sessionId);
  return {
    finalMessage: session.finalAssistantMessage ?? "",
    userRequest: session.userRequest ?? "",
    ...(session.receiptsTail ? { receipts: session.receiptsTail } : {}),
  };
}

/**
 * Claude Code feedback channel (SPEC §2 "Feedback channels", R7): one terse,
 * sharp, specific line for the next UserPromptSubmit — never chatty, never
 * ambient. Built only when there's something to say (warnings, a fresh demand,
 * or R9 unaccountable work); returns null otherwise (nothing gets queued).
 */
function buildFeedbackLine(verdict: AuditVerdict): string | null {
  if (!verdict.warnings.length && !verdict.demands.length && !verdict.unaccountable) return null;

  const worst = verdict.claims.find((c) => c.verdict === "contradicted") ?? verdict.claims.find((c) => c.verdict === "unsupported");
  let head: string;
  if (worst) {
    head = `last turn claimed "${worst.claim}" — ${worst.verdict}${worst.basis ? `: ${worst.basis}` : ""}`;
  } else if (verdict.unaccountable) {
    head = `last turn: unaccountable work${verdict.note ? ` — ${verdict.note}` : ""}`;
  } else {
    head = verdict.warnings[0] ?? "new standing check appended";
  }
  // The demand line is the instruction, not a nudge (docs/DEMANDS.md §2.2):
  // remedy + accept verbatim, so the executor knows what to produce and what
  // will be accepted.
  //
  // It also names the command that runs the check. This is the ONLY discoverability
  // channel the executor gets, and it is deliberately just-in-time: no standing
  // CLAUDE.md rule, no MCP tool list, no ambient prompt tax — the instruction arrives
  // in the turn where it is actionable, and says nothing on every other turn. The
  // auditor already WROTE the failing check (in veritaserum's state dir, not the repo),
  // so the executor's job is to run it, not to author its own oracle.
  const demand = verdict.demands[0];
  const tail = demand
    ? `; DEMAND: ${demand.remedy || demand.gap} — accept: ${demand.accept}` +
      `; the check is already written — run \`${demandsCommand()}\` (do not write your own)`
    : "";
  return `veritaserum: ${head}${tail}`.slice(0, 600);
}

/** Step 3: a GREEN mechanical recheck of every runnable standing-law entry
 *  clears the terse-line marker for the tree state that just verified.
 *  Best-effort (R8) — a write failure just means the line stays due next turn. */
async function markGreenIfAllPassed(job: AuditJob, verdict: Awaited<ReturnType<typeof audit>>): Promise<void> {
  if (!verdict.mechanicalChecks.length) return; // nothing runnable — no green state to record
  if (!verdict.mechanicalChecks.every((c) => c.passed)) return; // still red — leave the marker as-is
  try {
    const hash = await currentTreeHash(job.dir);
    const markerPath = lawCheckMarkerPath(job.dir);
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, hash, "utf8");
  } catch {
    /* best-effort marker (R8) */
  }
}

export const runAudit: RunAudit = async (job: AuditJob): Promise<void> => {
  const { finalMessage, userRequest, receipts } = loadTurnMaterial(job);

  const executor = job.executor || "unknown";
  const auditor = await resolveAuditor(executor, job.auditor);

  // R5 (SPEC §6.5): load this session's already-surfaced warnings so the audit
  // never repeats a verbatim duplicate; append whatever's new once it's done.
  const priorWarnings = loadSessionWarnings(job.dir, job.sessionId);

  const contentJob: AuditContentJob = {
    dir: job.dir,
    sessionId: job.sessionId,
    turnRef: job.turnRef,
    finalMessage,
    userRequest,
    ...(receipts ? { receipts } : {}),
    ...(priorWarnings.length ? { priorWarnings } : {}),
    harness: job.harness || "unknown",
    schedulingMode: job.mode,
    demandMode: job.demandMode || "script",
  };
  const verdict = await audit(contentJob, auditor);
  writeHookLawState(job.dir, {
    runnableCount: verdict.mechanicalChecks.filter((check) => !check.gateId.startsWith("demand:")).length,
  });
  appendSessionWarnings(job.dir, job.sessionId, verdict.warnings);

  // Feedback channel (SPEC §2, R7): a fresh warn/demand/unaccountable verdict
  // queues one terse line for the next UserPromptSubmit (cli.ts's hook-prompt
  // case). Best-effort (R8) — writePendingFeedback never throws.
  const line = buildFeedbackLine(verdict);
  if (line) writePendingFeedback(job.dir, line);

  await markGreenIfAllPassed(job, verdict);
};
