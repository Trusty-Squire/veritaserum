/**
 * Shared resolution of the Knight (authoring) and the cross-vendor Judge (verify),
 * from local subscriptions. Used by both the CLI (hook path) and the MCP server.
 * Never auto-runs the metered OpenRouter path.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import {
  detectVendors,
  makeClient,
  selectJudgeVendor,
  onPath,
  openrouterApiKey,
  OllamaClient,
  OpenRouterClient,
  type Vendor,
} from "./llm.js";
import { MockKnight, mockTranscriber, type Knight, type ComplaintTranscriber } from "./judge.js";
import { LlmKnight } from "./knight-llm.js";
import { makeLlmTranscriber } from "./transcriber-llm.js";
import { makeSemanticJudge, type SemanticJudge } from "./judge-verdict.js";

/** Authoring is not judging → no cross-vendor rule; prefer the faster generator. */
export async function resolveKnight(): Promise<Knight> {
  if (process.env.VS_MOCK_KNIGHT) return new MockKnight();
  const vendors = await detectVendors();
  if (!vendors.length) return new MockKnight();
  const v: Vendor = vendors.includes("claude") ? "claude" : vendors[0]!;
  return new LlmKnight(makeClient({ vendor: v, reason: "knight authoring", metered: false }));
}

/** Turn a complaint into a real gate (LLM). Authoring → prefer claude; else mock. */
export async function resolveTranscriber(): Promise<ComplaintTranscriber> {
  if (process.env.VS_MOCK_KNIGHT) return mockTranscriber;
  const vendors = await detectVendors();
  if (!vendors.length) return mockTranscriber;
  const v: Vendor = vendors.includes("claude") ? "claude" : vendors[0]!;
  return makeLlmTranscriber(makeClient({ vendor: v, reason: "ratchet transcriber", metered: false }));
}

