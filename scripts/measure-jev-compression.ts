#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { buildJevInputVariants, type JevInputVariants } from "../src/jev-evidence.js";
import { buildJevState, invokeJevWithMeta, type JevTurnState } from "../src/jev.js";
import { typesafeApiKey } from "../src/llm.js";
import { fixtureRepo, type RepoSetup } from "../eval/fixtures/types.js";

type Domain = "backend" | "frontend";
type Expectation = "flag" | "clean";
type Diet = keyof JevInputVariants;

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

interface DietResult {
  chars: number;
  prediction?: Expectation;
  error?: string;
  skipped?: boolean;
}

interface FixtureResult {
  fixture: CompressionFixture;
  diets: Record<Diet, DietResult>;
  requestAblation: DietResult;
}

const DIETS: Diet[] = ["full", "filtered", "compressed"];
const fixturePath = join(process.cwd(), "eval", "jev-compression", "fixtures.json");
const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as CompressionFixture[];
const live = Boolean(typesafeApiKey()) && !process.argv.includes("--sizes-only");
const requireLive = process.argv.includes("--require-live");
const repeatArg = process.argv.find((arg) => arg.startsWith("--repeat="));
const repeat = Math.max(1, Number.parseInt(repeatArg?.split("=")[1] ?? "1", 10) || 1);
const outputArg = process.argv.find((arg) => arg.startsWith("--output="))?.slice("--output=".length);
const outputPath = outputArg
  ? (isAbsolute(outputArg) ? outputArg : join(process.cwd(), outputArg))
  : join(process.cwd(), "docs", "JEV-COMPRESSION-LIVE-RESULTS.md");
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
  try {
    const value = JSON.parse(reply) as { claims?: unknown[]; unaccountable?: boolean };
    return (value.claims?.length ?? 0) > 0 || value.unaccountable === true ? "flag" : "clean";
  } catch {
    throw new Error("Jev reply did not map to an audit verdict");
  }
}

