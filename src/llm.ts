/**
 * LLM access + cross-vendor JUDGE selection (DESIGN §9; owner policy 2026-07-06).
 *
 * Self-preference bias is measured: a judge is far likelier to pass its own model
 * family's output. So the verify-time judge must be a DIFFERENT vendor than the
 * executor. gstack's rule, adopted verbatim:
 *
 *   - executor ≠ codex  and codex  available → judge = codex   (local subscription)
 *   - executor ≠ claude and claude available → judge = claude  (local subscription)
 *   - neither cross-vendor local subscription → OpenRouter, model USER-SPECIFIED
 *
 * Local subscription CLIs (`codex exec`, `claude -p`) are FREE — no metered spend.
 * OpenRouter is the only metered path and is opt-in + approval-gated (never default).
 */
import { execa } from "execa";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Vendor = "codex" | "claude" | "ollama" | "openrouter";

export interface LlmRequest {
  system?: string;
  prompt: string;
  timeoutMs?: number;
}
export interface LlmClient {
  readonly vendor: Vendor;
  complete(req: LlmRequest): Promise<string>;
}

// ---------------------------------------------------------------------------
// Availability — is a local subscription usable right now (binary + auth)?
// ---------------------------------------------------------------------------

export async function onPath(bin: string): Promise<boolean> {
  const r = await execa("sh", ["-c", `command -v ${bin}`], { reject: false });
  return r.exitCode === 0;
}

export async function codexAvailable(): Promise<boolean> {
  return (await onPath("codex")) && existsSync(join(homedir(), ".codex", "auth.json"));
}
export async function claudeAvailable(): Promise<boolean> {
  // `claude` on PATH + a claude config dir (auth). Kept loose; a live call still
  // fails closed if auth is stale.
  return (await onPath("claude")) && existsSync(join(homedir(), ".claude"));
}

/** Local-subscription vendors usable now, in preference order. */
export async function detectVendors(): Promise<Vendor[]> {
  const out: Vendor[] = [];
  if (await codexAvailable()) out.push("codex");
  if (await claudeAvailable()) out.push("claude");
  return out;
}

// ---------------------------------------------------------------------------
// Cross-vendor judge selection
// ---------------------------------------------------------------------------

export class NoJudgeVendorError extends Error {
  constructor() {
    super(
      "no cross-vendor judge available: need a codex or claude subscription different " +
        "from the executor, or specify an OpenRouter model (metered, requires approval)",
    );
    this.name = "NoJudgeVendorError";
  }
}

export interface JudgeSelection {
  vendor: Vendor;
  reason: string;
  metered: boolean;
}

export interface SelectOpts {
  /** Local-subscription vendors available (defaults to live detection). */
  available?: Vendor[];
  /** If set, OpenRouter is permitted as a last resort with this model. */
  openrouterModel?: string;
}

/**
 * Pick the judge vendor for a given executor. Pure given `available`; the owner's
 * ordering (codex, then claude) is preserved.
 */
