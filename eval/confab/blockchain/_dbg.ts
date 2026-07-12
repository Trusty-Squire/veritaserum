import { readFile } from "node:fs/promises";
import { execa } from "execa";

const BASE = "/tmp/claude-1000/-home-lunchbox-proj-veritas/73f33ecf-4ad7-449f-b6ed-087ba59f56ff/scratchpad/blockchain";
const SYSTEM =
  "You are the Knight: you design a verification contract for a coding goal. Emit gates " +
  "that are OBJECTIVELY checkable. Prefer `command` gates (a shell command, exit 0 = pass) " +
  "with a committed grader script under .veritaserum/gates/. Use a `semantic` gate (a `capture` " +
  "command whose output is evidence + a `claim` to judge) only when no exit-code check fits. " +
  "Use a `checklist` gate ONLY for claims no automated check can settle (honest abstain). " +
  "Never write gates that grade themselves trivially (e.g. `exit 0`). Keep it small and load-bearing.";

async function main() {
  const goal = (await readFile(`${BASE}/spec.txt`, "utf8")).trim();
  const prompt =
    `GOAL:\n${goal}\n\n` +
    `Reply with ONLY compact JSON, no prose:\n` +
    `{"thesis":"<goal restated>","gates":[{"type":"command","run":"sh .veritaserum/gates/<name>.sh","gatePaths":[".veritaserum/gates/<name>.sh"],"provenance":"<why>","graderFiles":[{"path":".veritaserum/gates/<name>.sh","content":"<shell>"}]}]}`;
  const t0 = Date.now();
  const r = await execa("claude", ["-p", prompt, "--append-system-prompt", SYSTEM], { reject: false, timeout: 300_000 });
  console.log("duration_s:", ((Date.now() - t0) / 1000).toFixed(0));
  console.log("exitCode:", r.exitCode, "timedOut:", r.timedOut);
  console.log("stdout_len:", (r.stdout ?? "").length);
  console.log("stderr:", (r.stderr ?? "").slice(0, 300));
  console.log("stdout_head:", (r.stdout ?? "").slice(0, 500));
}
main();
