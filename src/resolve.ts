/**
 * Auditor resolution: Jev is the only classifier. There is nothing to select.
 * TYPESAFE_API_KEY present → Jev. Otherwise the audit reports that Jev did not run.
 */
import { typesafeApiKey } from "./llm.js";
import { invokeJevWithMeta, JEV_MODEL, JEV_TIMEOUT_MS } from "./jev.js";

export type AuditorTier = "pre-gathered" | "absent";
export type Vendor = "jev";

/** Usage for one provider invocation. A missing price is deliberately distinct
 * from zero: Jev can report exact tokens without exposing a per-call dollar price. */
export type AuditorUsage =
  | {
      status: "reported";
      inputTokens: number;
      outputTokens: number;
      model?: string;
      costUsd?: number;
    }
  | {
      status: "unavailable";
      reason: string;
      model?: string;
    };

export interface Auditor {
  tier: AuditorTier;
  vendor: Vendor | "none";
  model?: string;
  /** Always false: Jev is a different family from every coding-agent executor. */
  sameFamily: boolean;
  /** Usage for the most recent invoke(), reset at the start of every call. */
  lastUsage?: AuditorUsage;
  invoke(prompt: string, dir: string, timeoutMs?: number): Promise<string>;
}

export const JEV_DID_NOT_RUN = "Jev did not run";

export function jevDidNotRun(reason: string): string {
  return `${JEV_DID_NOT_RUN}: ${reason}`;
}

const ABSENT_AUDITOR: Auditor = {
  tier: "absent",
  vendor: "none",
  sameFamily: false,
  async invoke() {
    throw new Error(jevDidNotRun("TYPESAFE_API_KEY is not set"));
  },
};

function buildJevAuditor(): Auditor {
  const m = JEV_MODEL;
  const auditor: Auditor = {
    tier: "pre-gathered",
    vendor: "jev",
    model: m,
    sameFamily: false,
    async invoke(prompt, _dir, timeoutMs) {
      auditor.lastUsage = { status: "unavailable", reason: "jev did not report token usage", model: m };
      const invocation = await invokeJevWithMeta(prompt, timeoutMs ?? JEV_TIMEOUT_MS);
      const { inputTokens, outputTokens, costUsd } = invocation.meta;
      if (inputTokens !== undefined && outputTokens !== undefined) {
        auditor.lastUsage = {
          status: "reported",
          inputTokens,
          outputTokens,
          model: invocation.meta.model ?? m,
          ...(costUsd !== undefined ? { costUsd } : {}),
        };
      } else if (invocation.meta.model) {
        auditor.lastUsage = { status: "unavailable", reason: "jev did not report token usage", model: invocation.meta.model };
      }
      return invocation.reply;
    },
  };
  return auditor;
}

export interface DoctorCandidate {
  vendor: Vendor;
  ok: boolean;
  detail: string;
  firedRule: string | null;
}

export interface DoctorReport {
  executor: string;
  candidates: DoctorCandidate[];
  chosen: {
    rule: string;
    tier: AuditorTier;
    vendor: Vendor | "none";
    model?: string;
    sameFamily: boolean;
  };
}

/**
 * Resolve the Jev classifier. Nothing else is an auditor. No key → absent
 * (the audit reports that Jev did not run). The executor argument is retained
 * so call sites can still name who is being audited; it does not select a vendor.
 */
export async function resolveAuditor(_executor?: string): Promise<Auditor> {
  if (!typesafeApiKey()) return ABSENT_AUDITOR;
  return buildJevAuditor();
}

export async function doctorReport(executor: string): Promise<DoctorReport> {
  const auditor = await resolveAuditor(executor);
  const ok = auditor.tier !== "absent";
  const rule = ok
    ? "jev: TYPESAFE_API_KEY present → jev-latest (Choice classifier)"
    : jevDidNotRun("TYPESAFE_API_KEY is not set");
  return {
    executor,
    candidates: [
      {
        vendor: "jev",
        ok,
        detail: ok ? "TYPESAFE_API_KEY present" : "TYPESAFE_API_KEY is not set",
        firedRule: rule,
      },
    ],
    chosen: {
      rule,
      tier: auditor.tier,
      vendor: auditor.vendor,
      ...(auditor.model ? { model: auditor.model } : {}),
      sameFamily: false,
    },
  };
}