export function selectJudgeVendor(executor: Vendor | "unknown", opts: SelectOpts): JudgeSelection {
  const available = opts.available ?? [];
  if (executor !== "codex" && available.includes("codex")) {
    return { vendor: "codex", reason: `executor=${executor}≠codex, codex subscription available`, metered: false };
  }
  if (executor !== "claude" && available.includes("claude")) {
    return { vendor: "claude", reason: `executor=${executor}≠claude, claude subscription available`, metered: false };
  }
  if (opts.openrouterModel) {
    return {
      vendor: "openrouter",
      reason: `no cross-vendor local subscription; OpenRouter model "${opts.openrouterModel}" (metered)`,
      metered: true,
    };
  }
  throw new NoJudgeVendorError();
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/** codex exec, read-only, tool-use forbidden — a judge reasons over given evidence. */
export class CodexCliClient implements LlmClient {
  readonly vendor = "codex" as const;
  async complete(req: LlmRequest): Promise<string> {
    const prompt = [
      req.system ? `${req.system}\n` : "",
      "You are in a read-only reasoning turn. Do NOT use tools, run commands, or explore.",
      "Answer only from the text provided.\n",
      req.prompt,
    ].join("\n");
    // stdin: "ignore" — codex exec otherwise blocks "Reading additional input from
    // stdin..." waiting for an EOF that a piped-but-unclosed stdin never sends.
    const r = await execa("codex", ["exec", "-s", "read-only", prompt], {
      reject: false,
      stdin: "ignore",
      timeout: req.timeoutMs ?? 120_000,
    });
    return (r.stdout ?? "").trim();
  }
}

/** claude in headless print mode. */
export class ClaudeCliClient implements LlmClient {
  readonly vendor = "claude" as const;
  async complete(req: LlmRequest): Promise<string> {
    const args = ["-p", req.prompt];
    if (req.system) args.push("--append-system-prompt", req.system);
    const r = await execa("claude", args, { reject: false, timeout: req.timeoutMs ?? 120_000 });
    return (r.stdout ?? "").trim();
  }
}

/** Retry backoff (ms per retry). VS_OLLAMA_RETRY_BACKOFF_MS (comma-separated) overrides
 *  it so the hermetic suite can force instant/no-sleep retries; unset → prod [2s, 8s]. */
export function ollamaRetryBackoffMs(): number[] {
  const raw = process.env.VS_OLLAMA_RETRY_BACKOFF_MS;
  if (raw === undefined) return [2_000, 8_000];
  return raw.split(",").map((s) => s.trim()).filter((s) => s !== "").map(Number);
}

/**
 * ollama — local HTTP, no auth, no metered spend. Used both as a testbed EXECUTOR
 * (goose + qwen2.5:3b/llama3.2:1b, SPEC §3) and, via VS_AUDITOR="ollama:<model>",
 * as a pre-gathered-tier auditor. Plain fetch; no new deps.
 */
export class OllamaClient implements LlmClient {
  readonly vendor = "ollama" as const;
  constructor(
    readonly model: string,
    private readonly baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    // Backoff before each retry (ms). One entry per retry → default = 2 retries
    // (3 attempts). Injected by tests, or overridden process-wide via env so the
    // hermetic suite (closed loopback port, test/setup.ts) fails instantly instead
    // of sleeping ~10s per audit.
    private readonly retryBackoffMs: number[] = ollamaRetryBackoffMs(),
  ) {}
  async complete(req: LlmRequest): Promise<string> {
    // Retry transient ollama failures. Prod telemetry (2026-07-21): 26/82 audits
    // (32%) died with "fetch failed" — TCP-level rejections clustered in the busy
    // hours when concurrent audits + embeds overwhelm ollama's request queue. The
    // service is healthy; these are transient. The pinned auditor is free and has
    // NO fallback (src/run-audit.ts), so one dropped connection loses the whole LLM
    // tier for the turn. Retry ONLY the transient classes: a network-level fetch
    // reject (TypeError "fetch failed", ECONNRESET/REFUSED) and HTTP 5xx (ollama
    // returns 503 when its request queue is full). NEVER retry an abort (the
    // per-attempt AbortSignal.timeout already fired — that budget is generous and a
    // retry would just double it) or an HTTP 4xx (a real request problem no retry
    // can fix). Backoff adds ~10s worst case — fine for a detached async audit.
    const backoff = this.retryBackoffMs;
    for (let attempt = 0; ; attempt++) {
      const isLast = attempt >= backoff.length;
      let res: Awaited<ReturnType<typeof fetch>>;
      try {
        res = await fetch(`${this.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: this.model,
            stream: false,
            // Constrain decoding to valid JSON. In src/ the only consumer is the auditor path
            // (resolve.ts), which always expects a strict-JSON verdict; forcing `format:"json"`
            // stops the model emitting code fences / prose (the parse-failure class seen when the
            // audited turn's final message is itself JSON). eval/ scripts reimplement their own
            // ollama fetch, so this class is auditor-only — unconditional is safe.
            format: "json",
            messages: [
              ...(req.system ? [{ role: "system", content: req.system }] : []),
              { role: "user", content: req.prompt },
            ],
          }),
          // Fresh timeout per attempt; each retry gets the full per-attempt budget.
          signal: req.timeoutMs ? AbortSignal.timeout(req.timeoutMs) : undefined,
        });
      } catch (err) {
        // AbortSignal.timeout rejects with a "TimeoutError"; a manual abort an
        // "AbortError". Never retried — rethrow unchanged.
        if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
        if (isLast)
          throw new Error(
            `ollama fetch failed (${attempt + 1} attempts): ${err instanceof Error ? err.message : String(err)}`,
          );
        await new Promise((r) => setTimeout(r, backoff[attempt]));
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        if (res.status >= 500 && !isLast) {
          await new Promise((r) => setTimeout(r, backoff[attempt]));
          continue;
        }
        throw new Error(`ollama ${res.status} (${attempt + 1} attempts): ${text}`);
      }
      const data = (await res.json()) as { message?: { content?: string } };
      return (data.message?.content ?? "").trim();
    }
  }
}

/** OpenRouter — metered. Constructed only when the user opts in; never auto-selected. */
export class OpenRouterClient implements LlmClient {
  readonly vendor = "openrouter" as const;
  constructor(
    private readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl = "https://openrouter.ai/api/v1",
  ) {}
  async complete(req: LlmRequest): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: [
          ...(req.system ? [{ role: "system", content: req.system }] : []),
          { role: "user", content: req.prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`openrouter ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return (data.choices?.[0]?.message?.content ?? "").trim();
  }
}

export function makeClient(
  sel: JudgeSelection,
  openrouter?: { apiKey: string; model: string; baseUrl?: string },
  ollama?: { model: string; baseUrl?: string },
): LlmClient {
  switch (sel.vendor) {
    case "codex":
      return new CodexCliClient();
    case "claude":
      return new ClaudeCliClient();
    case "ollama":
      if (!ollama) throw new Error("ollama selected but no model provided");
      return new OllamaClient(ollama.model, ollama.baseUrl);
    case "openrouter":
      if (!openrouter) throw new Error("OpenRouter selected but no apiKey/model provided");
      return new OpenRouterClient(openrouter.model, openrouter.apiKey, openrouter.baseUrl);
  }
}

/** OPENROUTER_API_KEY, or undefined when unset (the glm/openrouter auditor path is opt-in). */
export function openrouterApiKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY || undefined;
}

/** Test double: deterministic, no process/network. */
export class MockLlmClient implements LlmClient {
  constructor(
    readonly vendor: Vendor,
    private readonly responder: (req: LlmRequest) => string,
  ) {}
  async complete(req: LlmRequest): Promise<string> {
    return this.responder(req);
  }
}
