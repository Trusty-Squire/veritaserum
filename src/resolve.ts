/**
 * Auditor resolution: pick the cross-family auditor from local subscriptions
 * (SPEC §2 "Auditor resolution"). Used by the CLI (hook path and `doctor`).
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
  typesafeApiKey,
  OllamaClient,
  OpenRouterClient,
  type Vendor,
} from "./llm.js";
import { invokeJevWithMeta, JEV_MODEL, JEV_TIMEOUT_MS } from "./jev.js";
// The knight (authored gates up front), the transcriber (turned a complaint into a gate),
// and the semantic judge (ruled on a gate's claim over captured evidence) are GONE. All
// three were special cases of what the auditor already does — author a check, or rule on a
// claim against evidence — each with its own vendor resolution, its own LLM client, and its
// own spawn path. One role: the auditor (src/auditor.ts).

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

/** Usage for one provider invocation. A missing price is deliberately distinct
 * from zero: subscription CLIs and Jev can report exact tokens without exposing
 * a per-call dollar price. */
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
  /** True when the auditor shares a model family with the executor (rules 3/4). */
  sameFamily: boolean;
  /** Usage for the most recent invoke(), reset at the start of every call. */
  lastUsage?: AuditorUsage;
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

const AUDITOR_VENDORS = new Set<Vendor>(["codex", "claude", "ollama", "openrouter", "jev"]);

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

/** An agentic auditor is itself a hooked coding agent running in the audited repo, so its
 *  own turn-end would enqueue an audit — which spawns another auditor, forever. This stamp
 *  tells veritaserum's hooks (cli.ts's isAuditorChild) that this process is the auditor.
 *  execa extends process.env at spawn time, so this must NOT snapshot it here. */
function auditorChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env } as NodeJS.ProcessEnv;
  env.VS_AUDIT_CHILD = "1";
  delete env.TYPESAFE_API_KEY;
  delete env.OPENROUTER_API_KEY;
  return env;
}

/** Why a CLI auditor failed. These tools print the cause on stdout and exit non-zero. */
function reasonFrom(r: { stdout?: string; stderr?: string }): string {
  const text = `${r.stderr ?? ""} ${r.stdout ?? ""}`.trim();
  return text ? text.slice(0, 300) : "no output";
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Parse `codex exec --json`. The completed turn is the provider's exact usage
 * envelope; the final completed agent message is the verdict text. */
export function parseCodexExecJson(stdout: string, configuredModel?: string): { text: string; usage: AuditorUsage } {
  let text = "";
  let sawEvent = false;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof event.type === "string") sawEvent = true;
    if (event.type === "item.completed") {
      const item = event.item as { type?: unknown; text?: unknown } | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") text = item.text;
    }
    if (event.type === "turn.completed") {
      const usage = event.usage as { input_tokens?: unknown; output_tokens?: unknown } | undefined;
      inputTokens = nonnegativeNumber(usage?.input_tokens);
      outputTokens = nonnegativeNumber(usage?.output_tokens);
    }
  }
  const usage: AuditorUsage = inputTokens !== undefined && outputTokens !== undefined
    ? { status: "reported", inputTokens, outputTokens, ...(configuredModel ? { model: configuredModel } : {}) }
    : { status: "unavailable", reason: "codex turn.completed did not report token usage", ...(configuredModel ? { model: configuredModel } : {}) };
  // Compatibility with older Codex versions and hermetic CLI shims that ignore
  // --json and return the verdict body directly. Usage remains explicitly
  // unavailable; never infer it from the body size.
  if (!sawEvent && !text) text = stdout;
  return { text: text.trim(), usage };
}

/** Parse `claude -p --output-format json`. `modelUsage` is aggregate and includes
 * cache creation/read input, so summing it gives the full provider-reported input
 * volume across an agentic tool loop. */
