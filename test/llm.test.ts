import { describe, it, expect, afterEach } from "vitest";
import { selectJudgeVendor, NoJudgeVendorError, MockLlmClient, OllamaClient, ollamaNumCtx } from "../src/llm.js";

// ---------------------------------------------------------------------------
// ollama streams now (stream:true): the response body is newline-delimited JSON,
// one object per line. These helpers build the byte-level ReadableStream a mocked
// fetch must return so the hermetic suite exercises the real accumulation path.
// ---------------------------------------------------------------------------
const enc = new TextEncoder();
/** A ReadableStream that emits the given string chunks (as bytes), in order, then closes.
 *  Chunk boundaries are arbitrary — they may split a JSON line mid-object. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
}
/** A well-formed /api/chat stream: one content fragment, then the final done chunk. */
function chatStream(content: string, usage: { prompt_eval_count?: number; eval_count?: number } = {}) {
  return {
    ok: true,
    status: 200,
    body: streamOf([
      JSON.stringify({ message: { content }, done: false }) + "\n",
      JSON.stringify({ done: true, message: { content: "" }, ...usage }) + "\n",
    ]),
  };
}

describe("cross-vendor judge selection (owner policy)", () => {
  it("picks codex when executor≠codex and codex is available", () => {
    const s = selectJudgeVendor("claude", { available: ["codex", "claude"] });
    expect(s.vendor).toBe("codex");
    expect(s.metered).toBe(false);
  });
  it("picks claude when executor is codex (codex would be same-vendor)", () => {
    const s = selectJudgeVendor("codex", { available: ["codex", "claude"] });
    expect(s.vendor).toBe("claude");
  });
  it("a goose/qwen executor gets codex (codex preferred over claude)", () => {
    expect(selectJudgeVendor("unknown", { available: ["codex", "claude"] }).vendor).toBe("codex");
  });
  it("falls to the only available cross-vendor subscription", () => {
    expect(selectJudgeVendor("codex", { available: ["claude"] }).vendor).toBe("claude");
    expect(selectJudgeVendor("claude", { available: ["codex"] }).vendor).toBe("codex");
  });
  it("uses OpenRouter (metered) ONLY when no cross-vendor local sub AND a model is given", () => {
    const s = selectJudgeVendor("claude", { available: ["claude"], openrouterModel: "x/y" });
    expect(s.vendor).toBe("openrouter");
    expect(s.metered).toBe(true);
  });
  it("throws when no cross-vendor judge and no OpenRouter model", () => {
    expect(() => selectJudgeVendor("claude", { available: ["claude"] })).toThrow(NoJudgeVendorError);
    expect(() => selectJudgeVendor("codex", { available: [] })).toThrow(NoJudgeVendorError);
  });
});

/**
 * FIX (2026-07-20): the auditor's only src/ consumer of OllamaClient always expects a strict-JSON
 * verdict, and prod telemetry showed 11 parse failures clustered on turns whose final message was
 * itself JSON/code-fenced (the model derailed its output format). Sending `format:"json"` to
 * ollama's /api/chat constrains decoding to valid JSON so the model can't emit prose/fences.
 */
describe("OllamaClient — forces JSON-constrained decoding", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("sends format:'json' in the /api/chat request body", async () => {
    let capturedBody: unknown;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      capturedBody = JSON.parse(init.body);
      return chatStream('{"claims":[]}');
    }) as unknown as typeof fetch;

    const out = await new OllamaClient("qwen2.5:14b").complete({ prompt: "audit this" });
    expect(out).toBe('{"claims":[]}');
    expect((capturedBody as { format?: string }).format).toBe("json");
  });
});

/**
 * FIX (2026-07-24): /api/chat with no options.num_ctx makes ollama default to a
 * 4096-token window and drop the FRONT of an over-long prompt — exactly where
 * RULES_BLOCK sits — so on receipt-heavy audits the model silently never saw the
 * guards. complete() now sends options.num_ctx (VS_OLLAMA_NUM_CTX-overridable,
 * default 24576 sized to the 64 KB receipts worst case) and temperature 0.
 */
