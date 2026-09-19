/**
 * The audit execution hub. `runAudit` loads turn material, resolves Jev, and
 * hands both to `audit()`. Never throws (R8). When Jev is unreachable the
 * verdict already reports that it did not run — this module does not reach
 * for another classifier.
 */
import { readGooseSession } from "./goose.js";
import { readLastAssistantMessage, readLastUserMessage, readReceiptsTail, readConversationTail } from "./transcript.js";
import { resolveAuditor } from "./resolve.js";
import { audit, type AuditJob as AuditContentJob, type AuditVerdict } from "./auditor.js";
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

export function loadTurnMaterial(job: AuditJob): { finalMessage: string; userRequest: string; receipts?: string; conversationTail?: string } {
  if (job.transcriptPath) {
    const finalMessage = job.finalMessage ?? readLastAssistantMessage(job.transcriptPath);
    const userRequest = job.userRequest ?? readLastUserMessage(job.transcriptPath);
    const receipts = readReceiptsTail(job.transcriptPath);
    const conversationTail = readConversationTail(job.transcriptPath);
    return { finalMessage, userRequest, ...(receipts ? { receipts } : {}), ...(conversationTail ? { conversationTail } : {}) };
  }
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

export function buildFeedbackLine(verdict: AuditVerdict): string | null {
  const lead = verdict.deliverableWarnings[0];
  if (!lead) return null;
  return `veritaserum: ${lead}`.slice(0, 600);
}

export const runAudit: RunAudit = async (job: AuditJob): Promise<void> => {
  const { finalMessage, userRequest, receipts, conversationTail } = loadTurnMaterial(job);

  const executor = job.executor || "unknown";
  const auditor = await resolveAuditor(executor);

  const priorWarnings = loadSessionWarnings(job.dir, job.sessionId);
  const deliveredWarnings = takeDeliveredWarnings(job.dir, job.sessionId);
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
    ...(job.transcriptPath ? { transcriptPath: job.transcriptPath } : {}),
    harness: job.harness || "unknown",
    schedulingMode: job.mode,
    executor,
  };
  const verdict = await audit(contentJob, auditor);

  appendSessionWarnings(job.dir, job.sessionId, verdict.warnings);

  const newlyVerified = verdict.claims
    .filter((c) => c.verdict === "supported" && c.evidence.trim())
    .map((c) => ({ claim: c.claim, evidence: c.evidence.trim(), ts: Date.now() }));
  appendVerifiedClaims(job.dir, job.sessionId, newlyVerified);

  const line = buildFeedbackLine(verdict);
  if (line) writePendingFeedback(job.dir, job.sessionId, line);
};