export function parseClaudePrintJson(stdout: string, configuredModel: string): { text: string; usage: AuditorUsage } {
  let data: {
    result?: unknown;
    total_cost_usd?: unknown;
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
      cache_read_input_tokens?: unknown;
    };
    modelUsage?: Record<string, {
      inputTokens?: unknown;
      outputTokens?: unknown;
      cacheCreationInputTokens?: unknown;
      cacheReadInputTokens?: unknown;
      costUSD?: unknown;
    }>;
  };
  try {
    data = JSON.parse(stdout) as typeof data;
  } catch {
    return {
      text: "",
      usage: { status: "unavailable", reason: "claude JSON result did not parse", model: configuredModel },
    };
  }

  const models = Object.entries(data.modelUsage ?? {});
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let modelCostUsd: number | undefined;
  let model = configuredModel;
  if (models.length > 0) {
    let input = 0;
    let output = 0;
    let complete = true;
    let cost = 0;
    let costComplete = true;
    for (const [, usage] of models) {
      const direct = nonnegativeNumber(usage.inputTokens);
      const cacheCreation = nonnegativeNumber(usage.cacheCreationInputTokens) ?? 0;
      const cacheRead = nonnegativeNumber(usage.cacheReadInputTokens) ?? 0;
      const out = nonnegativeNumber(usage.outputTokens);
      const modelCost = nonnegativeNumber(usage.costUSD);
      if (modelCost === undefined) costComplete = false;
      else cost += modelCost;
      if (direct === undefined || out === undefined) complete = false;
      else {
        input += direct + cacheCreation + cacheRead;
        output += out;
      }
    }
    if (complete) {
      inputTokens = input;
      outputTokens = output;
    }
    if (costComplete) modelCostUsd = cost;
    model = models.map(([name]) => name).sort().join(",");
  } else {
    const direct = nonnegativeNumber(data.usage?.input_tokens);
    const cacheCreation = nonnegativeNumber(data.usage?.cache_creation_input_tokens) ?? 0;
    const cacheRead = nonnegativeNumber(data.usage?.cache_read_input_tokens) ?? 0;
    const out = nonnegativeNumber(data.usage?.output_tokens);
    if (direct !== undefined && out !== undefined) {
      inputTokens = direct + cacheCreation + cacheRead;
      outputTokens = out;
    }
  }
  const costUsd = nonnegativeNumber(data.total_cost_usd) ?? modelCostUsd;
  const usage: AuditorUsage = inputTokens !== undefined && outputTokens !== undefined
    ? {
        status: "reported",
        inputTokens,
        outputTokens,
        model,
        ...(costUsd !== undefined ? { costUsd } : {}),
      }
    : { status: "unavailable", reason: "claude JSON result did not report token usage", model };
  return { text: typeof data.result === "string" ? data.result.trim() : "", usage };
}

/** A quota/limit refusal is not a broken auditor — it is an EXHAUSTED one. Same shape as an
 *  outage from our side (the audit does not happen), but the remedy is a different vendor,
 *  not a retry. Recognising it is what lets the audit fall back instead of giving up. */
export function isExhausted(message: string): boolean {
  return /reached your .*limit|usage limit|rate limit|quota|429|insufficient credit|out of credit/i.test(message);
}
// Real agentic CLI audits can legitimately exceed three minutes while making
// read-only probes. They are detached from the hook; a five-minute async bound
// preserves liveness without turning normal tool use into a false infra error.
const DEFAULT_AUDITOR_TIMEOUT_MS = 300_000;
// A local ollama auditor is free and CPU-bound: on the production box (no GPU,
// competing audits) qwen2.5:14b's p90 sits at ~350s, so the 5-minute bound was
// converting ~30% of real audits into timeout errors (measured 2026-07-21, 14
// of 46 production rows). Tokens cost nothing here — only wall clock — so the
// bound is generous; the audit is detached and nothing blocks on it.
const OLLAMA_AUDITOR_TIMEOUT_MS = 900_000;
const DEFAULT_METERED_MODEL = "glm-4.2";
const DEFAULT_OLLAMA_MODEL = "qwen2.5:3b";
const AUDITOR_EFFORTS = new Set(["low", "medium", "high"]);