describe("OllamaClient — sets num_ctx so long audit prompts are not truncated", () => {
  const realFetch = globalThis.fetch;
  const realEnv = process.env.VS_OLLAMA_NUM_CTX;
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realEnv === undefined) delete process.env.VS_OLLAMA_NUM_CTX;
    else process.env.VS_OLLAMA_NUM_CTX = realEnv;
  });

  const captureBody = (): { get: () => Record<string, unknown> } => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return chatStream("{}");
    }) as unknown as typeof fetch;
    return { get: () => body };
  };

  it("sends options.num_ctx (default 24576) and temperature 0", async () => {
    delete process.env.VS_OLLAMA_NUM_CTX;
    const cap = captureBody();
    await new OllamaClient("qwen2.5:14b").complete({ prompt: "audit this" });
    const options = cap.get().options as { num_ctx?: number; temperature?: number };
    expect(options.num_ctx).toBe(24_576);
    expect(options.temperature).toBe(0);
  });

  it("VS_OLLAMA_NUM_CTX overrides the default", async () => {
    process.env.VS_OLLAMA_NUM_CTX = "8192";
    expect(ollamaNumCtx()).toBe(8192);
    const cap = captureBody();
    await new OllamaClient("m").complete({ prompt: "x" });
    expect((cap.get().options as { num_ctx?: number }).num_ctx).toBe(8192);
  });

  it("ignores a non-numeric / non-positive override and keeps the default", () => {
    process.env.VS_OLLAMA_NUM_CTX = "garbage";
    expect(ollamaNumCtx()).toBe(24_576);
    process.env.VS_OLLAMA_NUM_CTX = "0";
    expect(ollamaNumCtx()).toBe(24_576);
  });
});

/**
 * FIX (2026-07-22): prod telemetry showed 26/82 audits (32%) dying with "fetch failed" —
 * transient TCP rejections when concurrent audits + embeds overwhelm ollama's request
 * queue. The pinned auditor is free and has no fallback, so a dropped connection loses
 * the whole LLM tier for the turn. complete() now retries the transient classes
 * (network-level fetch reject, HTTP 5xx) but NOT aborts (timeout already fired) or 4xx.
 * Backoff is injected as [0,0] so these stay fast.
 */
describe("OllamaClient — retries only transient failures", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const ok = (content: string) => chatStream(content);
  const httpErr = (status: number) => ({ ok: false, status, text: async () => `err ${status}` });
  const client = () => new OllamaClient("m", undefined, [0, 0]);

  it("network failure once, then succeeds → returns result, exactly 2 fetch calls", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      return ok('{"claims":[]}');
    }) as unknown as typeof fetch;

    const out = await client().complete({ prompt: "x" });
    expect(out).toBe('{"claims":[]}');
    expect(calls).toBe(2);
  });

  it("HTTP 503 once, then succeeds → retried (2 fetch calls)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1 ? httpErr(503) : ok('{"ok":1}');
    }) as unknown as typeof fetch;

    const out = await client().complete({ prompt: "x" });
    expect(out).toBe('{"ok":1}');
    expect(calls).toBe(2);
  });

  it("HTTP 400 → NOT retried (1 call, throws)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return httpErr(400);
    }) as unknown as typeof fetch;

    await expect(client().complete({ prompt: "x" })).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });

  it("abort/timeout → NOT retried (1 call, throws)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      const e = new Error("The operation timed out");
      e.name = "TimeoutError";
      throw e;
    }) as unknown as typeof fetch;

    await expect(client().complete({ prompt: "x", timeoutMs: 10 })).rejects.toThrow(/timed out/);
    expect(calls).toBe(1);
  });

  it("exhausts retries → error names the attempt count", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(client().complete({ prompt: "x" })).rejects.toThrow(/3 attempts/);
    expect(calls).toBe(3);
  });
});

