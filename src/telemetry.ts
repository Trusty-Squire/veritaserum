/**
 * Confabulation-catch telemetry. Every time ser fires on an agent's completion
 * claim, one structured record lands in a single global log (~/.veritaserum/telemetry.jsonl
 * by default) so a week of real use across Claude Code / goose / codex is one
 * readable stream. `ser telemetry` summarizes it: catches, false-blocks, by class.
 *
 * Telemetry MUST NEVER break the hook — every write is best-effort and swallowed.
 */
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface Firing {
  ts: string;
  harness: string; // claude-code | goose | codex | unknown
  event: "stop" | "verify" | "prompt" | "audit";
  /** The agent's completion claim (truncated). */
  claim: string;
  /** grounded (claim held) | blocked (contradiction) | abstain | pass | error */
  verdict: string;
  /** What ser caught as unsupported/contradicted (empty when nothing). */
  caught: string;
  /** The sentinel's decision. In advisory mode this is what it WOULD have done. */
  blocked: boolean;
  /** True when VS_ADVISORY was set: logged only, the agent was not actually stopped. */
  advisory?: boolean;
  dir: string;
  /** How big the auditor's prompt was, in chars. The audit is an LLM call on every turn with
   *  tool activity; at a 256 KiB receipts cap that was ~65k tokens EACH, and nothing recorded
   *  it — so a quota drained with no trace of what drained it. Cost you cannot see is cost
   *  you cannot control. */
  prompt_chars?: number;
  /** v3 (SPEC §7): what grounded the verdict — a fresh probe, the harness's own
   *  receipt record, a mechanical standing-law check, or nothing (no claims). */
  verdict_basis?: "probe" | "receipt" | "standing-law" | "none";
  /** v3 (SPEC §2 "internal mechanics"): the auditor's trust tier for this run —
   *  same_family tags an agentic auditor that shares the executor's model family. */
  auditor_tier?: "agentic" | "pre-gathered" | "same_family" | "absent";
  /** v3 (SPEC §2): LIVE (a new turn-end supersedes) vs TESTBED (the queue drains). */
  scheduling_mode?: "live" | "testbed";
  /** v3: standing case-law entry ids checked mechanically in this audit. */
  law_ids?: string[];
  /** The subset of law_ids that passed. A green authored demand is durable
   * evidence even when other evidence still determines the overall verdict. */
  passed_law_ids?: string[];
  /** Harness turn identity, used to prove one audit per exact Stop event. */
  turn_ref?: string;
  /** v3 (R9): a substantial-work turn with no load-bearing claims ("unaccountable work"). */
  vague_turn?: boolean;
  /** v3 (SPEC §7): written after the fact by the seeded-task labeler (eval/seeded/label.ts) —
   *  true when this firing's "contradicted" catch was itself wrong (the claim was actually
   *  true). Absent/undefined means not yet labeled, never "known honest". */
  false_flag?: boolean;
  /** End-to-end async audit duration (mechanical checks + one auditor call). */
  audit_duration_ms?: number;
  /** Which drain path delivered a next-prompt warning: session-scoped (the
   *  normal path, keyed by the earning session), repo-fallback (the payload
   *  omitted session_id, so every session's pending feedback was drained), or
   *  stray (Door 1/Door 2 autonomous-fleet delivery — a warning earned by a
   *  DIFFERENT session in this repo, swept past its 10-min grace). */
  feedback_scope?: "session" | "repo-fallback" | "stray";
  /** SPEC §7 "advisory outcome" (was the warn followed?): the LLM auditor's
   *  judgment, on the turn after a warning was delivered, of whether the turn
   *  acted on it. LLM-only — absent when no auditor ran or no warning was
   *  pending for the session. */
  advisory_outcome?: "addressed-corrected" | "addressed-confirmed" | "ignored";
  /** CHANGE 1 (the gate): what happened to the LLM audit this turn. "skipped" —
   *  the gate found nothing claim-shaped and did NOT invoke the LLM (the 81% we
   *  stop paying for). "shadow" — a gated turn the shadow sampler ran anyway.
   *  "full" — a non-gated audit. Absent → no auditor was available (tier absent).
   *  Gate safety is the query `gated:"shadow" AND gate_missed:true`. */
  gated?: "skipped" | "shadow" | "full";
  /** CHANGE 1 (shadow safety): true when a shadow audit of a GATED turn returned
   *  a substantive verdict (unsupported/contradicted/unaccountable) — i.e. the
   *  gate WOULD have wrongly skipped a real finding. The gate's miss rate is
   *  `count(gate_missed) / count(gated:"shadow")`, a telemetry query not a belief. */
  gate_missed?: boolean;
  /** CHANGE 2 (claim-conditioned evidence): bytes of the SELECTED receipts payload
   *  actually shipped to the auditor (vs the blind tail). 0 when nothing was
   *  shipped (gated-skip, or no receipts). Paired with prompt_chars, this makes
   *  the token saving measurable. */
  evidence_bytes?: number;
  /** DELIVERY POLICY (VS_DELIVERY=quiet|full): what the delivery gate did with this
   *  turn's warnings. "full" — full mode, every warning delivered. "quiet" — quiet
   *  mode, nothing suppressed (all warnings were deliverable). "suppressed-quiet" —
   *  quiet mode held ≥1 warning back from the pending-feedback file (still deduped +
   *  telemetered, just not surfaced). Absent when the turn produced no warnings. The
   *  suppression rate is the query `delivery:"suppressed-quiet"`. */
  delivery?: "full" | "quiet" | "suppressed-quiet";
}

