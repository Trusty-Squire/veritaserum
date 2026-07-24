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
 * ollama's context window (num_ctx), in tokens. VS_OLLAMA_NUM_CTX overrides.
 *
 * WHY THIS EXISTS: /api/chat with no `options.num_ctx` makes ollama fall back to
 * its 4096-token default, and it drops the FRONT of an over-long prompt first —
 * which is exactly where RULES_BLOCK (~1.6k tokens of audit guards) sits. On a
 * receipt-heavy audit the model would silently never see the rules. Default is
 * sized to the worst case the auditor builds:
 *   64 KB receipts tail ÷ ~3.9 bytes/token ≈ 16.5k tokens
 *   + ~1.6k rules block + user request/final message + JSON-response headroom
 *   → 24576 (fits qwen2.5:14b's 32768 ceiling with room to spare).
 * TRADEOFF: ollama allocates a KV cache proportional to num_ctx, so a bigger
 * window costs RAM and some latency even on short prompts. Acceptable on the
 * 125 GB production box; the env override lets a smaller box dial it down.
 */
export function ollamaNumCtx(): number {
  const raw = process.env.VS_OLLAMA_NUM_CTX;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 24_576;
}

/** Usage counters ollama reports on the FINAL stream chunk. Exposed on the client
 *  after complete() (read-only to consumers) so the auditor MAY later fold them into
 *  telemetry — NOT wired anywhere yet. */
export interface OllamaUsage {
  promptEvalCount?: number;
  evalCount?: number;
}

/** The stream chunk shape: many {message:{content},done:false} then one final
 *  {done:true, prompt_eval_count, eval_count}. All fields optional/defensive. */
interface OllamaStreamChunk {
  message?: { content?: string };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

/** A stream that never reaches done:true, or emits an unparseable line, is a DEFECT
 *  — not a transient blip — so complete() must NOT retry it. */
class MalformedStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedStreamError";
  }
}

/** AbortSignal.timeout rejects with a "TimeoutError"; a manual abort an "AbortError".
 *  Neither is ever retried. (Both are DOMExceptions, which are instanceof Error on Node.) */
