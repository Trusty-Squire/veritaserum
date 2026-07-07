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

export type Vendor = "codex" | "claude" | "openrouter";

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

async function onPath(bin: string): Promise<boolean> {
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
    const r = await execa("codex", ["exec", "-s", "read-only", prompt], {
      reject: false,
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

export function makeClient(sel: JudgeSelection, openrouter?: { apiKey: string; model: string; baseUrl?: string }): LlmClient {
  switch (sel.vendor) {
    case "codex":
      return new CodexCliClient();
    case "claude":
      return new ClaudeCliClient();
    case "openrouter":
      if (!openrouter) throw new Error("OpenRouter selected but no apiKey/model provided");
      return new OpenRouterClient(openrouter.model, openrouter.apiKey, openrouter.baseUrl);
  }
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