export function telemetryPath(): string {
  return process.env.VS_TELEMETRY_PATH || join(homedir(), ".veritaserum", "telemetry.jsonl");
}

export function logFiring(f: Omit<Firing, "ts">): void {
  try {
    const p = telemetryPath();
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...f }) + "\n");
  } catch {
    /* telemetry must never break the hook */
  }
}

export function readFirings(): Firing[] {
  const p = telemetryPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Firing;
      } catch {
        return null;
      }
    })
    .filter((x): x is Firing => x !== null);
}

/**
 * Seeded-task labeler support (SPEC §6.6/§7): mark the firing with this exact
 * timestamp as a false flag — a "contradicted" catch that was itself wrong,
 * because the labeler determined (from truth.json + git state) that the
 * audited claim was actually true. Rewrites telemetry.jsonl in place;
 * best-effort (R8) — never throws, returns the number of rows updated.
 */
export function markFalseFlag(ts: string): number {
  try {
    const rows = readFirings();
    let n = 0;
    const out = rows.map((f) => {
      if (f.ts !== ts) return f;
      n++;
      return { ...f, false_flag: true };
    });
    if (n > 0) writeFileSync(telemetryPath(), out.map((f) => JSON.stringify(f)).join("\n") + "\n");
    return n;
  } catch {
    return 0;
  }
}

/**
 * Wilson score interval lower bound (95% one-sided by default, z=1.96) for a
 * proportion of `successes` out of `trials` — SPEC §7's precision metric, the
 * only earned path to blocking (R5). Pure, no I/O. 0 trials → 0 (no evidence
 * yet, no bound to report).
 */
export function wilsonLowerBound(successes: number, trials: number, z = 1.96): number {
  if (trials <= 0) return 0;
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return (center - margin) / denom;
}

export interface LawEntryPrecision {
  lawId: string;
  /** Audits where this law entry's mechanical check ran (Firing.law_ids includes it). */
  judgedEvents: number;
  /** Of those, audits whose overall verdict was "contradicted". */
  catches: number;
  /** Of the catches, how many the seeded-task labeler marked wrong (false_flag). */
  falseFlags: number;
  /** (catches - falseFlags) / catches — null until this entry has caught anything. */
  precision: number | null;
  /** Wilson 95% LB on precision, computed over (catches - falseFlags)/catches. */
  precisionLowerBound: number;
}

export interface PrecisionReport {
  byLaw: LawEntryPrecision[];
  auditedTurns: number;
  vagueTurns: number;
  /** R9 events / audited turns (SPEC §7) — a first-class metric, not an afterthought. */
  vagueTurnRate: number;
}

/**
 * SPEC §7 measurement: per-law-entry (not coarse-family) precision with a
 * Wilson lower bound, plus the vague-turn rate. Pure over `firings` — no I/O,
 * so it's directly testable against hand-computed values.
 */
export function summarizePrecision(firings: Firing[]): PrecisionReport {
  const audited = firings.filter((f) => f.event === "audit");

  const lawIds = new Set<string>();
  for (const f of audited) for (const id of f.law_ids ?? []) lawIds.add(id);

  const byLaw: LawEntryPrecision[] = [...lawIds].sort().map((lawId) => {
    const judged = audited.filter((f) => f.law_ids?.includes(lawId));
    const caught = judged.filter((f) => f.verdict === "contradicted");
    const falseFlags = caught.filter((f) => f.false_flag === true);
    const trueCatches = caught.length - falseFlags.length;
    return {
      lawId,
      judgedEvents: judged.length,
      catches: caught.length,
      falseFlags: falseFlags.length,
      precision: caught.length ? trueCatches / caught.length : null,
      precisionLowerBound: wilsonLowerBound(trueCatches, caught.length),
    };
  });

  const vagueTurns = audited.filter((f) => f.vague_turn === true).length;
  return {
    byLaw,
    auditedTurns: audited.length,
    vagueTurns,
    vagueTurnRate: audited.length ? vagueTurns / audited.length : 0,
  };
}

/** Human-readable summary — the in-the-wild measurement. */
export function summarize(firings: Firing[]): string {
  const n = firings.length;
  const caught = firings.filter((f) => f.caught.trim().length > 0);
  const actuallyBlocked = firings.filter((f) => f.blocked && !f.advisory);
  const wouldBlock = firings.filter((f) => f.blocked && f.advisory);
  const byHarness = firings.reduce<Record<string, number>>((m, f) => ((m[f.harness] = (m[f.harness] ?? 0) + 1), m), {});
  const label = (f: Firing): string => (f.blocked ? (f.advisory ? "would-block" : "BLOCKED") : "flagged");
  const lines = [
    `ser telemetry — ${n} firing(s)`,
    `  caught (flagged an unsupported claim):  ${caught.length}`,
    `  blocked (actually stopped the turn):    ${actuallyBlocked.length}`,
    `  would-block (advisory, logged only):    ${wouldBlock.length}`,
    `  by harness: ${JSON.stringify(byHarness)}`,
    ``,
    `recent catches:`,
    ...caught.slice(-10).map((f) => `  [${f.ts.slice(0, 19)}] ${f.harness} ${label(f)}: ${f.caught.slice(0, 120)}`),
  ];
  return lines.join("\n");
}
