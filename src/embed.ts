/**
 * A minimal local-embedding client — the ONLY model call the grounding
 * detector (src/grounding.ts) is allowed to make. No generative LLM: this
 * hits a local ollama embeddings endpoint (nomic-embed-text) and returns raw
 * vectors, plus a cosine helper. Kept deliberately tiny.
 *
 * Batching is the whole point of `embed(texts[])`: the detector embeds seed
 * phrases, sentences, and receipt lines together in one request, so one HTTP
 * round-trip covers a whole audit. On any HTTP/transport error the client
 * THROWS — the caller (groundingCheck) fail-opens (R8), turning a dead ollama
 * into an empty, non-blocking result rather than a crash.
 */

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

interface OllamaEmbedResponse {
  embeddings?: number[][];
}

/** Retry backoff (ms per retry). VS_OLLAMA_RETRY_BACKOFF_MS (comma-separated) overrides
 *  it so the hermetic suite can force instant retries; unset → prod [2s, 8s]. Kept inline
 *  (not imported from llm.ts) so this grounding-only module stays dependency-free. */
function embedRetryBackoffMs(): number[] {
  const raw = process.env.VS_OLLAMA_RETRY_BACKOFF_MS;
  if (raw === undefined) return [2_000, 8_000];
  return raw.split(",").map((s) => s.trim()).filter((s) => s !== "").map(Number);
}

/**
 * ollama /api/embed client. Batches all `texts` into one request. Memoizes by
 * exact text in an in-memory Map (seed centroids and repeated receipt lines are
 * embedded once per process), so a re-embed of the same string is free. Throws
 * on any non-OK HTTP status or a malformed body — the caller fail-opens.
 */
export function ollamaEmbedder(
  model = "nomic-embed-text",
  baseUrl = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
  // Backoff before each retry (ms). One entry per retry → default = 2 retries
  // (3 attempts). Injected by tests, or overridden process-wide via
  // VS_OLLAMA_RETRY_BACKOFF_MS so the hermetic suite (closed loopback port,
  // test/setup.ts) fails instantly instead of sleeping ~10s per audit.
  retryBackoffMs: number[] = embedRetryBackoffMs(),
): Embedder {
  const cache = new Map<string, number[]>();
  const endpoint = `${baseUrl.replace(/\/$/, "")}/api/embed`;

  return {
    async embed(texts: string[]): Promise<number[][]> {
      const missing = texts.filter((t) => !cache.has(t));
      // Dedupe unseen inputs so a batch with repeats costs one vector each.
      const uniqueMissing = [...new Set(missing)];
      if (uniqueMissing.length > 0) {
        // Retry transient ollama failures — same rationale as OllamaClient.complete
        // (src/llm.ts): prod telemetry 2026-07-21 saw ~32% of audits die on "fetch
        // failed", TCP rejections when concurrent audits + embeds overwhelm ollama's
        // request queue. A lost embed silently drops the grounding tier for the turn
        // (groundingCheck fail-opens on error), so retry the transient classes: a
        // network-level fetch reject (non-abort) and HTTP 5xx (503 queue-full). NEVER
        // retry an abort (the 30s per-attempt timeout already fired) or an HTTP 4xx (a
        // real request problem). The per-attempt timeout is NEW here: embeds are
        // sub-second, so 30s only bounds a hung connection that would otherwise stall
        // the grounding tier indefinitely.
        for (let attempt = 0; ; attempt++) {
          const isLast = attempt >= retryBackoffMs.length;
          let res: Awaited<ReturnType<typeof fetch>>;
          try {
            res = await fetch(endpoint, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ model, input: uniqueMissing }),
              signal: AbortSignal.timeout(30_000),
            });
          } catch (err) {
            // AbortSignal.timeout rejects with "TimeoutError"; manual abort "AbortError".
            if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
            if (isLast)
              throw new Error(
                `ollama embed fetch failed (${attempt + 1} attempts): ${err instanceof Error ? err.message : String(err)}`,
              );
            await new Promise((r) => setTimeout(r, retryBackoffMs[attempt]));
            continue;
          }
          if (!res.ok) {
            if (res.status >= 500 && !isLast) {
              await new Promise((r) => setTimeout(r, retryBackoffMs[attempt]));
              continue;
            }
            throw new Error(`ollama embed HTTP ${res.status} ${res.statusText} (${attempt + 1} attempts)`);
          }
          const body = (await res.json()) as OllamaEmbedResponse;
          const vecs = body.embeddings;
          if (!Array.isArray(vecs) || vecs.length !== uniqueMissing.length) {
            throw new Error(
              `ollama embed returned ${Array.isArray(vecs) ? vecs.length : "no"} vectors for ${uniqueMissing.length} inputs`,
            );
          }
          uniqueMissing.forEach((t, i) => cache.set(t, vecs[i] as number[]));
          break;
        }
      }
      return texts.map((t) => cache.get(t) as number[]);
    },
  };
}

/** Cosine similarity of two equal-length vectors; 0 for a zero vector. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
