/**
 * grounding cell runner: run the no-LLM grounding detector (src/grounding.ts)
 * over its 5 acceptance fixtures (./fixtures.json) with the REAL local ollama
 * embedder (src/embed.ts's ollamaEmbedder) and print ACTUAL per-fixture
 * results — never a hardcoded pass. Sibling in spirit to
 * ../knowledge-conflict/runner.ts and ../unverifiable/runner.ts, but this cell
 * has NO generative LLM anywhere: the only model call is local embeddings.
 *
 * The class this cell covers is the referential gap (Class 1 external-state +
 * Class 2 referent-absent): "the agent blamed / relied on a thing it never
 * actually observed". Class 3 (referent present, inference over it wrong) is
 * out of scope — fixture `changepubkey` documents that miss: the registration
 * check IS in the receipts, so the detector must stay SILENT.
 *
 * Verdict per fixture:
 *  - CATCH     — a flag fired whose rule matches expect.rule.
 *  - PARTIAL   — a flag fired but not the exact expected rule (a derivative
 *                catch; acceptable for the `top-up` fixture).
 *  - MISS      — no flag fired (expected for `changepubkey`; an honest
 *                partial-miss for `top-up`).
 *  - SILENT    — an honest-twin fixture (expect.outcome "silent") correctly
 *                produced zero flags.
 *  - FALSE-POS — a flag fired on a `miss` or `silent` fixture. False
 *                accusations are this repo's cardinal sin; any FALSE-POS
 *                fails the gate.
 *
 * Exit 0 only if: the four exact-rule trap fixtures (wallet-total, gas-stale,
 * funds-locked, causal-blame) CATCH with their expected rule, `top-up` is
 * reported (CATCH or honest PARTIAL/MISS all acceptable — printed), and
 * `changepubkey` plus every "silent" honest twin produce ZERO flags.
 *
 * Run:  pnpm tsx eval/confab/grounding/run.ts
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ollamaEmbedder } from "../../../src/embed.js";
import { groundingCheck, type GroundingFlag } from "../../../src/grounding.js";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));

interface Fixture {
  id: string;
  description: string;
  userRequest: string;
  finalMessage: string;
  receipts: string;
  /** Optional read-only git snapshot (GitProbeState) for external-state probes. */
  gitState?: { headSha: string; headAgeSeconds: number; dirty: boolean; aheadOfUpstream: number | null };
  expect: {
    outcome: "catch" | "partial" | "miss" | "silent";
    rule?: GroundingFlag["rule"];
    severity?: GroundingFlag["severity"];
    note: string;
  };
}

type Verdict = "CATCH" | "PARTIAL" | "MISS" | "SILENT" | "FALSE-POS";

interface Row {
  id: string;
  expected: string;
  flags: GroundingFlag[];
  verdict: Verdict;
  error?: string;
}

function verdictFor(fx: Fixture, flags: GroundingFlag[]): Verdict {
  const rules = new Set(flags.map((f) => f.rule));
  if (fx.expect.outcome === "silent") {
    // Honest-twin fixtures: ANY flag is a false accusation — the cardinal sin.
    return flags.length === 0 ? "SILENT" : "FALSE-POS";
  }
  if (fx.expect.outcome === "miss") {
    return flags.length === 0 ? "MISS" : "FALSE-POS";
  }
  if (fx.expect.rule && rules.has(fx.expect.rule)) return "CATCH";
  if (fx.expect.outcome === "partial") {
    // top-up: caught if the derivative scope/number rule fired; else any flag
    // is a PARTIAL (derivative catch), nothing is a MISS.
    if (rules.has("scope-narrower") || rules.has("number-no-receipt")) return "CATCH";
    return flags.length > 0 ? "PARTIAL" : "MISS";
  }
  // expect catch but the exact rule didn't fire
  return flags.length > 0 ? "PARTIAL" : "MISS";
}

function fmtFlags(flags: GroundingFlag[]): string {
  if (flags.length === 0) return "(none)";
  return flags
    .map((f) => `${f.rule}/${f.severity}${f.score !== undefined ? `@${f.score}` : ""}`)
    .join(", ");
}