async function runDiet(turn: JevTurnState, diet: Diet): Promise<DietResult> {
  const chars = inputChars(turn);
  if ((diet === "filtered" || diet === "compressed") && !turn.finalMessage.trim()) {
    return { chars, prediction: "clean", skipped: true };
  }
  if (!live) return { chars };
  let flags = 0;
  try {
    for (let i = 0; i < repeat; i++) {
      const invocation = await invokeJevWithMeta(JSON.stringify(turn), 30_000);
      if (classifyReply(invocation.reply) === "flag") flags++;
    }
    return { chars, prediction: flags > repeat / 2 ? "flag" : "clean" };
  } catch (error) {
    return { chars, error: error instanceof Error ? error.message : String(error) };
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function scoreResults(rows: Array<{ fixture: CompressionFixture; result: DietResult }>): { correctCatches: number; missedCatches: number; falseCatches: number; correctClean: number; errors: number } {
  let correctCatches = 0;
  let missedCatches = 0;
  let falseCatches = 0;
  let correctClean = 0;
  let errors = 0;
  for (const row of rows) {
    if (row.result.error || !row.result.prediction) {
      errors++;
      continue;
    }
    if (row.fixture.expect === "flag" && row.result.prediction === "flag") correctCatches++;
    if (row.fixture.expect === "flag" && row.result.prediction === "clean") missedCatches++;
    if (row.fixture.expect === "clean" && row.result.prediction === "flag") falseCatches++;
    if (row.fixture.expect === "clean" && row.result.prediction === "clean") correctClean++;
  }
  return { correctCatches, missedCatches, falseCatches, correctClean, errors };
}

function score(rows: FixtureResult[], diet: Diet, domain?: Domain): { correctCatches: number; missedCatches: number; falseCatches: number; correctClean: number; errors: number } {
  const relevant = domain ? rows.filter((row) => row.fixture.domain === domain) : rows;
  return scoreResults(relevant.map((row) => ({ fixture: row.fixture, result: row.diets[diet] })));
}

async function main(): Promise<void> {
  if (new Set(fixtures.map((fixture) => fixture.id)).size !== fixtures.length) throw new Error("fixture ids must be unique");
  const results: FixtureResult[] = [];
  for (const fixture of fixtures) {
    const { dir, cleanup } = await fixtureRepo(fixture.repoSetup);
    try {
      const variants = await buildJevInputVariants({
        dir,
        userRequest: padRequest(fixture.userRequest),
        finalMessage: fixture.finalMessage,
        receipts: padReceipts(fixture.receipts),
      });
      const requestAblation = await runDiet({ ...variants.compressed, userRequest: "" }, "compressed");
      results.push({
        fixture,
        diets: {
          full: await runDiet(variants.full, "full"),
          filtered: await runDiet(variants.filtered, "filtered"),
          compressed: await runDiet(variants.compressed, "compressed"),
        },
        requestAblation,
      });
    } finally {
      await cleanup();
    }
  }

  emit("# Jev compression fixture measurement");
  emit();
  emit(`Corpus: ${fixtures.length} labelled fixtures (${fixtures.filter((f) => f.domain === "backend").length} backend, ${fixtures.filter((f) => f.domain === "frontend").length} frontend).`);
  emit(`Live Jev accuracy: ${live ? `run (${repeat} repetition${repeat === 1 ? "" : "s"} per fixture/diet)` : "NOT RUN — TYPESAFE_API_KEY is unset; sizes only"}.`);
  emit();
  emit("| Diet | Median chars | Max chars | Under 10K | Correct catches | Missed catches | False catches | Correct clean | Unscored/errors | ");
  emit("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const diet of DIETS) {
    const sizes = results.map((row) => row.diets[diet].chars);
    const scored = score(results, diet);
    emit(`| ${diet} | ${median(sizes).toLocaleString()} | ${Math.max(...sizes).toLocaleString()} | ${sizes.filter((size) => size < 10_000).length}/${sizes.length} | ${scored.correctCatches} | ${scored.missedCatches} | ${scored.falseCatches} | ${scored.correctClean} | ${scored.errors} |`);
  }

  emit();
  emit("## Domain split");
  emit();
  emit("| Domain | Diet | Correct catches | Missed catches | False catches | Correct clean | Unscored/errors | ");
  emit("|---|---|---:|---:|---:|---:|---:|");
  for (const domain of ["backend", "frontend"] as const) {
    for (const diet of DIETS) {
      const scored = score(results, diet, domain);
      emit(`| ${domain} | ${diet} | ${scored.correctCatches} | ${scored.missedCatches} | ${scored.falseCatches} | ${scored.correctClean} | ${scored.errors} |`);
    }
  }

  emit();
  emit("## Request ablation");
  emit();
  emit("The production candidate keeps the deterministic request slice. This ablation sends the identical compressed claims/evidence with an empty request.");
  emit();
  emit("| Domain | Median chars without request | Correct catches | Missed catches | False catches | Correct clean | Unscored/errors | ");
  emit("|---|---:|---:|---:|---:|---:|---:|");
  for (const domain of ["backend", "frontend"] as const) {
    const domainRows = results.filter((row) => row.fixture.domain === domain);
    const scored = scoreResults(domainRows.map((row) => ({ fixture: row.fixture, result: row.requestAblation })));
    emit(`| ${domain} | ${median(domainRows.map((row) => row.requestAblation.chars)).toLocaleString()} | ${scored.correctCatches} | ${scored.missedCatches} | ${scored.falseCatches} | ${scored.correctClean} | ${scored.errors} |`);
  }

  emit();
  emit("## Fixture rows");
  emit();
  emit("| Fixture | Domain | Shape | Truth | Full | Filtered | Compressed | Chars full/current/new | ");
  emit("|---|---|---|---|---|---|---|---:|");
  for (const row of results) {
    const display = (result: DietResult): string => result.error ? "ERROR" : result.prediction ?? "not-run";
    emit(`| ${row.fixture.id} | ${row.fixture.domain} | ${row.fixture.shape} | ${row.fixture.expect} | ${display(row.diets.full)} | ${display(row.diets.filtered)} | ${display(row.diets.compressed)} | ${row.diets.full.chars}/${row.diets.filtered.chars}/${row.diets.compressed.chars} |`);
  }

  emit();
  emit("## Every missed catch");
  emit();
  emit("| Evaluation | Fixture | Domain | Claim |");
  emit("|---|---|---|---|");
  for (const diet of DIETS) {
    for (const row of results.filter((candidate) => candidate.fixture.expect === "flag" && candidate.diets[diet].prediction === "clean")) {
      emit(`| ${diet} | ${row.fixture.id} | ${row.fixture.domain} | ${markdownCell(row.fixture.finalMessage)} |`);
    }
  }
  for (const row of results.filter((candidate) => candidate.fixture.expect === "flag" && candidate.requestAblation.prediction === "clean")) {
    emit(`| request-free ablation | ${row.fixture.id} | ${row.fixture.domain} | ${markdownCell(row.fixture.finalMessage)} |`);
  }

  emit();
  emit("## Every false catch");
  emit();
  emit("| Evaluation | Fixture | Domain | Claim |");
  emit("|---|---|---|---|");
  for (const diet of DIETS) {
    for (const row of results.filter((candidate) => candidate.fixture.expect === "clean" && candidate.diets[diet].prediction === "flag")) {
      emit(`| ${diet} | ${row.fixture.id} | ${row.fixture.domain} | ${markdownCell(row.fixture.finalMessage)} |`);
    }
  }
  for (const row of results.filter((candidate) => candidate.fixture.expect === "clean" && candidate.requestAblation.prediction === "flag")) {
    emit(`| request-free ablation | ${row.fixture.id} | ${row.fixture.domain} | ${markdownCell(row.fixture.finalMessage)} |`);
  }

  if (live) {
    writeFileSync(outputPath, `${report.join("\n")}\n`, "utf8");
    console.log(`\nWrote live Jev results to ${outputPath}`);
  }
  if (requireLive && !live) process.exitCode = 2;
  if (live && results.some((row) => DIETS.some((diet) => row.diets[diet].error) || row.requestAblation.error)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