/** Cross-vendor semantic judge from local subs, or undefined → semantic gates abstain. */
export async function resolveJudge(): Promise<SemanticJudge | undefined> {
  const executor = (process.env.VS_EXECUTOR as Vendor | "unknown") || "unknown";
  try {
    const sel = selectJudgeVendor(executor, { available: await detectVendors() });
    if (sel.metered) return undefined;
    return makeSemanticJudge(makeClient(sel));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Auditor resolution (SPEC.md §2 "Auditor resolution" — five rules + override).
//
// The auditor is cross-FAMILY from the executor (R6): different checkpoints of
// one lineage share blindspots, so an agentic auditor from the SAME family is
// only ever a fallback (rules 3/4), tagged `sameFamily` so a weaker trust tier
// never inherits a stronger tier's precision (SPEC §2 "internal mechanics").
//
// Availability is AUTH-PROBED, not just "on PATH": a cached (~/.veritaserum/
// doctor.json, 24h TTL) 1-token smoke call per CLI candidate. `VS_AUDITOR`
// overrides everything.
// ---------------------------------------------------------------------------

export type AuditorTier = "agentic" | "pre-gathered" | "absent";

export interface Auditor {
  tier: AuditorTier;
  vendor: Vendor | "none";
  model?: string;
  /** True when the auditor shares a model family with the executor (rules 3/4). */
  sameFamily: boolean;
  /**
   * One audit invocation. `dir` matters only to agentic CLIs (their own
   * read-only probes run there); pre-gathered clients ignore it — the caller
   * has already inlined evidence into `prompt`.
   */
  invoke(prompt: string, dir: string, timeoutMs?: number): Promise<string>;
}

const ABSENT_AUDITOR: Auditor = {
  tier: "absent",
  vendor: "none",
  sameFamily: false,
  async invoke() {
    throw new Error("no auditor available (auditor_absent) — mechanical checks still run");
  },
};

/** Rule 1/2 "non-Codex"/"non-Claude executor" classification. */
export function executorFamily(executor: string): "openai" | "claude" | "other" {
  const e = executor.toLowerCase();
  if (e === "codex" || e.startsWith("codex:") || e === "openai" || e.startsWith("openai:") || e.includes("gpt")) {
    return "openai";
  }
  if (e === "claude" || e.startsWith("claude:")) return "claude";
  return "other";
}

const AUDITOR_VENDORS = new Set<Vendor>(["codex", "claude", "ollama", "openrouter"]);

function parseAuditorSpec(v: string): { vendor: Vendor; model?: string } | null {
  const i = v.indexOf(":");
  const vendor = (i === -1 ? v : v.slice(0, i)).trim();
  const model = i === -1 ? undefined : v.slice(i + 1).trim() || undefined;
  return AUDITOR_VENDORS.has(vendor as Vendor) ? { vendor: vendor as Vendor, model } : null;
}

// --- doctor cache: 24h-TTL auth-probe results, so `veritaserum doctor` (and every
// audit job) pays the live smoke-call cost at most once a day per candidate. ---

interface DoctorCacheEntry {
  ok: boolean;
  at: number;
  detail?: string;
}
type DoctorCache = Record<string, DoctorCacheEntry>;
const DOCTOR_TTL_MS = 24 * 60 * 60 * 1000;

function doctorCachePath(): string {
  return process.env.VS_DOCTOR_CACHE_PATH || join(homedir(), ".veritaserum", "doctor.json");
}
function loadDoctorCache(): DoctorCache {
  try {
    return JSON.parse(readFileSync(doctorCachePath(), "utf8")) as DoctorCache;
  } catch {
    return {};
  }
}
function saveDoctorCache(c: DoctorCache): void {
  try {
    const p = doctorCachePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
  } catch {
    /* the doctor cache is a speed optimization, never load-bearing */
  }
}

interface Probe {
  ok: boolean;
  detail?: string;
}

async function cachedProbe(key: string, probe: () => Promise<Probe>): Promise<Probe> {
  const cache = loadDoctorCache();
  const hit = cache[key];
  if (hit && Date.now() - hit.at < DOCTOR_TTL_MS) return { ok: hit.ok, ...(hit.detail ? { detail: hit.detail } : {}) };
  const result = await probe();
  cache[key] = { ok: result.ok, at: Date.now(), ...(result.detail ? { detail: result.detail } : {}) };
  saveDoctorCache(cache);
  return result;
}

/** codex exec, read-only sandbox, a 1-token smoke call — catches expired/invalid auth that a bare `ls ~/.codex` would miss. */
async function probeCodex(): Promise<Probe> {
  if (!(await onPath("codex"))) return { ok: false, detail: "codex not on PATH" };
  const r = await execa("codex", ["exec", "-s", "read-only", "reply with exactly one word: ok"], {
    reject: false,
    stdin: "ignore",
    timeout: 20_000,
  });
  return r.exitCode === 0 ? { ok: true } : { ok: false, detail: `codex smoke call failed (exit ${r.exitCode ?? "timeout"})` };
}
async function probeClaude(): Promise<Probe> {
  if (!(await onPath("claude"))) return { ok: false, detail: "claude not on PATH" };
  const r = await execa("claude", ["-p", "reply with exactly one word: ok"], { reject: false, timeout: 20_000 });
  return r.exitCode === 0 ? { ok: true } : { ok: false, detail: `claude smoke call failed (exit ${r.exitCode ?? "timeout"})` };
}

/** Read-only tool allowlist for the agentic claude invocation (SPEC §2: "claude via `claude -p` with read-only tool restrictions"). */
const CLAUDE_READONLY_TOOLS = "Read,Bash(git log:*),Bash(git status:*),Bash(git diff:*),Bash(git show:*),Bash(cat:*)";
const DEFAULT_METERED_MODEL = "glm-4.2";
const DEFAULT_OLLAMA_MODEL = "qwen2.5:3b";

function buildAuditor(vendor: Vendor, model: string | undefined, tier: AuditorTier, sameFamily: boolean): Auditor {
  switch (vendor) {
    case "codex":
      return {
        tier,
        vendor,
        sameFamily,
        async invoke(prompt, dir, timeoutMs) {
          // Agentic: the auditor gathers its own evidence (git log/status/diff, law
          // from HEAD) inside a read-only sandbox — no "don't use tools" instruction,
          // unlike the v1 CodexCliClient judge (that reasons over given evidence only).
          const r = await execa("codex", ["exec", "-s", "read-only", prompt], {
            cwd: dir,
            stdin: "ignore",
            reject: false,
            timeout: timeoutMs ?? 180_000,
          });
          if (r.exitCode !== 0) {
            throw new Error(`codex exec failed (exit ${r.exitCode ?? "timeout"}): ${(r.stderr ?? "").slice(0, 300)}`);
          }
          return (r.stdout ?? "").trim();
        },
      };
    case "claude":
      return {
        tier,
        vendor,
        sameFamily,
        async invoke(prompt, dir, timeoutMs) {
          const r = await execa("claude", ["-p", prompt, "--allowedTools", CLAUDE_READONLY_TOOLS], {
            cwd: dir,
            reject: false,
            timeout: timeoutMs ?? 180_000,
          });
          if (r.exitCode !== 0) {
            throw new Error(`claude -p failed (exit ${r.exitCode ?? "timeout"}): ${(r.stderr ?? "").slice(0, 300)}`);
          }
          return (r.stdout ?? "").trim();
        },
      };
    case "ollama": {
      const m = model || DEFAULT_OLLAMA_MODEL;
      return {
        tier,
        vendor,
        model: m,
        sameFamily,
        async invoke(prompt, _dir, timeoutMs) {
          return new OllamaClient(m).complete({ prompt, timeoutMs: timeoutMs ?? 180_000 });
        },
      };
    }
    case "openrouter": {
      const m = model || DEFAULT_METERED_MODEL;
      return {
        tier,
        vendor,
        model: m,
        sameFamily,
        async invoke(prompt, _dir, timeoutMs) {
          const key = openrouterApiKey();
          if (!key) throw new Error("OPENROUTER_API_KEY not set");
          return new OpenRouterClient(m, key).complete({ prompt, timeoutMs: timeoutMs ?? 180_000 });
        },
      };
    }
  }
}

export interface DoctorCandidate {
  vendor: Vendor;
  ok: boolean;
  detail: string;
  /** Set to the rule text when this candidate is the one resolution picked. */
  firedRule: string | null;
}
export interface DoctorReport {
  executor: string;
  family: "openai" | "claude" | "other";
  candidates: DoctorCandidate[];
  chosen: {
    rule: string;
    tier: AuditorTier;
    vendor: Vendor | "none";
    model?: string;
    sameFamily: boolean;
  };
}

interface Resolution {
  auditor: Auditor;
  rule: string;
  candidates: DoctorCandidate[];
}

/**
 * Shared resolution walk (SPEC §2 "Auditor resolution"): five rules in order,
 * `VS_AUDITOR` overriding everything. Used by both `resolveAuditor` (the
 * value callers need) and `doctorReport` (the trace of why).
 */
async function resolveInternal(executor: string): Promise<Resolution> {
  const override = process.env.VS_AUDITOR;
  if (override) {
    const parsed = parseAuditorSpec(override);
    if (parsed) {
      const tier: AuditorTier = parsed.vendor === "codex" || parsed.vendor === "claude" ? "agentic" : "pre-gathered";
      return {
        auditor: buildAuditor(parsed.vendor, parsed.model, tier, false),
        rule: `override: VS_AUDITOR=${override}`,
        candidates: [{ vendor: parsed.vendor, ok: true, detail: `VS_AUDITOR=${override}`, firedRule: `override: VS_AUDITOR=${override}` }],
      };
    }
    // Malformed override (unrecognized vendor): fail open, fall through to
    // auto-resolution rather than wedging the auditor entirely (R8).
  }

  const family = executorFamily(executor);
  const [codex, claude] = await Promise.all([cachedProbe("codex", probeCodex), cachedProbe("claude", probeClaude)]);
  const candidates: DoctorCandidate[] = [
    { vendor: "codex", ok: codex.ok, detail: codex.detail ?? "auth-probed OK", firedRule: null },
    { vendor: "claude", ok: claude.ok, detail: claude.detail ?? "auth-probed OK", firedRule: null },
  ];

  if (codex.ok && family !== "openai") {
    const rule = "rule1: codex available, executor family≠openai → codex (agentic)";
    candidates[0]!.firedRule = rule;
    return { auditor: buildAuditor("codex", undefined, "agentic", false), rule, candidates };
  }
  if (claude.ok && family !== "claude") {
    const rule = "rule2: claude available, executor family≠claude → claude (agentic)";
    candidates[1]!.firedRule = rule;
    return { auditor: buildAuditor("claude", undefined, "agentic", false), rule, candidates };
  }
  if (codex.ok) {
    const rule = "rule3: only codex available, executor is openai-family → codex (agentic, same_family)";
    candidates[0]!.firedRule = rule;
    return { auditor: buildAuditor("codex", undefined, "agentic", true), rule, candidates };
  }
  if (claude.ok) {
    const rule = "rule4: only claude available, executor is claude-family → claude (agentic, same_family)";
    candidates[1]!.firedRule = rule;
    return { auditor: buildAuditor("claude", undefined, "agentic", true), rule, candidates };
  }

  // rule 5: only metered options. VS_AUDITOR_METERED is the "user chooses at
  // doctor time" configured preference; absent that, the recommended default
  // (glm-4.2 via OpenRouter) — only when the user opted in with a key.
  const configuredRaw = process.env.VS_AUDITOR_METERED;
  const configured = configuredRaw ? parseAuditorSpec(configuredRaw) : null;
  if (configured) {
    const rule = `rule5: configured metered choice (VS_AUDITOR_METERED=${configuredRaw})`;
    candidates.push({ vendor: configured.vendor, ok: true, detail: rule, firedRule: rule });
    return { auditor: buildAuditor(configured.vendor, configured.model, "pre-gathered", false), rule, candidates };
  }
  const key = openrouterApiKey();
  const detail = key ? "OPENROUTER_API_KEY present" : "OPENROUTER_API_KEY not set";
  if (key) {
    const rule = `rule5: no agentic CLI available; metered default (openrouter:${DEFAULT_METERED_MODEL})`;
    candidates.push({ vendor: "openrouter", ok: true, detail, firedRule: rule });
    return { auditor: buildAuditor("openrouter", DEFAULT_METERED_MODEL, "pre-gathered", false), rule, candidates };
  }
  candidates.push({ vendor: "openrouter", ok: false, detail, firedRule: null });

  return { auditor: ABSENT_AUDITOR, rule: "floor: nothing available → auditor_absent", candidates };
}

/**
 * Resolve the cross-family auditor for `executor` (SPEC §2 "Auditor
 * resolution"). Nothing available → `{tier: "absent"}`; callers still run
 * mechanical law checks (R8) and record `auditor_absent` telemetry.
 */
export async function resolveAuditor(executor: string): Promise<Auditor> {
  return (await resolveInternal(executor)).auditor;
}

/** Which rule fired and why, per candidate — the brain for `veritaserum doctor` (CLI wiring is separate). */
export async function doctorReport(executor: string): Promise<DoctorReport> {
  const { auditor, rule, candidates } = await resolveInternal(executor);
  return {
    executor,
    family: executorFamily(executor),
    candidates,
    chosen: {
      rule,
      tier: auditor.tier,
      vendor: auditor.vendor,
      ...(auditor.model ? { model: auditor.model } : {}),
      sameFamily: auditor.sameFamily,
    },
  };
}
