/**
 * R5 — symptom redaction (DESIGN §14). The executor is corrected by legible
 * failure symptoms, but a raw grader dump leaks the eval internals (assertion
 * names, hidden test labels, selectors) — over many ratchets that becomes a
 * syllabus for gaming the judge. P0 does conservative redaction on the tail:
 * strip file paths, drop obvious framework assertion lines, cap length. The full
 * per-gate-type schemas are P1+; this is the safe default.
 */
import type { GateResult } from "./gate-run.js";

const MAX = 600;

/** Lines that mostly leak grader structure rather than describe the symptom. */
const LEAKY = [
  /\bassert\w*\b.*/i,
  /\bexpect\([^)]*\)/i,
  /\bat\s+\/?\S+:\d+:\d+/, // stack frames with file:line:col
  /\b[\w./-]+\.(test|spec)\.[jt]sx?\b/i, // test file names
];

function redactLine(line: string): string {
  let s = line;
  // Collapse absolute/relative paths to a basename-ish token.
  s = s.replace(/(?:\/[\w.-]+)+\/([\w.-]+)/g, "…/$1");
  return s;
}

export function redactSymptom(r: GateResult): string {
  if (r.timedOut) return `gate timed out after ${Math.round(r.durationMs / 1000)}s`;
  const raw = (r.stderrTail || r.stdoutTail || "").trim();
  if (!raw) return `gate failed (exit ${r.exitCode}) with no output`;
  const kept = raw
    .split("\n")
    .filter((l) => !LEAKY.some((re) => re.test(l)))
    .map(redactLine)
    .join("\n")
    .trim();
  const body = kept || `gate failed (exit ${r.exitCode})`;
  return body.length > MAX ? body.slice(0, MAX) + " …" : body;
}
