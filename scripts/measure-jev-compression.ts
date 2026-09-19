#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { execa } from "execa";
import { buildCompressedJevInput, buildJevInputVariants, type JevInputMaterial, type JevInputVariants } from "../src/jev-evidence.js";
import { buildJevState, invokeJevWithMeta, type JevCallMeta, type JevPromptOptimizations, type JevTurnState } from "../src/jev.js";
import { typesafeApiKey } from "../src/llm.js";
import { fixtureRepo, type RepoSetup } from "../eval/fixtures/types.js";

type Domain = "backend" | "frontend";
type Expectation = "flag" | "clean";
type Diet = keyof JevInputVariants;
type Phase = "baseline" | "singles" | "composites";

interface ArmDefinition {
  id: string;
  label: string;
  options: JevPromptOptimizations;
}

interface CompressionFixture {
  id: string;
  domain: Domain;
  shape: string;
  expect: Expectation;
  userRequest: string;
  finalMessage: string;
  receipts: string;
  repoSetup?: RepoSetup;
}

interface RunResult {
  repetition: number;
  prediction?: Expectation;
  error?: string;
  skipped?: boolean;
  attempts: number;
  meta?: JevCallMeta;
}

interface CellRow {
  fixtureId: string;
  arm: string;
  diet: Diet;
  chars: number;
  runs: RunResult[];
}

interface StudyData {
  schemaVersion: 2;
  phase: Phase;
  generatedAt: string;
  gitCommit: string;
  corpusSize: number;
  originalCorpusSize: number;
  repetitions: number;
  requestedConcurrency: number;
  rows: CellRow[];
}

