/**
 * The audit brain. One Jev invocation per audit job, gated by the deterministic
 * load-bearing-claim filter (src/jev-input.ts). Warning text is code-owned
 * templates — Jev answers a Choice; it does not write prose.
 *
 * Never throws (R8). When Jev is unreachable the verdict reports that it did
 * not run. There is no CLI or local-model fallback.
 */
import { logFiring } from "./telemetry.js";
import type { Auditor, AuditorTier, AuditorUsage } from "./resolve.js";
import { jevDidNotRun } from "./resolve.js";
import { hasSpecificQuantity, specificNumbersIn, findNumberSnippet, stateKindsOf } from "./lexicon.js";
import { detectLoadBearingClaims } from "./jev-input.js";
import { buildCompressedJevInput } from "./jev-evidence.js";
import { readFullSessionToolResults } from "./transcript.js";

export interface AuditJob {
  dir: string;
  sessionId: string;
  turnRef?: string;
  /** The turn's final message — what the audit judges. */
  finalMessage: string;
  /** The user's request this turn is answering (claims are request-relative). */
  userRequest: string;
  conversationTail?: string;
  receipts?: string;
  priorWarnings?: string[];
  deliveredWarnings?: string[];
  verifiedClaims?: VerifiedClaim[];
  transcriptPath?: string;
  harness?: string;
  schedulingMode?: "live" | "testbed";
  executor?: string;
}

export type AdvisoryOutcome = "addressed-corrected" | "addressed-confirmed" | "ignored";

export interface ClaimVerdict {
  claim: string;
  verdict: "supported" | "unsupported" | "contradicted";
  basis: string;
  evidence: string;
  reliance?: string;
  depends_on?: string;
}

export interface VerifiedClaim {
  claim: string;
  evidence: string;
  ts: number;
}

export type Addressee = "Claude" | "Codex" | "Agent";

export function addressee(executor: string | undefined): Addressee {
  const e = (executor ?? "").toLowerCase();
  if (e === "claude" || e.startsWith("claude:")) return "Claude";
  if (e === "codex" || e.startsWith("codex:")) return "Codex";
  return "Agent";
}

function clipClaim(claim: string): string {
  const c = claim.trim();
  return c.length > 120 ? `${c.slice(0, 120).trimEnd()}…` : c;
}

export function claimWarning(who: Addressee, c: ClaimVerdict, verifiedDependsOn?: string): string {
  const claim = clipClaim(c.claim);
  const basis = c.basis.trim();
  const tail = basis ? ` — ${basis}` : "";
  const base = c.verdict === "contradicted"
    ? `${who}, the evidence contradicts your claim "${claim}"${tail}`
    : `${who}, you have no basis to claim "${claim}"${tail}`;
  const reliance = c.reliance?.trim();
  const line = reliance ? `${base}: if false — ${reliance}` : `${base}.`;
  const anchor = verifiedDependsOn?.trim();
  if (!anchor) return line;
  const q = anchor.length > 80 ? `${anchor.slice(0, 80).trimEnd()}…` : anchor;
  return `${line} — relied on by: "${q}"`;
}

export function unaccountableWarning(who: Addressee): string {
  return `${who}, you did substantial work but reported nothing checkable — state what you did and how you know it works.`;
}

export type DeliveryMode = "quiet" | "full";

export function deliveryMode(): DeliveryMode {
  return process.env.VS_DELIVERY === "full" ? "full" : "quiet";
}

export function claimDeliverableUnderQuiet(c: ClaimVerdict, _anchorVerified = false): boolean {
  if (c.verdict === "contradicted") return true;
  if (c.verdict === "unsupported") {
    return hasSpecificQuantity(c.claim) || stateKindsOf(c.claim).length > 0;
  }
  return false;
}

export type AnchorOutcome = "verified" | "void" | "n/a";

export function normalizeAnchor(s: string): string {
  return s
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, "")
    .trim()
    .toLowerCase();
}

export function verifyAnchor(
  dependsOn: string | undefined,
  finalMessage: string,
  conversationTail: string | undefined,
): AnchorOutcome {
  const needle = (dependsOn ?? "").trim();
  if (!needle) return "n/a";
  if (needle.length < 6) return "void";
  const n = normalizeAnchor(needle);
  if (n.length < 6) return "void";
  const hay = normalizeAnchor(`${finalMessage}\n${conversationTail ?? ""}`);
  return hay.includes(n) ? "verified" : "void";
}

export interface AuditVerdict {
  claims: ClaimVerdict[];
  unaccountable: boolean;
  note: string;
  warnings: string[];
  deliverableWarnings: string[];
  auditorTier: AuditorTier;
  sameFamily: boolean;
  vendor: string;
  auditUsage?: AuditorUsage | { status: "not-run"; reason: "gated" | "auditor-absent" };
  advisoryOutcome?: AdvisoryOutcome;
  error?: string;
  auditDurationMs?: number;
}

export interface ParsedAuditReply {
  claims: ClaimVerdict[];
  unaccountable: boolean;
  note: string;
  advisoryOutcome?: AdvisoryOutcome;
}

