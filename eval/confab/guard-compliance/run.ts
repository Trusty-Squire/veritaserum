/**
 * run.ts — guard-compliance eval.
 *
 * The owner's question: with prompt VISIBILITY fixed (src/llm.ts now sends
 * options.num_ctx so ollama no longer truncates the FRONT of a long audit prompt,
 * where RULES_BLOCK lives), is qwen2.5:14b's CAPABILITY sufficient to actually
 * FOLLOW the production audit guards?
 *
 * This runs the REAL production prompt builder (src/auditor.ts buildPreGatheredPrompt,
 * exported for this eval) over 10 hand-labeled scenarios through the REAL OllamaClient
 * (src/llm.ts, num_ctx-fixed), parses each verdict with the REAL parseReply, and scores
 * PASS/FAIL vs the expectation. Each scenario runs TWICE — temperature is now pinned to
 * 0, so the two runs SHOULD agree; a disagreement is a reported finding.
 *
 *   pnpm tsx eval/confab/guard-compliance/run.ts [--model qwen2.5:14b] [--runs 2]
 *
 * Requires live ollama at OLLAMA_BASE_URL (default http://127.0.0.1:11434) with the
 * model pulled. The box is CPU-only; each 14b judgment can take minutes.
 *
 * NOTE ON PADDING vs undici: `padKB` pads receipts with realistic tool noise so the
 * prompt is pushed well past ollama's old 4096-token default — a correct verdict then
 * proves the front-loaded rules survived. But Node's fetch (undici) caps time-to-headers
 * at 300s, and with ollama's stream:false the headers arrive only when generation is
 * DONE. On a heavily-loaded CPU box a big prompt's eval can exceed 300s, surfacing as an
 * opaque "fetch failed". We set a per-audit AbortSignal just under that so a too-slow
 * audit is recorded as a clean `timeout` rather than an undici error. VS_GC_PAD_SCALE
 * (default 1) scales every padKB so the operator can shrink prompts to fit the box.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildPreGatheredPrompt, parseReply, demoteUserTestimony, demoteSubagentReport, demoteVerifiedClaims, type AuditJob, type VerifiedClaim } from "../../../src/auditor.js";
import { OllamaClient } from "../../../src/llm.js";
import { resolveAuditor } from "../../../src/resolve.js";
import { ollamaEmbedder } from "../../../src/embed.js";

const HERE = dirname(fileURLToPath(import.meta.url));

type Expect = "flag" | "contradicted" | "clean" | "unaccountable";

interface Scenario {
  id: string;
  guard: string;
  expect: Expect;
  userRequest: string;
  finalMessage: string;
  receipts: string;
  padKB?: number;
  /** MECHANISM 1: the recent prose exchange, for judging reliance. */
  conversationTail?: string;
  /** FIX 2 (minimal single-turn support): pre-seed the per-session verified-claims
   *  store so a scenario can exercise the "verified earlier this session" demotion
   *  in the single-turn eval shape (the real store is populated across turns; here
   *  the earlier turn's verified claim is supplied directly). */
  seedVerifiedClaims?: VerifiedClaim[];
}

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
}

const MODEL = arg("model", "qwen2.5:14b");
const RUNS = Number(arg("runs", "2"));

// A bare model name (e.g. "qwen2.5:14b") is an ollama tag, not a vendor spec — the ":"
// there separates family from size, not vendor from model. Only these four prefixes are
// recognized vendor specs (src/resolve.ts parseAuditorSpec's AUDITOR_VENDORS); anything
// else keeps the original hardwired OllamaClient path (back-compat with the recorded
// 14B baseline invocation).
const VENDOR_PREFIXES = ["codex:", "claude:", "ollama:", "openrouter:"];
const isVendorSpec = VENDOR_PREFIXES.some((p) => MODEL.startsWith(p));

/** Filesystem-safe stand-in for a model spec, e.g. "codex:gpt-5.6-luna" → "codex-gpt-5.6-luna". */
function sanitizeModel(m: string): string {
  return m.replace(/[:/]/g, "-");
}
const PAD_SCALE = Number(process.env.VS_GC_PAD_SCALE ?? "1");
// 280s: just under undici's 300s time-to-headers cap, so a too-slow audit aborts
// cleanly (TimeoutError) instead of throwing an opaque "fetch failed".
const PER_AUDIT_TIMEOUT_MS = Number(process.env.VS_GC_TIMEOUT_MS ?? "295000");

/** Pad receipts to ~padKB with realistic, varied tool noise, keeping the load-bearing
 *  core embedded in the MIDDLE (not only at the tail) so the evidence isn't trivially
 *  at the prompt boundary. */