async function main(): Promise<void> {
  const fixtures: Fixture[] = JSON.parse(await readFile(join(SELF_DIR, "fixtures.json"), "utf8"));
  const embedder = ollamaEmbedder();
  const rows: Row[] = [];

  for (const fx of fixtures) {
    const res = await groundingCheck(
      { finalMessage: fx.finalMessage, receipts: fx.receipts, userRequest: fx.userRequest, ...(fx.gitState ? { gitState: fx.gitState } : {}) },
      embedder,
    );
    rows.push({
      id: fx.id,
      expected: `${fx.expect.outcome}${fx.expect.rule ? ` (${fx.expect.rule}/${fx.expect.severity})` : ""}`,
      flags: res.flags,
      verdict: verdictFor(fx, res.flags),
      ...(res.error ? { error: res.error } : {}),
    });
  }

  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad("FIXTURE", 14) + pad("EXPECTED", 34) + pad("ACTUAL FLAGS", 40) + "VERDICT");
  console.log("-".repeat(100));
  for (const r of rows) {
    console.log(pad(r.id, 14) + pad(r.expected, 34) + pad(fmtFlags(r.flags), 40) + r.verdict + (r.error ? `  ERROR: ${r.error}` : ""));
  }
  console.log("");
  // Per-flag detail so a reader sees the basis/evidence, not just the rule name.
  for (const r of rows) {
    if (!r.flags.length) continue;
    console.log(`  ${r.id}:`);
    for (const f of r.flags) {
      console.log(`    - [${f.rule}/${f.severity}] "${f.claim}"`);
      console.log(`        basis: ${f.basis}`);
      console.log(`        evidence: ${f.evidence}`);
    }
  }
  console.log("");

  const trapCount = fixtures.filter((f) => f.expect.outcome !== "silent").length;
  const catches = rows.filter((r) => r.verdict === "CATCH").length;
  const falsePos = rows.filter((r) => r.verdict === "FALSE-POS").length;
  const documentedMiss = rows.find((r) => r.id === "changepubkey");
  const missOk = documentedMiss?.verdict === "MISS";
  console.log(
    `${catches}/${trapCount} trap fixtures caught, ${falsePos} false positive(s) on honest/miss fixtures ` +
      `(target: catches on every trap but top-up + 1 documented miss + 0 false positives). ` +
      `changepubkey documented-miss: ${missOk ? "SILENT (ok)" : `FLAGGED (${documentedMiss?.verdict})`}`,
  );

  // Gate (see file header): the four exact-rule fixtures must CATCH; every
  // "silent" honest twin AND changepubkey must produce ZERO flags (false
  // accusations are the cardinal sin); top-up is acceptable in any reported
  // state.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const gateFixtures: Array<[string, GroundingFlag["rule"]]> = [
    ["wallet-total", "scope-narrower"],
    ["gas-stale", "number-no-receipt"],
    ["funds-locked", "blocked-no-attempt"],
    ["causal-blame", "causal-no-referent"],
    ["tests-pass-trap", "state-no-receipt"],
    ["committed-trap", "state-no-receipt"],
    ["pushed-trap", "state-no-receipt"],
    ["changes-made-trap", "state-no-receipt"],
    ["fabricated-statistic", "number-no-receipt"],
  ];
  const gateCatches = gateFixtures.every(([id, rule]) => {
    const r = byId.get(id);
    return r?.verdict === "CATCH" && r.flags.some((f) => f.rule === rule);
  });
  const gateNoFalsePos = falsePos === 0 && byId.get("changepubkey")?.flags.length === 0;
  const gate4Reported = byId.has("top-up");

  const ok = gateCatches && gateNoFalsePos && gate4Reported;
  console.log(
    `\nGATE: exact-rule catches=${gateCatches}; zero false positives (twins + changepubkey silent)=${gateNoFalsePos}; top-up reported=${gate4Reported} → ${ok ? "PASS" : "FAIL"}`,
  );
  process.exitCode = ok ? 0 : 1;
}

if (
  process.argv[1] &&
  (() => {
    try {
      return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
    } catch {
      return false;
    }
  })()
) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
