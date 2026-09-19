#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectLoadBearingClaims, JEV_EVIDENCE_BUDGET_BYTES, renderClaimSpans } from "../src/jev-input.js";

interface TelemetryRow {
  ts?: string;
  event?: string;
  claim?: string;
  caught?: string;
  verdict?: string;
  gated?: string;
  prompt_chars?: number;
  evidence_bytes?: number;
}

const SAMPLE_SIZE = 1_175;

function quantile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function stripOuterQuotes(value: string): string {
  return value.trim().replace(/^["“]+|["”]+$/g, "").trim();
}

/** Recover the old auditor's recorded cause span from each historical warning shape. */
function caughtClaim(caught: string): string {
  let match = caught.match(/\bclaim\s+["“]+([^"”]+)["”]+/i);
  if (match?.[1]) return match[1].trim();
  match = caught.match(/^(.+?)\s+—\s+(?:unsupported|contradicted):/i);
  if (match?.[1]) return match[1].trim();
  match = caught.match(/(?:number|never observed|attempted it|verified):\s*(["“]+[\s\S]*?["”]+)\s+—/i);
  if (match?.[1]) return stripOuterQuotes(match[1]);
  match = caught.match(/:\s*["“]+([^"”]+)["”]+\s+—/);
  return match?.[1]?.trim() ?? "";
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

const telemetryPath = process.argv[2] || join(homedir(), ".veritaserum", "telemetry.jsonl");
const rows = readFileSync(telemetryPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .flatMap((line): TelemetryRow[] => {
    try {
      return [JSON.parse(line) as TelemetryRow];
    } catch {
      return [];
    }
  });

// The brief's starting point was the first 1,175 full audits carrying both size
// fields. Pinning the prefix makes the report stable while telemetry keeps growing.
const sample = rows
  .filter(
    (row) =>
      row.event === "audit" &&
      row.gated === "full" &&
      Number.isFinite(row.prompt_chars) &&
      Number.isFinite(row.evidence_bytes),
  )
  .slice(0, SAMPLE_SIZE);

if (sample.length !== SAMPLE_SIZE) throw new Error(`need ${SAMPLE_SIZE} full audit rows, found ${sample.length}`);

const replay = sample.map((row) => {
  const claim = row.claim ?? "";
  const spans = detectLoadBearingClaims(claim);
  const filtered = renderClaimSpans(spans);
  const before = row.prompt_chars!;
  const evidence = Math.max(0, row.evidence_bytes!);
  // Telemetry retained sizes, not historical receipt bodies. This is a
  // conservative cap replay: retain every non-evidence prompt char, replace the
  // recorded evidence with at most the deterministic selector's 12KB budget,
  // and replace the retained 400-char message prefix with its surviving spans.
  const after = spans.length === 0
    ? 0
    : Math.max(0, before - evidence - claim.length) + Math.min(evidence, JEV_EVIDENCE_BUDGET_BYTES) + filtered.length;
  return { before, after, skipped: spans.length === 0 };
});

const regressions: Array<{ ts: string; claim: string }> = [];
let flagged = 0;
let intact = 0;
for (const row of sample) {
  if (!row.caught || row.verdict === "error") continue;
  flagged++;
  const claim = caughtClaim(row.caught);
  if (!claim) {
    regressions.push({ ts: row.ts ?? "unknown", claim: "[no claim span: historical unaccountable-work finding]" });
  } else if (detectLoadBearingClaims(claim).length > 0) {
    intact++;
  } else {
    regressions.push({ ts: row.ts ?? "unknown", claim });
  }
}

const skips = replay.filter((row) => row.skipped).length;
console.log("# Jev input filter telemetry replay");
console.log();
console.log(`Source: \`${telemetryPath}\`, first ${SAMPLE_SIZE} \`gated=full\` audit rows with prompt/evidence sizes (${sample[0]!.ts} through ${sample.at(-1)!.ts}).`);
console.log();
console.log("| Metric | Before | After |");
console.log("|---|---:|---:|");
console.log(`| Median prompt chars | ${quantile(replay.map((row) => row.before), 0.5).toLocaleString()} | ${quantile(replay.map((row) => row.after), 0.5).toLocaleString()} |`);
console.log(`| p95 prompt chars | ${quantile(replay.map((row) => row.before), 0.95).toLocaleString()} | ${quantile(replay.map((row) => row.after), 0.95).toLocaleString()} |`);
console.log(`| Turns with no Jev call | 0 | ${skips}/${SAMPLE_SIZE} (${(100 * skips / SAMPLE_SIZE).toFixed(2)}%) |`);
console.log();
console.log(`Catch parity: ${intact}/${flagged} historical flagged turns retain their recorded cause span; ${regressions.length} do not.`);
console.log();
console.log("The after-size is a conservative replay over real telemetry sizes: historical receipt bodies were not retained, so it applies the 12KB selector ceiling rather than claiming the usually smaller content-selected byte count. The `claim` and `caught` fields are each capped at 400 characters; the parity check uses the old warning's recorded cause span when present.");
console.log();
console.log("## Explicit catch regressions");
console.log();
console.log("| Timestamp | Historical cause span dropped by the filter |");
console.log("|---|---|");
for (const regression of regressions) console.log(`| ${regression.ts} | ${escapeCell(regression.claim)} |`);