/**
 * The auditor's model, pinned — NOT the user's default.
 *
 * We passed no --model, so `claude -p` ran on whatever the user's default was. For a Fable
 * subscriber that is the frontier model, on EVERY turn with tool activity: ~1000 audits in a
 * day, each re-reading the receipts, each running its own tool loop. It drained the quota,
 * and because nothing recorded the cost, the first symptom was the auditor dying with "you've
 * reached your limit" — which then looked like a veritaserum bug.
 *
 * A tool that silently spends your most expensive quota is not free, whatever the README says.
 * The auditor's job — does this claim follow from these receipts — is a judgment task, not a
 * frontier-reasoning one, so default to the mid tier and let the user pay up if they want to:
 *   VS_AUDITOR=claude:opus  ·  VS_AUDITOR=claude:haiku  ·  VS_AUDITOR=codex:gpt-5.6
 * Choose with the seeded eval (catch rate vs false-flag rate per model), not with taste.
 */
const DEFAULT_CLAUDE_AUDITOR_MODEL = process.env.VS_AUDITOR_MODEL || "sonnet";

function buildAuditor(vendor: Vendor, model: string | undefined, tier: AuditorTier, sameFamily: boolean): Auditor {
  switch (vendor) {
    case "codex": {
      const auditor: Auditor = {
        tier,
        vendor,
        model,
        sameFamily,
        async invoke(prompt, dir, timeoutMs) {
          auditor.lastUsage = {
            status: "unavailable",
            reason: "codex invocation did not return usage",
            ...(model ? { model } : {}),
          };
          // Agentic: the auditor gathers its own evidence (git log/status/diff, law
          // from HEAD) inside a read-only sandbox — no "don't use tools" instruction,
          // unlike the v1 CodexCliClient judge (that reasons over given evidence only).
          //
          // The prompt goes over STDIN (`codex exec -`), never argv: Linux caps a single
          // argument at MAX_ARG_STRLEN (128 KiB), and a real session's receipts tail blows
          // past that, so an argv prompt made execve fail with E2BIG on exactly the long
          // sessions worth auditing — surfacing as a bogus "timeout" with no stderr.
          // VS_AUDITOR_EFFORT (low|medium|high) opts into -c model_reasoning_effort=<value>;
          // unset or anything else omits the flag and falls open to codex's own default.
          const effort = process.env.VS_AUDITOR_EFFORT;
          const effortArgs = effort && AUDITOR_EFFORTS.has(effort) ? ["-c", `model_reasoning_effort=${effort}`] : [];
          const r = await execa("codex", ["exec", "--json", "-s", "read-only", ...(model ? ["-m", model] : []), ...effortArgs, "-"], {
            cwd: dir,
            input: prompt,
            env: auditorChildEnv(),
            reject: false,
            timeout: timeoutMs ?? DEFAULT_AUDITOR_TIMEOUT_MS,
          });
          if (r.exitCode !== 0) {
            // The reason is often on STDOUT, not stderr: `claude -p` and `codex exec` print
            // "You've reached your … limit" to stdout and exit 1. Capturing stderr alone
            // recorded an error with an EMPTY reason — an audit that failed for no stated
            // cause, which is indistinguishable from one that never ran.
            throw new Error(`codex exec failed (exit ${r.exitCode ?? "timeout"}): ${reasonFrom(r)}`);
          }
          const parsed = parseCodexExecJson(r.stdout ?? "", model);
          auditor.lastUsage = parsed.usage;
          return parsed.text;
        },
      };
      return auditor;
    }
    case "claude": {
      // Pin the model. With no --model, `claude -p` inherits the USER's default — for a Fable
      // subscriber, the frontier model, on every turn. That is what drained the quota.
      const claudeModel = model ?? DEFAULT_CLAUDE_AUDITOR_MODEL;
      const auditor: Auditor = {
        tier,
        vendor,
        model: claudeModel,
        sameFamily,
        async invoke(prompt, dir, timeoutMs) {
          auditor.lastUsage = {
            status: "unavailable",
            reason: "claude invocation did not return usage",
            model: claudeModel,
          };
          // Prompt over STDIN, not argv — same MAX_ARG_STRLEN (128 KiB) ceiling as the
          // codex path above; a long session's prompt exceeds it and execve fails E2BIG.
          const r = await execa(
            "claude",
            ["-p", "--output-format", "json", "--allowedTools", CLAUDE_READONLY_TOOLS, "--model", claudeModel],
            {
            cwd: dir,
            input: prompt,
            env: auditorChildEnv(),
            reject: false,
            timeout: timeoutMs ?? DEFAULT_AUDITOR_TIMEOUT_MS,
            },
          );
          if (r.exitCode !== 0) {
            throw new Error(`claude -p failed (exit ${r.exitCode ?? "timeout"}): ${reasonFrom(r)}`);
          }
          const parsed = parseClaudePrintJson(r.stdout ?? "", claudeModel);
          auditor.lastUsage = parsed.usage;
          return parsed.text;
        },
      };
      return auditor;
    }

    case "ollama": {
      const m = model || DEFAULT_OLLAMA_MODEL;
      const auditor: Auditor = {
        tier,
        vendor,
        model: m,
        sameFamily,
        async invoke(prompt, _dir, timeoutMs) {
          auditor.lastUsage = { status: "unavailable", reason: "ollama did not report token usage", model: m };
          const client = new OllamaClient(m);
          const text = await client.complete({ prompt, timeoutMs: timeoutMs ?? OLLAMA_AUDITOR_TIMEOUT_MS });
          const inputTokens = client.lastUsage?.promptEvalCount;
          const outputTokens = client.lastUsage?.evalCount;
          if (inputTokens !== undefined && outputTokens !== undefined) {
            // Local inference has no provider/API charge. Host compute cost is outside
            // the provider-reported spend tracked here.
            auditor.lastUsage = { status: "reported", inputTokens, outputTokens, model: m, costUsd: 0 };
          }
          return text;
        },
      };
      return auditor;
    }
    case "openrouter": {
      const m = model || DEFAULT_METERED_MODEL;
      const auditor: Auditor = {
        tier,
        vendor,
        model: m,
        sameFamily,
        async invoke(prompt, _dir, timeoutMs) {
          auditor.lastUsage = { status: "unavailable", reason: "openrouter did not report token usage", model: m };
          const key = openrouterApiKey();
          if (!key) throw new Error("OPENROUTER_API_KEY not set");
          const client = new OpenRouterClient(m, key);
          const text = await client.complete({ prompt, timeoutMs: timeoutMs ?? DEFAULT_AUDITOR_TIMEOUT_MS });
          if (client.lastUsage) auditor.lastUsage = { status: "reported", ...client.lastUsage };
          return text;
        },
      };
      return auditor;
    }
    case "jev": {
      const m = model || JEV_MODEL;
      const auditor: Auditor = {
        tier: "pre-gathered",
        vendor,
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
async function resolveInternal(executor: string, explicitOverride?: string): Promise<Resolution> {
  const override = explicitOverride ?? process.env.VS_AUDITOR;
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

  // Jev (typesafe System One) sits on the existing ladder, not beside it.
  // Cross-family for both Claude and Codex executors; pre-gathered; ~350ms.
  // Skip the 20s CLI smoke probes when the key is present — the blocking path
  // cannot afford them. VS_AUDITOR still overrides everything above.
  if (typesafeApiKey()) {
    const rule = "jev: TYPESAFE_API_KEY present → jev-latest (pre-gathered Choice auditor, cross-family)";
    return {
      auditor: buildAuditor("jev", JEV_MODEL, "pre-gathered", false),
      rule,
      candidates: [{ vendor: "jev", ok: true, detail: "TYPESAFE_API_KEY present", firedRule: rule }],
    };
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
export async function resolveAuditor(executor: string, override?: string): Promise<Auditor> {
  return (await resolveInternal(executor, override)).auditor;
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