/**
 * FIX (2026-07-24): stream:true. With stream:false ollama emits NO bytes — not even
 * headers — until generation finishes, and undici hard-caps time-to-headers at 300s;
 * at ~16 tok/s any prompt past ~4-5k tokens can't answer in time, the death is
 * misclassified as a transient reject, and the retry loop re-pays ~300s twice (~15 min
 * of futile compute). Streaming makes ollama flush headers immediately, so the
 * per-attempt AbortSignal.timeout — now wrapping the whole fetch+read — is the only
 * budget. complete() accumulates the newline-delimited content fragments and captures
 * prompt_eval_count / eval_count from the final done chunk.
 */
describe("OllamaClient — stream:true accumulation", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const client = () => new OllamaClient("m", undefined, [0, 0]);

  it("sends stream:true; fragments accumulate, done ends, usage captured", async () => {
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        body: streamOf([
          JSON.stringify({ message: { content: '{"cla' }, done: false }) + "\n",
          JSON.stringify({ message: { content: 'ims"' }, done: false }) + "\n",
          JSON.stringify({ message: { content: ":[]}" }, done: false }) + "\n",
          JSON.stringify({ done: true, message: { content: "" }, prompt_eval_count: 123, eval_count: 45 }) + "\n",
        ]),
      };
    }) as unknown as typeof fetch;

    const c = client();
    const out = await c.complete({ prompt: "x" });
    expect(out).toBe('{"claims":[]}');
    expect(capturedBody.stream).toBe(true);
    expect(c.lastUsage).toEqual({ promptEvalCount: 123, evalCount: 45 });
  });

  it("a JSON line split across two chunk boundaries still parses", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      // The final done object is torn in half across the two chunks mid-JSON.
      body: streamOf([
        JSON.stringify({ message: { content: "hello" }, done: false }) + '\n{"do',
        'ne":true,"message":{"content":""},"prompt_eval_count":7,"eval_count":9}\n',
      ]),
    })) as unknown as typeof fetch;

    const c = client();
    const out = await c.complete({ prompt: "x" });
    expect(out).toBe("hello");
    expect(c.lastUsage).toEqual({ promptEvalCount: 7, evalCount: 9 });
  });

  it("abort mid-stream → throws the abort, is NOT retried", async () => {
    let calls = 0;
    // Emit one fragment, then hang forever — only the timeout can end it.
    const hanging = (): ReadableStream<Uint8Array> => {
      let sent = false;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) return new Promise<void>(() => {});
          sent = true;
          controller.enqueue(enc.encode(JSON.stringify({ message: { content: "partial" }, done: false }) + "\n"));
        },
      });
    };
    globalThis.fetch = (async () => {
      calls++;
      return { ok: true, status: 200, body: hanging() };
    }) as unknown as typeof fetch;

    const err = await client()
      .complete({ prompt: "x", timeoutMs: 30 })
      .catch((e) => e);
    expect(err.name).toBe("TimeoutError");
    expect(calls).toBe(1);
  });

  it("stream ends without done:true → non-retryable error, NOT retried", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        body: streamOf([JSON.stringify({ message: { content: "partial" }, done: false }) + "\n"]),
      };
    }) as unknown as typeof fetch;

    await expect(client().complete({ prompt: "x" })).rejects.toThrow(/done/i);
    expect(calls).toBe(1);
  });

  it("an unparseable stream line → non-retryable error, NOT retried", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: true, status: 200, body: streamOf(["this is not json\n"]) };
    }) as unknown as typeof fetch;

    await expect(client().complete({ prompt: "x" })).rejects.toThrow(/not valid JSON/i);
    expect(calls).toBe(1);
  });

  it("network reject once, then a streaming success → retried, result accumulated", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      return chatStream('{"ok":1}');
    }) as unknown as typeof fetch;

    const out = await client().complete({ prompt: "x" });
    expect(out).toBe('{"ok":1}');
    expect(calls).toBe(2);
  });
});