function isAbortLike(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/**
 * ollama — local HTTP, no auth, no metered spend. Used both as a testbed EXECUTOR
 * (goose + qwen2.5:3b/llama3.2:1b, SPEC §3) and, via VS_AUDITOR="ollama:<model>",
 * as a pre-gathered-tier auditor. Plain fetch; no new deps.
 */
export class OllamaClient implements LlmClient {
  readonly vendor = "ollama" as const;
  /** prompt_eval_count / eval_count from the last SUCCESSFUL complete(). Read-only to
   *  consumers; set by complete(). Undefined until the first successful call. */
  lastUsage: OllamaUsage | undefined = undefined;
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
    // WHY stream:true. With stream:false ollama sends NO bytes — not even response
    // headers — until the ENTIRE generation finishes. Node's fetch (undici) hard-caps
    // time-to-headers at 300s and then rejects with UND_ERR_HEADERS_TIMEOUT, surfacing
    // as a TypeError "fetch failed". On this CPU box prompt-eval runs ~16 tok/s, so any
    // prompt past ~4-5k tokens structurally cannot answer within 300s: the per-attempt
    // AbortSignal.timeout below (900s in resolve.ts) never gets to matter — undici kills
    // it at 300s first — the death is misclassified as a transient network reject, and
    // the retry loop re-pays ~300s twice more: ~15 min of guaranteed-futile compute per
    // long audit. With stream:true ollama ACKs the request and flushes headers immediately
    // (before generating), so undici's 300s cap stops binding and the AbortSignal.timeout
    // — which wraps the whole fetch+read below — becomes the only budget governing
    // prompt-eval + generation.
    //
    // Retry ONLY the transient classes (prod telemetry 2026-07-21: 26/82 audits, 32%,
    // died "fetch failed" — TCP rejections when concurrent audits + embeds overwhelm
    // ollama's request queue): a network-level fetch reject (TypeError "fetch failed",
    // ECONNRESET/REFUSED) and HTTP 5xx (503 queue-full). NEVER retry an abort/timeout
    // (the per-attempt budget already fired; a retry just doubles it), an HTTP 4xx (a
    // real request problem), or a MALFORMED stream (a garbled / never-done stream is a
    // defect, not a blip). The pinned auditor is free and has no fallback
    // (src/run-audit.ts), so one dropped connection loses the whole LLM tier for the turn.
    const backoff = this.retryBackoffMs;
    for (let attempt = 0; ; attempt++) {
      const isLast = attempt >= backoff.length;
      // Fresh timeout per attempt; each retry gets the full per-attempt budget. It now
      // covers the WHOLE stream: passed to fetch (cancels the socket on fire) AND raced
      // against the body read in accumulateStream (guarantees the read loop unwinds).
      const signal = req.timeoutMs ? AbortSignal.timeout(req.timeoutMs) : undefined;
      let res: Awaited<ReturnType<typeof fetch>>;
      try {
        res = await fetch(`${this.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: this.model,
            stream: true,
            // Constrain decoding to valid JSON. In src/ the only consumer is the auditor path
            // (resolve.ts), which always expects a strict-JSON verdict; forcing `format:"json"`
            // stops the model emitting code fences / prose (the parse-failure class seen when the
            // audited turn's final message is itself JSON). eval/ scripts reimplement their own
            // ollama fetch, so this class is auditor-only — unconditional is safe.
            format: "json",
            // num_ctx: without this ollama defaults to 4096 tokens and truncates the
            // FRONT of the prompt — where RULES_BLOCK lives — so on receipt-heavy audits
            // the model never saw the guards. temperature 0: no temperature was set
            // before, so ollama used its default (0.8); pinning 0 makes the verdict as
            // deterministic as the model allows (relied on by the guard-compliance eval,
            // which runs each scenario twice and expects agreement). See ollamaNumCtx().
            options: { num_ctx: ollamaNumCtx(), temperature: 0 },
            messages: [
              ...(req.system ? [{ role: "system", content: req.system }] : []),
              { role: "user", content: req.prompt },
            ],
          }),
          signal,
        });
      } catch (err) {
        // Abort/timeout is never retried — rethrow unchanged.
        if (isAbortLike(err)) throw err;
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
      try {
        const { content, usage } = await this.accumulateStream(res, signal);
        this.lastUsage = usage;
        return content.trim();
      } catch (err) {
        // Abort/timeout and a malformed stream are NON-transient — rethrow, no retry.
        // A network error MID-stream (socket dropped after headers) is transient — retry.
        if (isAbortLike(err) || err instanceof MalformedStreamError) throw err;
        if (isLast)
          throw new Error(
            `ollama stream failed (${attempt + 1} attempts): ${err instanceof Error ? err.message : String(err)}`,
          );
        await new Promise((r) => setTimeout(r, backoff[attempt]));
        continue;
      }
    }
  }

  /**
   * Read ollama's streaming /api/chat response and return the concatenated text plus
   * usage. Each line is one JSON object — many {message:{content:"<fragment>"},done:false}
   * then exactly one final {done:true, prompt_eval_count, eval_count}. We read raw bytes,
   * buffer across chunk boundaries (a single JSON line can be split mid-object between two
   * network chunks), split on newlines, and concatenate the message.content fragments.
   * Aborts race the read against the signal so the loop unwinds even if the transport
   * doesn't surface the cancellation; the reader is always released in finally. A stream
   * that never reports done:true, or a line that won't parse, throws MalformedStreamError
   * (non-retryable — it is a defect, not a transient blip).
   */
  private async accumulateStream(
    res: Awaited<ReturnType<typeof fetch>>,
    signal: AbortSignal | undefined,
  ): Promise<{ content: string; usage: OllamaUsage }> {
    const body = res.body as ReadableStream<Uint8Array> | null;
    if (!body) throw new MalformedStreamError("ollama stream had no response body");
    const reader = body.getReader();
    const decoder = new TextDecoder();

    // Reject the read loop the instant the signal fires, regardless of whether the
    // transport surfaces the cancellation on reader.read() itself.
    let onAbort: (() => void) | undefined;
    const abortPromise: Promise<never> | undefined = signal
      ? new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason);
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", onAbort, { once: true });
        })
      : undefined;

    let buf = "";
    let content = "";
    let done = false;
    const usage: OllamaUsage = {};
    const consume = (raw: string): void => {
      const line = raw.trim();
      if (line === "") return;
      let obj: OllamaStreamChunk;
      try {
        obj = JSON.parse(line) as OllamaStreamChunk;
      } catch {
        throw new MalformedStreamError(`ollama stream line was not valid JSON: ${line.slice(0, 120)}`);
      }
      if (typeof obj.message?.content === "string") content += obj.message.content;
      if (obj.done) {
        done = true;
        if (typeof obj.prompt_eval_count === "number") usage.promptEvalCount = obj.prompt_eval_count;
        if (typeof obj.eval_count === "number") usage.evalCount = obj.eval_count;
      }
    };

    try {
      for (;;) {
        const chunk = abortPromise ? await Promise.race([reader.read(), abortPromise]) : await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          consume(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
      consume(buf); // trailing line with no terminating newline
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      void reader.cancel().catch(() => {});
    }
    if (!done) throw new MalformedStreamError("ollama stream ended before a done:true chunk");
    return { content, usage };
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