function padReceipts(core: string, padKB: number): string {
  if (!padKB) return core;
  const targetBytes = padKB * 1024;
  const noise: string[] = [];
  let bytes = 0;
  let i = 0;
  const templates = (n: number): string => {
    switch (n % 6) {
      case 0: return `[eslint] src/mod/file${n}.ts:${n % 200}:${n % 80}  warning  '${["tmp", "res", "ctx", "acc"][n % 4]}' is assigned a value but never used  @typescript-eslint/no-unused-vars`;
      case 1: return `npm warn deprecated sub-dep-${n}@1.${n % 20}.0: use the maintained fork instead`;
      case 2: return ` ✓ test/suite${n % 40}.test.ts > case ${n % 12} keeps invariant (${(n % 90) + 5}ms)`;
      case 3: return `$ git show --stat HEAD~${n % 9} | head -1\ncommit ${(n * 2654435761 >>> 0).toString(16).padStart(8, "0")} chore(area${n % 7}): housekeeping ${n}`;
      case 4: return `2026-07-24T${String(n % 24).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}:12Z DEBUG worker[${n % 8}] flushed ${1000 + n} rows to sink table_${n % 30}`;
      default: return `  at Object.<anonymous> (/repo/node_modules/pkg${n % 50}/dist/index.js:${n % 400}:${n % 60})`;
    }
  };
  // ~40% of noise before the core, the rest after — core lands mid-stream.
  const half = Math.floor(targetBytes * 0.4);
  const before: string[] = [];
  while (bytes < half) { const l = templates(i++); before.push(l); bytes += l.length + 1; }
  while (bytes < targetBytes) { const l = templates(i++); noise.push(l); bytes += l.length + 1; }
  return [
    "$ pnpm build && pnpm lint && pnpm test   # full CI tail (truncated)",
    ...before,
    "",
    core,
    "",
    ...noise,
  ].join("\n");
}

interface RunResult {
  raw: string;
  parsed: ReturnType<typeof parseReply>;
  ms: number;
  error?: string;
  promptChars: number;
}

/** Invoke the model under test on one prompt. Vendor specs (codex:/claude:/ollama:/
 *  openrouter:) go through the production Auditor abstraction (src/resolve.ts); bare
 *  ollama tags keep calling OllamaClient.complete directly, unchanged. */
type Invoke = (prompt: string, timeoutMs: number) => Promise<string>;

// Mirror production audit(): the post-parse USER-TESTIMONY DEMOTION runs on the
// parsed verdict (src/auditor.ts demoteUserTestimony), so the eval measures the
// SAME verdict production would deliver — a testimony-shaped flag grounded in the
// user's own tail statement is demoted to supported. Needs a live embedder, which
// this eval already requires ollama for.
const EMBEDDER = ollamaEmbedder();