function parseAdvisoryOutcome(v: unknown): AdvisoryOutcome | undefined {
  return v === "addressed-corrected" || v === "addressed-confirmed" || v === "ignored" ? v : undefined;
}

function isGenericReliance(reliance: string | undefined): boolean {
  const r = (reliance ?? "").trim().toLowerCase();
  if (r.length < 20) return true;
  const copOuts = ["the user might be misled", "might be misled", "could cause confusion", "cause confusion"];
  return copOuts.some((c) => r.includes(c));
}

function enforceBudget(claims: ClaimVerdict[]): ClaimVerdict[] {
  const nonSupported = claims.filter((c) => c.verdict !== "supported");
  const accountable = nonSupported.filter((c) => !isGenericReliance(c.reliance));
  let keep: ClaimVerdict | undefined;
  for (const c of accountable) {
    if (!keep || (c.verdict === "contradicted" && keep.verdict !== "contradicted")) keep = c;
  }
  return claims.filter((c) => c.verdict === "supported" || c === keep);
}

export function parseReply(raw: string): ParsedAuditReply | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;

  const claims: ClaimVerdict[] = Array.isArray(p.claims)
    ? p.claims
        .map((c): ClaimVerdict | null => {
          if (!c || typeof c !== "object") return null;
          const o = c as Record<string, unknown>;
          if (typeof o.claim !== "string") return null;
          if (o.verdict !== "supported" && o.verdict !== "unsupported" && o.verdict !== "contradicted") return null;
          return {
            claim: o.claim,
            verdict: o.verdict,
            basis: typeof o.basis === "string" ? o.basis : "",
            evidence: typeof o.evidence === "string" ? o.evidence : "",
            ...(typeof o.reliance === "string" ? { reliance: o.reliance } : {}),
            ...(typeof o.depends_on === "string" ? { depends_on: o.depends_on } : {}),
          };
        })
        .filter((c): c is ClaimVerdict => c !== null)
    : [];

  const advisoryOutcome = parseAdvisoryOutcome(p.advisory_outcome);
  return {
    claims: enforceBudget(claims),
    unaccountable: p.unaccountable === true,
    note: typeof p.note === "string" ? p.note : "",
    ...(advisoryOutcome ? { advisoryOutcome } : {}),
  };
}

export function demoteFullSessionFigures(
  claims: ClaimVerdict[],
  fullSessionToolResults: string | undefined,
): ClaimVerdict[] {
  const text = fullSessionToolResults ?? "";
  if (!text.trim()) return claims;

  try {
    return claims.map((c) => {
      if (c.verdict === "supported" || !hasSpecificQuantity(c.claim)) return c;
      for (const value of specificNumbersIn(c.claim)) {
        const snippet = findNumberSnippet(value, text);
        if (snippet) {
          return {
            ...c,
            verdict: "supported" as const,
            basis: `figure appears in session receipts outside the audited window (${snippet}), may be stale — not re-verified this turn`,
          };
        }
      }
      return c;
    });
  } catch {
    return claims;
  }
}

interface AuditTelemetryExtras {
  gated?: "skipped" | "shadow" | "full";
  gateMissed?: boolean;
  evidenceBytes?: number;
  delivery?: "full" | "quiet" | "suppressed-quiet";
  anchor?: AnchorOutcome;
}

function logAuditTelemetry(job: AuditJob, verdict: AuditVerdict, promptChars = 0, extra: AuditTelemetryExtras = {}): void {
  const overall = verdict.error
    ? "error"
    : verdict.claims.some((c) => c.verdict === "contradicted")
      ? "contradicted"
      : verdict.claims.some((c) => c.verdict === "unsupported") || verdict.unaccountable
        ? "unsupported"
        : verdict.claims.length
          ? "supported"
          : "no-claim";
  const basis: NonNullable<Parameters<typeof logFiring>[0]["verdict_basis"]> = verdict.claims.some((c) => c.evidence.trim())
    ? "probe"
    : "none";
  const auditorTierTag: NonNullable<Parameters<typeof logFiring>[0]["auditor_tier"]> = verdict.error?.startsWith("Jev did not run")
    ? "absent"
    : verdict.sameFamily
      ? "same_family"
      : (verdict.auditorTier as "agentic" | "pre-gathered");
  const usage = verdict.auditUsage ?? { status: "unavailable" as const, reason: "auditor did not expose provider usage" };

  logFiring({
    harness: job.harness || "unknown",
    event: "audit",
    claim: job.finalMessage.slice(0, 400),
    verdict: overall,
    caught: (verdict.error ? verdict.error : verdict.warnings.join("; ")).slice(0, 400),
    blocked: false,
    dir: job.dir,
    verdict_basis: basis,
    auditor_tier: auditorTierTag,
    auditor_vendor: verdict.vendor,
    auditor_model: usage.status === "not-run" ? undefined : usage.model,
    audit_usage: usage.status === "reported"
      ? {
          status: "reported",
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
        }
      : usage.status === "not-run"
        ? { status: "not-run", reason: usage.reason }
        : { status: "unavailable", reason: usage.reason },
    prompt_chars: promptChars,
    scheduling_mode: job.schedulingMode || "live",
    turn_ref: job.turnRef || job.sessionId,
    vague_turn: verdict.unaccountable,
    audit_duration_ms: verdict.auditDurationMs,
    advisory_outcome: verdict.advisoryOutcome,
    gated: extra.gated,
    gate_missed: extra.gateMissed || undefined,
    evidence_bytes: extra.evidenceBytes,
    delivery: extra.delivery,
    anchor: extra.anchor,
  });
}

