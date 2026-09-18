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
 *     material to `audit()` (src/auditor.ts) — one auditor invocation plus the
 *     no-LLM grounding tier.
 *
 * Never throws (R8): audit-runner.ts's drain loop already treats a thrown
 * runAudit as a dead job + telemetry, but every step here is itself
 * defensive/best-effort so that path is a last resort, not the normal one.
 */
import { readGooseSession } from "./goose.js";
import { readLastAssistantMessage, readLastUserMessage, readReceiptsTail, readConversationTail } from "./transcript.js";
import { resolveAuditor, isExhausted } from "./resolve.js";
import { audit, type AuditJob as AuditContentJob, type AuditVerdict } from "./auditor.js";
import { logFiring } from "./telemetry.js";
import {
  appendSessionWarnings,
  appendVerifiedClaims,
  loadSessionWarnings,
  loadVerifiedClaims,
  takeDeliveredWarnings,
  writePendingFeedback,
  type AuditJob,
  type RunAudit,
} from "./audit-runner.js";

/** Step 1: the turn's final message, the user's request, and a receipt tail —
 *  from goose's sessions.db (session id) or a Claude Code transcript (path). */
export function loadTurnMaterial(job: AuditJob): { finalMessage: string; userRequest: string; receipts?: string; conversationTail?: string } {
  if (job.transcriptPath) {
    const finalMessage = job.finalMessage ?? readLastAssistantMessage(job.transcriptPath);
    const userRequest = job.userRequest ?? readLastUserMessage(job.transcriptPath);
    const receipts = readReceiptsTail(job.transcriptPath);
    const conversationTail = readConversationTail(job.transcriptPath);
    return { finalMessage, userRequest, ...(receipts ? { receipts } : {}), ...(conversationTail ? { conversationTail } : {}) };
  }
  // A payload-supplied final message (codex's documented content field — "never
  // discard") is authoritative even without a transcript path; only a job with
  // neither falls through to goose's sessions.db.
  if (typeof job.finalMessage === "string") {
    return { finalMessage: job.finalMessage, userRequest: job.userRequest ?? "" };
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
 * ambient. The humane line is built ONCE in auditor.ts (claimWarning et al.,
 * addressed to the executor and ordered worst-first), so this just prefixes the
 * source tag to the lead warning. Returns null when there's nothing to say.
 *
 * DELIVERY POLICY: the pending-feedback file draws from `deliverableWarnings`, NOT
 * the full `warnings` set — under VS_DELIVERY=quiet a suppressed warning is deduped
 * and telemetered but must never interrupt the next turn.
 */
export function buildFeedbackLine(verdict: AuditVerdict): string | null {
  const lead = verdict.deliverableWarnings[0];
  if (!lead) return null;
  return `veritaserum: ${lead}`.slice(0, 600);
}
}

export const runAudit: RunAudit = async (job: AuditJob): Promise<void> => {
  const { finalMessage, userRequest, receipts, conversationTail } = loadTurnMaterial(job);

  const executor = job.executor || "unknown";
  const auditor = await resolveAuditor(executor, job.auditor);

  // R5 (SPEC §6.5): load this session's already-surfaced warnings so the audit
  // never repeats a verbatim duplicate; append whatever's new once it's done.
  const priorWarnings = loadSessionWarnings(job.dir, job.sessionId);

  // SPEC §7 advisory outcome: warning line(s) DELIVERED to this session before
  // this turn (cli.ts records them at injection). Drained once, so the LLM
  // auditor judges each delivered warning's outcome exactly once.
  const deliveredWarnings = takeDeliveredWarnings(job.dir, job.sessionId);

  // FIX 2: claims this session verified (supported + named evidence) on an earlier
  // turn, so audit() can ground a re-asserted claim whose receipt scrolled out.
  const verifiedClaims = loadVerifiedClaims(job.dir, job.sessionId);

  const contentJob: AuditContentJob = {
    dir: job.dir,
    sessionId: job.sessionId,
    turnRef: job.turnRef,
    finalMessage,
    userRequest,
    ...(receipts ? { receipts } : {}),
    ...(conversationTail ? { conversationTail } : {}),
    ...(priorWarnings.length ? { priorWarnings } : {}),
    ...(deliveredWarnings.length ? { deliveredWarnings } : {}),
    ...(verifiedClaims.length ? { verifiedClaims } : {}),
    // THE FALSE-FLAG MECHANISM fix: the full transcript path, so audit() can scan
    // the WHOLE session's tool results (not just the 64KB receipts tail) for a
    // claimed figure that scrolled out of the audited window.
    ...(job.transcriptPath ? { transcriptPath: job.transcriptPath } : {}),
    harness: job.harness || "unknown",
    schedulingMode: job.mode,
    // The addressee of every warning line — claude→"Claude", codex→"Codex", else "Agent".
    executor,
  };
  let verdict = await audit(contentJob, auditor);

  // FALL BACK, do not give up. The chosen auditor can be exhausted (a usage limit) or simply
  // broken, and today that produced verdict=error with an empty reason — an audit that
  // silently did not happen while telemetry looked busy. If the cross-family auditor cannot
  // answer, ask the other vendor rather than dropping the turn on the floor. A same-family
  // auditor is a weaker tier, not no tier, and it is TAGGED as such (SPEC rules 3/4) so its
  // verdicts never inherit cross-family trust.
  //
  // TWO exclusions, both cost/consent invariants:
  //  - ollama: a local, unmetered pin. The `other` vendor is only ever claude/codex — both
  //    metered. Falling back from a dead ollama silently spends frontier quota the owner
  //    explicitly refused. Fail open to the error path instead; grounding + telemetry still run.
  //  - any explicit VS_AUDITOR / job.auditor pin: a pin means "this auditor and no other".
  //    Reaching a different vendor from a pin violates that regardless of family.
  // Non-pinned codex↔claude fallback (the auto-resolution ladder) is unchanged.
  const pinned = Boolean(job.auditor || process.env.VS_AUDITOR);
  if (verdict.error?.startsWith("auditor invocation failed") && auditor.vendor !== "ollama" && !pinned) {
    const other = auditor.vendor === "claude" ? "codex" : "claude";
    try {
      const fallback = await resolveAuditor(executor, other);
      const second = await audit({ ...contentJob }, fallback);
      if (!second.error) {
        logFiring({
          harness: "audit-runner",
          event: "audit",
          claim: "",
          verdict: "error",
          caught: `${auditor.vendor} unavailable (${isExhausted(verdict.error) ? "exhausted" : "failed"}) → fell back to ${other}`,
          blocked: false,
          dir: job.dir,
        });
        verdict = second;
      }
    } catch {
      // No second vendor either — keep the first verdict (R8: the audit is best-effort).
    }
  }
  // R5 (SPEC §6.5): remember this session's warnings so a later turn never
  // repeats one verbatim.
  appendSessionWarnings(job.dir, job.sessionId, verdict.warnings);

  // FIX 2: remember this turn's SUPPORTED-with-named-evidence claims so a later
  // turn re-asserting one is grounded even after its receipt scrolls out of the
  // window. Only claims the auditor independently verified (non-empty evidence) —
  // not the code-demoted ones (their attribution lives in `basis`, not evidence).
  const newlyVerified = verdict.claims
    .filter((c) => c.verdict === "supported" && c.evidence.trim())
    .map((c) => ({ claim: c.claim, evidence: c.evidence.trim(), ts: Date.now() }));
  appendVerifiedClaims(job.dir, job.sessionId, newlyVerified);

  // Feedback channel (SPEC §2, R7): a fresh warn/unaccountable verdict queues one
  // terse line for the next UserPromptSubmit (cli.ts's hook-prompt case).
  // Best-effort (R8) — writePendingFeedback never throws.
  const line = buildFeedbackLine(verdict);
  if (line) writePendingFeedback(job.dir, job.sessionId, line);
};