async function runOnce(sc: Scenario, invoke: Invoke): Promise<RunResult> {
  const receipts = padReceipts(sc.receipts, Math.round((sc.padKB ?? 0) * PAD_SCALE));
  const job: AuditJob = {
    dir: HERE,
    sessionId: sc.id,
    userRequest: sc.userRequest,
    finalMessage: sc.finalMessage,
    receipts,
    ...(sc.conversationTail ? { conversationTail: sc.conversationTail } : {}),
  };
  // Evidence pre-gathered = the receipts tail (production also folds git state in;
  // here the receipts ARE the ground truth each scenario turns on).
  const evidence = receipts || "(no receipts recorded for this turn)";
  const prompt = buildPreGatheredPrompt(job, evidence);
  const t = Date.now();
  try {
    const raw = await invoke(prompt, PER_AUDIT_TIMEOUT_MS);
    const parsed = parseReply(raw);
    // Mirror production audit()'s demotion chain so the eval measures the SAME
    // verdict: user testimony (FIX pre-existing), subagent report (FIX 1), and
    // session verified-claims (FIX 2, pre-seeded per scenario for the single-turn shape).
    let claims = parsed ? await demoteUserTestimony(parsed.claims, sc.conversationTail, EMBEDDER) : [];
    if (parsed) claims = await demoteSubagentReport(claims, receipts, EMBEDDER);
    if (parsed) claims = await demoteVerifiedClaims(claims, sc.seedVerifiedClaims, EMBEDDER);
    const demoted = parsed ? { ...parsed, claims } : null;
    return { raw, parsed: demoted, ms: Date.now() - t, promptChars: prompt.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isTimeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError" || /\(exit timeout\)/.test(e.message));
    return { raw: "", parsed: null, ms: Date.now() - t, error: isTimeout ? `timeout>${PER_AUDIT_TIMEOUT_MS}ms` : msg, promptChars: prompt.length };
  }
}

/** Does a parsed verdict satisfy the scenario's expectation? */
function score(expect: Expect, p: NonNullable<ReturnType<typeof parseReply>>): boolean {
  const flagged = p.claims.filter((c) => c.verdict === "unsupported" || c.verdict === "contradicted");
  const contradicted = p.claims.some((c) => c.verdict === "contradicted");
  switch (expect) {
    case "flag": return flagged.length > 0;
    case "contradicted": return contradicted;
    case "clean": return flagged.length === 0 && !p.unaccountable;
    case "unaccountable": return p.unaccountable;
  }
}

/** Short human-readable tag of what the verdict actually said. */
function verdictTag(p: ReturnType<typeof parseReply>): string {
  if (!p) return "PARSE-FAIL";
  const v = p.claims.map((c) => c.verdict[0].toUpperCase()).join("");
  return `claims=[${v || "-"}]${p.unaccountable ? " UNACCOUNTABLE" : ""}`;
}

async function main(): Promise<void> {
  const ds = JSON.parse(readFileSync(join(HERE, "dataset.json"), "utf8")) as { scenarios: Scenario[] };

  let invoke: Invoke;
  if (isVendorSpec) {
    // Same resolution path production uses for VS_AUDITOR overrides: the vendor spec
    // is taken literally, no auth-probing or fallback rules (those only apply when no
    // override is given). `executor` is irrelevant on the override path.
    const auditor = await resolveAuditor("eval-harness", MODEL);
    console.log(`auditor: vendor=${auditor.vendor} model=${auditor.model ?? "(default)"} tier=${auditor.tier}`);
    invoke = (prompt, timeoutMs) => auditor.invoke(prompt, HERE, timeoutMs);
  } else {
    const client = new OllamaClient(MODEL);
    invoke = (prompt, timeoutMs) => client.complete({ prompt, timeoutMs });
  }

  console.log(`guard-compliance: ${ds.scenarios.length} scenarios × ${RUNS} runs, model=${MODEL}, pad_scale=${PAD_SCALE}`);
  console.log(`per-audit timeout=${PER_AUDIT_TIMEOUT_MS}ms (undici headers cap is ~300s)\n`);

  const rows: Array<Record<string, unknown>> = [];
  let passBoth = 0;
  let disagree = 0;

  for (const sc of ds.scenarios) {
    const results: RunResult[] = [];
    for (let r = 0; r < RUNS; r++) results.push(await runOnce(sc, invoke));

    const passes = results.map((res) => (res.parsed ? score(sc.expect, res.parsed) : false));
    const runPass = passes.every(Boolean);
    const tags = results.map((res) => verdictTag(res.parsed));
    const determinismSplit = new Set(passes.map(String)).size > 1 || new Set(tags).size > 1;
    if (runPass) passBoth++;
    if (determinismSplit) disagree++;

    const avgMs = Math.round(results.reduce((a, b) => a + b.ms, 0) / results.length);
    console.log(
      `${runPass ? "PASS" : "FAIL"}  ${sc.id.padEnd(24)} expect=${sc.expect.padEnd(13)} ` +
        `${tags.join(" | ")}  ${determinismSplit ? "⚠disagree" : ""}  (${avgMs}ms, ${results[0]!.promptChars}c)`,
    );
    for (const res of results) if (res.error) console.log(`      err: ${res.error}`);

    rows.push({
      id: sc.id, guard: sc.guard, expect: sc.expect, pass: runPass, determinismSplit,
      runs: results.map((res, i) => ({
        pass: passes[i], tag: tags[i], ms: res.ms, error: res.error ?? null,
        note: res.parsed?.note ?? null,
        claims: res.parsed?.claims ?? null, unaccountable: res.parsed?.unaccountable ?? null,
        raw: res.raw.slice(0, 2000),
      })),
    });
  }

  const rate = ((passBoth / ds.scenarios.length) * 100).toFixed(0);
  console.log(`\noverall guard-compliance: ${passBoth}/${ds.scenarios.length} (${rate}%) pass on BOTH runs`);
  console.log(`determinism: ${disagree}/${ds.scenarios.length} scenarios disagreed across the two runs`);

  // Per-model output file: results.json is the committed qwen2.5:14b baseline and is
  // never overwritten (see README — per-model files are the convention now).
  const outPath = join(HERE, `results-${sanitizeModel(MODEL)}.json`);
  writeFileSync(
    outPath,
    JSON.stringify({ model: MODEL, runs: RUNS, pad_scale: PAD_SCALE, passBoth, total: ds.scenarios.length, disagree, rows }, null, 2) + "\n",
  );
  console.log(`\nwrote ${outPath}`);
}

main().catch((e) => {
  console.error("run failed:", e);
  process.exit(1);
});
