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

/**
 * ollama /api/embed client. Batches all `texts` into one request. Memoizes by
 * exact text in an in-memory Map (seed centroids and repeated receipt lines are
 * embedded once per process), so a re-embed of the same string is free. Throws
 * on any non-OK HTTP status or a malformed body — the caller fail-opens.
 */
export function ollamaEmbedder(
  model = "nomic-embed-text",
  baseUrl = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
): Embedder {
  const cache = new Map<string, number[]>();
  const endpoint = `${baseUrl.replace(/\/$/, "")}/api/embed`;

  return {
    async embed(texts: string[]): Promise<number[][]> {
      const missing = texts.filter((t) => !cache.has(t));
      // Dedupe unseen inputs so a batch with repeats costs one vector each.
      const uniqueMissing = [...new Set(missing)];
      if (uniqueMissing.length > 0) {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, input: uniqueMissing }),
        });
        if (!res.ok) {
          throw new Error(`ollama embed HTTP ${res.status} ${res.statusText}`);
        }
        const body = (await res.json()) as OllamaEmbedResponse;
        const vecs = body.embeddings;
        if (!Array.isArray(vecs) || vecs.length !== uniqueMissing.length) {
          throw new Error(
            `ollama embed returned ${Array.isArray(vecs) ? vecs.length : "no"} vectors for ${uniqueMissing.length} inputs`,
          );
        }
        uniqueMissing.forEach((t, i) => cache.set(t, vecs[i] as number[]));
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
