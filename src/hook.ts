/**
 * Harness-agnostic hook orchestration (DESIGN §6). The goose/CC/codex adapters
 * (Archetype A) all reduce to these two functions; only payload shape + how the
 * decision is emitted differ per harness.
 *
 *  - hookStop: at turn-end, block IFF the agent CLAIMED done/pass while a gate is
 *    red. Honest incompleteness (no claim) passes even when gates are red — else
 *    the agent is trapped mid-work. The block reason carries redacted symptoms
 *    (reality → executor), never solutions or eval internals.
 *  - hookPrompt: on the human's message, ratchet it IFF it reads as a correction
 *    to the shipped contract. Capture only; never blocks the human.
 */
import { loadContract } from "./contract.js";
import { mockClaimExtractor, mockCorrectionClassifier, type ClaimExtractor, type CorrectionClassifier } from "./claim.js";
import { mockTranscriber, type ComplaintTranscriber } from "./judge.js";
import { ratchetComplaint, type RatchetOutcome } from "./ratchet.js";
import { verify, NotSealedError } from "./verify.js";

export interface StopDecision {
  block: boolean;
  reason?: string;
  /** Diagnostics for the CLI / tests (not sent to the harness). */
  claimed: boolean;
  ran?: number;
  failed?: number;
  tamper?: number;
}

export interface StopDeps {
  extract?: ClaimExtractor;
  level?: "fast" | "full";
}

export async function hookStop(dir: string, message: string, deps: StopDeps = {}): Promise<StopDecision> {
  const extract = deps.extract ?? mockClaimExtractor;
  const claim = extract(message);
  if (!claim.claimsDone) {
    return { block: false, claimed: false };
  }

  let result;
  try {
    result = await verify(dir, deps.level ?? "fast");
  } catch (err) {
    // No sealed contract yet → nothing to contradict; let the turn end.
    if (err instanceof NotSealedError) return { block: false, claimed: true };
    throw err;
  }

  if (!result.blocked) {
    return { block: false, claimed: true, ran: result.ran, failed: 0, tamper: result.tamper.length };
  }

  const symptoms = result.failures
    .map((f) => `- ${f.gateId}: ${f.symptom ?? "failed"}`)
    .join("\n");
  const tamperNote = result.tamper.length
    ? `\n${result.tamper.length} grader file(s) were modified in the working tree; the committed graders were run instead.`
    : "";
  const reason =
    `You reported the task done ("${claim.evidence}"), but ${result.failures.length} of ${result.ran} ` +
    `contract gate(s) fail:\n${symptoms}${tamperNote}\nAddress these before ending the turn.`;

  return { block: true, reason, claimed: true, ran: result.ran, failed: result.failures.length, tamper: result.tamper.length };
}

export interface PromptDeps {
  classify?: CorrectionClassifier;
  transcribe?: ComplaintTranscriber;
  now?: () => string;
}

export interface PromptOutcome {
  ratcheted: boolean;
  outcome?: RatchetOutcome;
}

export async function hookPrompt(dir: string, message: string, deps: PromptDeps = {}): Promise<PromptOutcome> {
  const classify = deps.classify ?? mockCorrectionClassifier;
  const contract = await loadContract(dir);
  if (!classify(message, contract).isCorrection) return { ratcheted: false };
  const outcome = await ratchetComplaint(dir, message, deps.transcribe ?? mockTranscriber, deps.now);
  return { ratcheted: true, outcome };
}
