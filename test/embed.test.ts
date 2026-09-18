/**
 * FIX (2026-07-22): the grounding tier's only I/O is a local ollama embed call, and it
 * shares the server (and the transient "fetch failed" failure mode) with the auditor.
 * A lost embed silently drops the grounding tier for the turn (groundingCheck fail-opens).
 * ollamaEmbedder now retries the transient classes (network-level fetch reject, HTTP 5xx)
 * but NOT aborts or 4xx — mirroring OllamaClient.complete. Backoff is injected as [0,0].
 */
import { describe, it, expect, afterEach } from "vitest";
import { ollamaEmbedder } from "../src/embed.js";

describe("ollamaEmbedder — retries only transient failures", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const ok = (vecs: number[][]) => ({ ok: true, status: 200, json: async () => ({ embeddings: vecs }) });
  const httpErr = (status: number) => ({ ok: false, status, statusText: "x", text: async () => "err" });
  const embedder = () => ollamaEmbedder("nomic-embed-text", "http://x", [0, 0]);

  it("network failure once, then succeeds → returns vectors, exactly 2 fetch calls", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      return ok([[1, 2, 3]]);
    }) as unknown as typeof fetch;

    const out = await embedder().embed(["hello"]);
    expect(out).toEqual([[1, 2, 3]]);
    expect(calls).toBe(2);
  });

  it("HTTP 503 once, then succeeds → retried (2 fetch calls)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1 ? httpErr(503) : ok([[9]]);
    }) as unknown as typeof fetch;

    const out = await embedder().embed(["hi"]);
    expect(out).toEqual([[9]]);
    expect(calls).toBe(2);
  });

  it("HTTP 400 → NOT retried (1 call, throws)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return httpErr(400);
    }) as unknown as typeof fetch;

    await expect(embedder().embed(["hi"])).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });

  it("abort/timeout → NOT retried (1 call, throws)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      const e = new Error("aborted");
      e.name = "TimeoutError";
      throw e;
    }) as unknown as typeof fetch;

    await expect(embedder().embed(["hi"])).rejects.toThrow(/aborted/);
    expect(calls).toBe(1);
  });
});