export async function audit(job: AuditJob, auditor: Auditor): Promise<AuditVerdict> {
  const auditStartedAt = Date.now();
  const jevSpans = detectLoadBearingClaims(job.finalMessage);

  const gateEligible = auditor.tier !== "absent" && jevSpans.length === 0;
  const gated: "skipped" | "full" | undefined =
    auditor.tier === "absent" ? undefined : gateEligible ? "skipped" : "full";
  const runJev = auditor.tier !== "absent" && !gateEligible;

  let reply: ParsedAuditReply | null = null;
  let error: string | undefined;
  let promptChars = 0;
  let evidenceBytes = 0;
  let auditUsage: NonNullable<AuditVerdict["auditUsage"]> = auditor.tier === "absent"
    ? { status: "not-run", reason: "auditor-absent" }
    : { status: "not-run", reason: "gated" };

  if (auditor.tier === "absent") {
    error = jevDidNotRun("TYPESAFE_API_KEY is not set");
  } else if (runJev) {
    auditor.lastUsage = undefined;
    try {
      const compressedJevInput = await buildCompressedJevInput({
        dir: job.dir,
        userRequest: job.userRequest,
        finalMessage: job.finalMessage,
        ...(job.receipts ? { receipts: job.receipts } : {}),
      });
      evidenceBytes = Buffer.byteLength(compressedJevInput.evidence, "utf8");
      const prompt = JSON.stringify(compressedJevInput);
      promptChars = prompt.length;
      const raw = await auditor.invoke(prompt, job.dir);
      reply = parseReply(raw);
      if (!reply) error = jevDidNotRun("reply did not parse as the expected JSON verdict");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      error = msg.startsWith("Jev did not run") ? msg : jevDidNotRun(msg);
    } finally {
      auditUsage = auditor.lastUsage ?? {
        status: "unavailable",
        reason: "auditor did not expose provider usage",
        ...(auditor.model ? { model: auditor.model } : {}),
      };
    }
  }

  let claims = reply ? reply.claims : [];
  if (job.transcriptPath) {
    const fullScan = readFullSessionToolResults(job.transcriptPath);
    if (!fullScan.bailed) claims = demoteFullSessionFigures(claims, fullScan.text);
  }

  const mode = deliveryMode();
  const prior = new Set(job.priorWarnings ?? []);
  const warnings: string[] = [];
  const deliverableWarnings: string[] = [];
  const pushWarning = (w: string, deliverable: boolean): void => {
    if (prior.has(w) || warnings.includes(w)) return;
    warnings.push(w);
    if (mode === "full" || deliverable) deliverableWarnings.push(w);
  };
  const who = addressee(job.executor);
  const nonSupported = claims.filter((c) => c.verdict !== "supported");
  const anchorOf = new Map<ClaimVerdict, AnchorOutcome>();
  for (const c of nonSupported) anchorOf.set(c, verifyAnchor(c.depends_on, job.finalMessage, job.conversationTail));
  const rank = (v: ClaimVerdict["verdict"]): number => (v === "contradicted" ? 0 : 1);
  for (const c of [...nonSupported].sort((a, b) => rank(a.verdict) - rank(b.verdict))) {
    const verified = anchorOf.get(c) === "verified";
    pushWarning(claimWarning(who, c, verified ? c.depends_on : undefined), claimDeliverableUnderQuiet(c, verified));
  }
  if (reply?.unaccountable) pushWarning(unaccountableWarning(who), true);

  const delivery: AuditTelemetryExtras["delivery"] =
    warnings.length === 0
      ? undefined
      : mode === "full"
        ? "full"
        : warnings.length > deliverableWarnings.length
          ? "suppressed-quiet"
          : "quiet";

  const verdict: AuditVerdict = {
    claims,
    unaccountable: reply?.unaccountable ?? false,
    note: reply?.note ?? (gated === "skipped" ? "no-claim (gated)" : ""),
    warnings,
    deliverableWarnings,
    auditorTier: auditor.tier,
    sameFamily: auditor.sameFamily,
    vendor: auditor.vendor,
    auditUsage,
    auditDurationMs: Date.now() - auditStartedAt,
    ...(reply?.advisoryOutcome ? { advisoryOutcome: reply.advisoryOutcome } : {}),
    ...(error ? { error } : {}),
  };

  const anchor = nonSupported.length ? anchorOf.get(nonSupported[0]!) : undefined;
  logAuditTelemetry(job, verdict, promptChars, { gated, evidenceBytes, delivery, anchor });
  return verdict;
}
