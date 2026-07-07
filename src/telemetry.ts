/**
 * Confabulation-catch telemetry. Every time ser fires on an agent's completion
 * claim, one structured record lands in a single global log (~/.veritaserum/telemetry.jsonl
 * by default) so a week of real use across Claude Code / goose / codex is one
 * readable stream. `ser telemetry` summarizes it: catches, false-blocks, by class.
 *
 * Telemetry MUST NEVER break the hook — every write is best-effort and swallowed.
 */
import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface Firing {
  ts: string;
  harness: string; // claude-code | goose | codex | unknown
  event: "stop" | "verify" | "prompt";
  /** The agent's completion claim (truncated). */
  claim: string;
  /** grounded (claim held) | blocked (contradiction) | abstain | pass | error */
  verdict: string;
  /** What ser caught as unsupported/contradicted (empty when nothing). */
  caught: string;
  /** The sentinel's decision. In advisory mode this is what it WOULD have done. */
  blocked: boolean;
  /** True when VS_ADVISORY was set: logged only, the agent was not actually stopped. */
  advisory?: boolean;
  dir: string;
}

export function telemetryPath(): string {
  return process.env.VS_TELEMETRY_PATH || join(homedir(), ".veritaserum", "telemetry.jsonl");
}

export function logFiring(f: Omit<Firing, "ts">): void {
  try {
    const p = telemetryPath();
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...f }) + "\n");
  } catch {
    /* telemetry must never break the hook */
  }
}

export function readFirings(): Firing[] {
  const p = telemetryPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Firing;
      } catch {
        return null;
      }
    })
    .filter((x): x is Firing => x !== null);
}

/** Human-readable summary — the in-the-wild measurement. */
export function summarize(firings: Firing[]): string {
  const n = firings.length;
  const caught = firings.filter((f) => f.caught.trim().length > 0);
  const actuallyBlocked = firings.filter((f) => f.blocked && !f.advisory);
  const wouldBlock = firings.filter((f) => f.blocked && f.advisory);
  const byHarness = firings.reduce<Record<string, number>>((m, f) => ((m[f.harness] = (m[f.harness] ?? 0) + 1), m), {});
  const label = (f: Firing): string => (f.blocked ? (f.advisory ? "would-block" : "BLOCKED") : "flagged");
  const lines = [
    `ser telemetry — ${n} firing(s)`,
    `  caught (flagged an unsupported claim):  ${caught.length}`,
    `  blocked (actually stopped the turn):    ${actuallyBlocked.length}`,
    `  would-block (advisory, logged only):    ${wouldBlock.length}`,
    `  by harness: ${JSON.stringify(byHarness)}`,
    ``,
    `recent catches:`,
    ...caught.slice(-10).map((f) => `  [${f.ts.slice(0, 19)}] ${f.harness} ${label(f)}: ${f.caught.slice(0, 120)}`),
  ];
  return lines.join("\n");
}