const DIETS: Diet[] = ["full", "filtered", "compressed"];
const SINGLE_ARMS: ArmDefinition[] = [
  { id: "A1", label: "negative anchor", options: { negativeAnchor: true } },
  { id: "A2", label: "typed claim reasons", options: { typedClaimReasons: true } },
  { id: "A3", label: "paired evidence", options: { pairedEvidence: true } },
  { id: "A4", label: "per-claim questions", options: { perClaimQuestions: true } },
  { id: "A5", label: "combined confabulation mass", options: { combinedConfabulationMass: true } },
];
const ORIGINAL_CORPUS_SIZE = 24;
const fixturePath = join(process.cwd(), "eval", "jev-compression", "fixtures.json");
const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as CompressionFixture[];
const live = Boolean(typesafeApiKey()) && !process.argv.includes("--sizes-only");
const requireLive = process.argv.includes("--require-live");
const phaseArg = process.argv.find((arg) => arg.startsWith("--phase="))?.slice("--phase=".length) ?? "baseline";
if (phaseArg !== "baseline" && phaseArg !== "singles" && phaseArg !== "composites") {
  throw new Error("--phase must be baseline, singles, or composites");
}
const phase: Phase = phaseArg;
const survivors = (process.argv.find((arg) => arg.startsWith("--survivors="))?.slice("--survivors=".length) ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const repeatArg = process.argv.find((arg) => arg.startsWith("--repeat="));
const repeat = Math.max(1, Number.parseInt(repeatArg?.split("=")[1] ?? "5", 10) || 5);
const concurrencyArg = process.argv.find((arg) => arg.startsWith("--concurrency="));
const concurrency = Math.max(1, Number.parseInt(concurrencyArg?.split("=")[1] ?? "8", 10) || 8);
const outputArg = process.argv.find((arg) => arg.startsWith("--output="))?.slice("--output=".length);
const outputPath = outputArg
  ? (isAbsolute(outputArg) ? outputArg : join(process.cwd(), outputArg))
  : join(process.cwd(), "docs", phase === "baseline" ? "JEV-PROMPT-OPTIMIZATION-BASELINE.md" : `JEV-PROMPT-OPTIMIZATION-${phase.toUpperCase()}.md`);
const dataArg = process.argv.find((arg) => arg.startsWith("--data="))?.slice("--data=".length);
const dataPath = dataArg
  ? (isAbsolute(dataArg) ? dataArg : join(process.cwd(), dataArg))
  : join(process.cwd(), "eval", "jev-compression", "results", `${phase}.json`);
const report: string[] = [];

function emit(line = ""): void {
  report.push(line);
  console.log(line);
}

function padRequest(request: string, target = 9 * 1024): string {
  const lines = [request];
  for (let i = 0; lines.join("\n").length < target; i++) {
    lines.push(`Historical context ${i}: prior discussion concerned general rollout background and old meeting notes.`);
  }
  return lines.join("\n");
}

function padReceipts(receipts: string, target = 60 * 1024): string {
  const lines = receipts ? [receipts] : [];
  for (let i = 0; lines.join("\n").length < target; i++) {
    const id = String(i).padStart(4, "0");
    lines.push(`> Bash {"command":"printf fixture-noise-${id}"}`);
    lines.push(`< fixture-noise-${id} ${"irrelevant deterministic padding ".repeat(3)}`);
  }
  return lines.join("\n");
}

function inputChars(turn: JevTurnState): number {
  return JSON.stringify(buildJevState(turn)).length;
}

function classifyReply(reply: string): Expectation {
  const value = JSON.parse(reply) as { claims?: unknown[]; unaccountable?: boolean };
  return (value.claims?.length ?? 0) > 0 || value.unaccountable === true ? "flag" : "clean";
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function wilson(successes: number, total: number): [number, number] {
  if (total === 0) return [0, 0];
  const z = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const spread = (z / denominator) * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [Math.max(0, center - spread), Math.min(1, center + spread)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callJev(turn: JevTurnState, repetition: number): Promise<RunResult> {
  if (!live) return { repetition, attempts: 0 };
  if (!turn.finalMessage.trim()) return { repetition, prediction: "clean", skipped: true, attempts: 0 };
  let lastError = "unknown Jev error";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const invocation = await invokeJevWithMeta(JSON.stringify(turn), 30_000);
      return { repetition, prediction: classifyReply(invocation.reply), attempts: attempt, meta: invocation.meta };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < 3) await sleep(250 * 2 ** (attempt - 1));
    }
  }
  return { repetition, error: lastError, attempts: 3 };
}

function writeData(rows: CellRow[], gitCommit: string): void {
  const data: StudyData = {
    schemaVersion: 2,
    phase,
    generatedAt: new Date().toISOString(),
    gitCommit,
    corpusSize: fixtures.length,
    originalCorpusSize: ORIGINAL_CORPUS_SIZE,
    repetitions: repeat,
    requestedConcurrency: concurrency,
    rows,
  };
  mkdirSync(dirname(dataPath), { recursive: true });
  writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

interface Task {
  row: CellRow;
  turn: JevTurnState;
  repetition: number;
}

async function runTasks(tasks: Task[], rows: CellRow[], gitCommit: string): Promise<void> {
  let cursor = 0;
  let completed = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      const task = tasks[index];
      if (!task) return;
      task.row.runs.push(await callJev(task.turn, task.repetition));
      completed++;
      if (live && (completed % 25 === 0 || completed === tasks.length)) {
        writeData(rows, gitCommit);
        console.error(`progress ${completed}/${tasks.length}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

interface Score {
  correct: number;
  valid: number;
  errors: number;
  catches: number;
  misses: number;
  falseCatches: number;
  correctClean: number;
  repeatRates: number[];
}

function score(rows: CellRow[], fixtureSubset: CompressionFixture[]): Score {
  const expected = new Map(fixtureSubset.map((fixture) => [fixture.id, fixture.expect]));
  let correct = 0;
  let valid = 0;
  let errors = 0;
  let catches = 0;
  let misses = 0;
  let falseCatches = 0;
  let correctClean = 0;
  const byRepeat = Array.from({ length: repeat }, () => ({ correct: 0, valid: 0 }));
  for (const row of rows) {
    const truth = expected.get(row.fixtureId);
    if (!truth) continue;
    for (const run of row.runs) {
      if (!run.prediction || run.error) {
        errors++;
        continue;
      }
      valid++;
      const isCorrect = run.prediction === truth;
      if (isCorrect) correct++;
      const bucket = byRepeat[run.repetition];
      if (bucket) {
        bucket.valid++;
        if (isCorrect) bucket.correct++;
      }
      if (truth === "flag" && run.prediction === "flag") catches++;
      if (truth === "flag" && run.prediction === "clean") misses++;
      if (truth === "clean" && run.prediction === "flag") falseCatches++;
      if (truth === "clean" && run.prediction === "clean") correctClean++;
    }
  }
  return {
    correct,
    valid,
    errors,
    catches,
    misses,
    falseCatches,
    correctClean,
    repeatRates: byRepeat.filter((bucket) => bucket.valid > 0).map((bucket) => bucket.correct / bucket.valid),
  };
}

function usage(rows: CellRow[]): { calls: number; inputTokens: number; outputTokens: number; knownCost: number; unknownPriceCalls: number } {
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let knownCost = 0;
  let unknownPriceCalls = 0;
  for (const run of rows.flatMap((row) => row.runs)) {
    calls += run.attempts;
    if (!run.meta) continue;
    inputTokens += run.meta.inputTokens ?? 0;
    outputTokens += run.meta.outputTokens ?? 0;
    if (run.meta.costUsd === undefined) unknownPriceCalls++;
    else knownCost += run.meta.costUsd;
  }
  return { calls, inputTokens, outputTokens, knownCost, unknownPriceCalls };
}

function pairedBootstrapDelta(
  armRows: CellRow[],
  baselineRows: CellRow[],
  fixtureSubset: CompressionFixture[],
  iterations = 10_000,
): { delta: number; low: number; high: number } {
  const truth = new Map(fixtureSubset.map((fixture) => [fixture.id, fixture.expect]));
  const fixtureAccuracy = (candidateRows: CellRow[]): Map<string, number> => {
    const out = new Map<string, number>();
    for (const row of candidateRows) {
      const expected = truth.get(row.fixtureId);
      if (!expected) continue;
      const valid = row.runs.filter((run) => run.prediction && !run.error);
      if (valid.length) out.set(row.fixtureId, valid.filter((run) => run.prediction === expected).length / valid.length);
    }
    return out;
  };
  const arm = fixtureAccuracy(armRows);
  const baseline = fixtureAccuracy(baselineRows);
  const differences = fixtureSubset
    .map((fixture) => (arm.get(fixture.id) ?? 0) - (baseline.get(fixture.id) ?? 0));
  const delta = differences.reduce((sum, value) => sum + value, 0) / Math.max(1, differences.length);
  let state = 0x5eed1234;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const samples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    let sum = 0;
    for (let i = 0; i < differences.length; i++) sum += differences[Math.floor(random() * differences.length)]!;
    samples.push(sum / Math.max(1, differences.length));
  }
  samples.sort((a, b) => a - b);
  return {
    delta,
    low: samples[Math.floor(iterations * 0.025)] ?? delta,
    high: samples[Math.floor(iterations * 0.975)] ?? delta,
  };
}

function loadBaselineRows(): CellRow[] {
  const path = join(process.cwd(), "eval", "jev-compression", "results", "baseline.json");
  const data = JSON.parse(readFileSync(path, "utf8")) as { rows: Array<Omit<CellRow, "arm"> & { arm?: string }> };
  return data.rows.map((row) => ({ ...row, arm: row.arm ?? "A0" }));
}

async function main(): Promise<void> {
  if (repeat < 5 && live) throw new Error("live measurement requires at least 5 repetitions per cell");
  if (fixtures.length < 60) throw new Error("measurement corpus must contain at least 60 fixtures");
  if (new Set(fixtures.map((fixture) => fixture.id)).size !== fixtures.length) throw new Error("fixture ids must be unique");
  if (fixtures.filter((fixture) => fixture.expect === "flag").length !== fixtures.filter((fixture) => fixture.expect === "clean").length) {
    throw new Error("measurement corpus must be balanced between flag and clean fixtures");
  }

  const rows: CellRow[] = [];
  const tasks: Task[] = [];
  const survivorArms = SINGLE_ARMS.filter((arm) => survivors.includes(arm.id));
  const c1Options = Object.assign({}, ...survivorArms.map((arm) => arm.options)) as JevPromptOptimizations;
  const allOptions = Object.assign({}, ...SINGLE_ARMS.map((arm) => arm.options)) as JevPromptOptimizations;
  const activeArms: ArmDefinition[] = phase === "singles"
    ? SINGLE_ARMS
    : phase === "composites"
      ? [
          { id: "C1", label: survivorArms.length ? `measurable singles (${survivorArms.map((arm) => arm.id).join("+")})` : "no measurable single arms", options: c1Options },
          { id: "C2", label: "all five optimizations", options: allOptions },
        ]
      : [];
  if (phase === "composites" && survivors.some((id) => !SINGLE_ARMS.some((arm) => arm.id === id))) {
    throw new Error(`unknown survivor arm in --survivors=${survivors.join(",")}`);
  }
  for (const fixture of fixtures) {
    const { dir, cleanup } = await fixtureRepo(fixture.repoSetup);
    try {
      const material: JevInputMaterial = {
        dir,
        userRequest: padRequest(fixture.userRequest),
        finalMessage: fixture.finalMessage,
        receipts: padReceipts(fixture.receipts),
      };
      if (phase === "baseline") {
        const variants = await buildJevInputVariants(material);
        for (const diet of DIETS) {
          const turn = variants[diet];
          const row: CellRow = { fixtureId: fixture.id, arm: "A0", diet, chars: inputChars(turn), runs: [] };
          rows.push(row);
          for (let repetition = 0; repetition < repeat; repetition++) tasks.push({ row, turn, repetition });
        }
      } else {
        for (const arm of activeArms) {
          const turn = await buildCompressedJevInput(material, arm.options);
          const row: CellRow = { fixtureId: fixture.id, arm: arm.id, diet: "compressed", chars: inputChars(turn), runs: [] };
          rows.push(row);
          for (let repetition = 0; repetition < repeat; repetition++) tasks.push({ row, turn, repetition });
        }
      }
    } finally {
      await cleanup();
    }
  }

  const commit = (await execa("git", ["rev-parse", "HEAD"])).stdout.trim();
  await runTasks(tasks, rows, commit);
  if (live) writeData(rows, commit);

  emit(`# Jev prompt-optimization ${phase}`);
  emit();
  emit(`Corpus: ${fixtures.length} labelled fixtures (${fixtures.filter((f) => f.expect === "flag").length} flag, ${fixtures.filter((f) => f.expect === "clean").length} clean; ${fixtures.filter((f) => f.domain === "backend").length} backend, ${fixtures.filter((f) => f.domain === "frontend").length} frontend).`);
  emit(`Original corpus: the first ${ORIGINAL_CORPUS_SIZE} fixtures are unchanged from \`f64e1b6\` and are reported separately below.`);
  emit("Historical telemetry cannot supply additional fixtures because it retains only 400-character claim prefixes, not reconstructable full turns and evidence. New fixtures were authored in the same paired claim/receipt style as the original corpus.");
  emit(`Live Jev accuracy: ${live ? `${repeat} repetitions per fixture/cell` : "NOT RUN — sizes only"}.`);
  if (phase === "baseline") {
    emit();
    emit("| Diet | Median chars | Accuracy (95% Wilson CI) | Repetition spread | Correct catches | Missed | False | Correct clean | Errors |");
    emit("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const diet of DIETS) {
      const dietRows = rows.filter((row) => row.diet === diet);
      const scored = score(dietRows, fixtures);
      const ci = wilson(scored.correct, scored.valid);
      const spread = scored.repeatRates.length ? `${pct(Math.min(...scored.repeatRates))}–${pct(Math.max(...scored.repeatRates))}` : "n/a";
      emit(`| ${diet} | ${median(dietRows.map((row) => row.chars)).toLocaleString()} | ${scored.correct}/${scored.valid} = ${pct(scored.correct / Math.max(1, scored.valid))} (${pct(ci[0])}–${pct(ci[1])}) | ${spread} | ${scored.catches} | ${scored.misses} | ${scored.falseCatches} | ${scored.correctClean} | ${scored.errors} |`);
    }
  } else {
    const baselineRows = loadBaselineRows();
    const compressedBaseline = baselineRows.filter((row) => row.diet === "compressed");
    const fullBaseline = baselineRows.filter((row) => row.diet === "full");
    const compressedScore = score(compressedBaseline, fixtures);
    const fullScore = score(fullBaseline, fixtures);
    const compressedRate = compressedScore.correct / compressedScore.valid;
    const fullRate = fullScore.correct / fullScore.valid;
    emit();
    emit("A single arm is a measurable gain only when its 95% fixture-cluster bootstrap interval versus compressed baseline excludes zero.");
    emit();
    emit("| Arm | Packaging | Median chars | Accuracy (95% Wilson CI) | Repeat spread | Δ vs compressed (95% paired CI) | Δ vs full | Effect | Errors |");
    emit("|---|---|---:|---:|---:|---:|---:|---|---:|");
    for (const arm of activeArms) {
      const armRows = rows.filter((row) => row.arm === arm.id);
      const scored = score(armRows, fixtures);
      const ci = wilson(scored.correct, scored.valid);
      const delta = pairedBootstrapDelta(armRows, compressedBaseline, fixtures);
      const spread = scored.repeatRates.length ? `${pct(Math.min(...scored.repeatRates))}–${pct(Math.max(...scored.repeatRates))}` : "n/a";
      const effect = delta.low > 0 ? "measurable gain" : delta.high < 0 ? "measurable loss" : "no measurable effect";
      emit(`| ${arm.id} | ${arm.label} | ${median(armRows.map((row) => row.chars)).toLocaleString()} | ${scored.correct}/${scored.valid} = ${pct(scored.correct / Math.max(1, scored.valid))} (${pct(ci[0])}–${pct(ci[1])}) | ${spread} | ${pct(delta.delta)} (${pct(delta.low)}–${pct(delta.high)}) | ${pct(scored.correct / Math.max(1, scored.valid) - fullRate)} | ${effect} | ${scored.errors} |`);
    }
    emit();
    emit(`Reference rates: compressed ${pct(compressedRate)} (${compressedScore.correct}/${compressedScore.valid}); full ${pct(fullRate)} (${fullScore.correct}/${fullScore.valid}).`);
  }

  emit();
  emit("## Original 24 fixtures");
  emit();
  emit("| Cell | Accuracy (95% Wilson CI) | Repetition spread | Correct catches | Missed | False | Correct clean | Errors |");
  emit("|---|---:|---:|---:|---:|---:|---:|---:|");
  const originalCells = phase === "baseline"
    ? DIETS.map((diet) => ({ id: diet, rows: rows.filter((row) => row.diet === diet) }))
    : activeArms.map((arm) => ({ id: arm.id, rows: rows.filter((row) => row.arm === arm.id) }));
  for (const cell of originalCells) {
    const scored = score(cell.rows, fixtures.slice(0, ORIGINAL_CORPUS_SIZE));
    const ci = wilson(scored.correct, scored.valid);
    const spread = scored.repeatRates.length ? `${pct(Math.min(...scored.repeatRates))}–${pct(Math.max(...scored.repeatRates))}` : "n/a";
    emit(`| ${cell.id} | ${scored.correct}/${scored.valid} = ${pct(scored.correct / Math.max(1, scored.valid))} (${pct(ci[0])}–${pct(ci[1])}) | ${spread} | ${scored.catches} | ${scored.misses} | ${scored.falseCatches} | ${scored.correctClean} | ${scored.errors} |`);
  }

  const measuredUsage = usage(rows);
  emit();
  emit("## Cost");
  emit();
  emit(`Jev calls (including retries): ${measuredUsage.calls.toLocaleString()}. Provider-reported usage: ${measuredUsage.inputTokens.toLocaleString()} input tokens and ${measuredUsage.outputTokens.toLocaleString()} output tokens.`);
  emit(measuredUsage.unknownPriceCalls
    ? `Total dollar spend is unavailable because Jev did not report a price for ${measuredUsage.unknownPriceCalls.toLocaleString()} successful call(s); priced-call subtotal: $${measuredUsage.knownCost.toFixed(6)} across zero priced calls.`
    : `Total provider-reported spend: $${measuredUsage.knownCost.toFixed(6)}.`);
  emit();
  emit(`Machine-readable results: \`${dataPath.replace(`${process.cwd()}/`, "")}\`.`);

  if (live) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${report.join("\n")}\n`, "utf8");
    console.log(`\nWrote ${phase} report to ${outputPath}`);
  }
  if (requireLive && !live) process.exitCode = 2;
  if (live && rows.some((row) => row.runs.some((run) => run.error))) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
