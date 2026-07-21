/**
 * Hermetic-suite setup. The audit path (src/auditor.ts) runs the no-LLM
 * grounding tier (src/grounding.ts) on every audit, whose only I/O is a local
 * ollama embedding call. The unit suite must be network-free and deterministic,
 * so point OLLAMA_HOST at a closed loopback port: the embedder throws on connect
 * and grounding fails OPEN to zero flags (R8) — instantly, whether or not the
 * dev machine happens to be running ollama.
 *
 * Real grounding behaviour is covered deterministically by test/grounding.test.ts
 * (an injected fake Embedder) and against a live ollama by the separate eval cell
 * (`pnpm tsx eval/confab/grounding/run.ts`), neither of which reads this env.
 */
process.env.OLLAMA_HOST = "http://127.0.0.1:1";
