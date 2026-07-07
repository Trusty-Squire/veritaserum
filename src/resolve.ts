/**
 * Shared resolution of the Knight (authoring) and the cross-vendor Judge (verify),
 * from local subscriptions. Used by both the CLI (hook path) and the MCP server.
 * Never auto-runs the metered OpenRouter path.
 */
import { detectVendors, makeClient, selectJudgeVendor, type Vendor } from "./llm.js";
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
