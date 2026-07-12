/**
 * fa_reaudit.ts — POST-FIX false-alarm re-audit (measurement-only, not committed).
 *
 * Replays this session's 26 labeled answers through the CURRENT (abstention-guard)
 * auditor, both families, and computes the post-fix false-alarm + miss rates vs the
 * pre-fix baseline (Claude 47% 9/19, codex 47% 9/19, miss 0/3).
 *
 * Runs 4 passes (one per cell×executor); each pass swaps the cell's replay.json
 * in-process and ALWAYS restores it in a finally block. Reuses the exact tested
 * audit path (runUnverifiableCell / runKnowledgeConflictCell, driver=replay).
 *
 * Fidelity note: replays receipt-free (no goose trace). That is a HARDER test —
 * less evidence can only make the auditor MORE prone to flag. A false-alarm DROP
 * under this condition is therefore a conservative (pessimistic) result.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runUnverifiableCell } from "./unverifiable/runner.js";
import { runKnowledgeConflictCell } from "./knowledge-conflict/runner.js";

const SP = "/tmp/claude-1000/-home-lunchbox-proj-veritas/73f33ecf-4ad7-449f-b6ed-087ba59f56ff/scratchpad";
const REPO = "/home/lunchbox/proj-veritas";
const UV_REPLAY = join(REPO, "eval/confab/unverifiable/replay.json");
const KC_REPLAY = join(REPO, "eval/confab/knowledge-conflict/replay.json");
const OUT_DIR = join(SP, "fa_post2");

type Row = { run: string; executor: string; cell: string; fixture: string; label: string };

async function fullAnswer(run: string, fixture: string): Promise<string> {
  const s = JSON.parse(await readFile(join(SP, run, "scorecard.json"), "utf8"));
  const arr = s.fixtures || s.results || [];
  const f = arr.find((x: any) => x.name === fixture);
  return f ? String(f.answer ?? "") : "";
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const corpus: Row[] = JSON.parse(await readFile(join(SP, "falsealarm_labeled.json"), "utf8"));

  // Passes: cell + executor + which runs they draw answers from.
  const passes = [
    { id: "uv-deepseek", cell: "unverifiable", executor: "deepseek", runner: runUnverifiableCell, replayPath: UV_REPLAY, runs: ["unverif_deepseek"] },
    { id: "uv-qwen14b", cell: "unverifiable", executor: "qwen14b", runner: runUnverifiableCell, replayPath: UV_REPLAY, runs: ["unverif_qwen14b"] },
    { id: "kc-deepseek", cell: "knowledge-conflict", executor: "deepseek", runner: runKnowledgeConflictCell, replayPath: KC_REPLAY, runs: ["kc_deepseek6", "kc_bulk_deepseek"] },
    { id: "kc-qwen14b", cell: "knowledge-conflict", executor: "qwen14b", runner: runKnowledgeConflictCell, replayPath: KC_REPLAY, runs: ["kc_bulk_qwen14b"] },
  ];

  const uvBackup = await readFile(UV_REPLAY, "utf8");
  const kcBackup = await readFile(KC_REPLAY, "utf8");

  // caught[cell|executor|fixture] = {claude, codex}
  const caught: Record<string, { claude: boolean; codex: boolean }> = {};

  try {
    for (const p of passes) {
      // Build this pass's replay.json from the corpus rows in its runs.
      const rows = corpus.filter((r) => r.cell === p.cell && p.runs.includes(r.run));
      const entries: { fixture: string; answer: string }[] = [];
      for (const r of rows) entries.push({ fixture: r.fixture, answer: await fullAnswer(r.run, r.fixture) });
      await writeFile(p.replayPath, JSON.stringify(entries, null, 2));

      const dir = join(OUT_DIR, p.id);
      await mkdir(dir, { recursive: true });
      console.error(`[pass ${p.id}] auditing ${entries.length} fixtures × 2 families ...`);
      const scorecard: any = await p.runner({ driver: "replay", dir } as any);
      for (const f of scorecard.fixtures) {
        caught[`${p.cell}|${p.executor}|${f.name}`] = { claude: !!f.claude?.caught, codex: !!f.codex?.caught };
        console.error(`    ${f.name}: claude=${f.claude?.caught ? "FLAG" : "ok"} codex=${f.codex?.caught ? "FLAG" : "ok"}`);
      }
    }
  } finally {
    await writeFile(UV_REPLAY, uvBackup);
    await writeFile(KC_REPLAY, kcBackup);
    console.error("[restore] replay.json originals restored");
  }

  // Join post-fix flags to labels.
  const joined = corpus.map((r) => {
    const c = caught[`${r.cell}|${r.executor}|${r.fixture}`] || { claude: null, codex: null };
    return { ...r, postClaudeFlag: c.claude, postCodexFlag: c.codex };
  });
  await writeFile(join(SP, "falsealarm_postfix.json"), JSON.stringify(joined, null, 2));

  const honest = joined.filter((r) => r.label === "honest");
  const confab = joined.filter((r) => r.label === "confab");
  const n = (arr: any[], k: string) => arr.filter((r) => r[k]).length;
  const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(0) + "%" : "n/a");

  const cFA = n(honest, "postClaudeFlag"), xFA = n(honest, "postCodexFlag");
  const cMiss = confab.filter((r) => r.postClaudeFlag === false).length;
  const xMiss = confab.filter((r) => r.postCodexFlag === false).length;

  const lines = [
    "",
    "=== BEFORE / AFTER (false-alarm = flagged an honest answer) ===",
    `                | Claude pre | Claude post | codex pre | codex post`,
    `  false-alarm   |  47% (9/19) | ${pct(cFA, honest.length).padStart(4)} (${cFA}/${honest.length}) |  47% (9/19)| ${pct(xFA, honest.length).padStart(4)} (${xFA}/${honest.length})`,
    `  miss          |    0/3      |    ${cMiss}/3      |    0/3    |    ${xMiss}/3`,
    "",
    "=== honest answers STILL flagged post-fix ===",
  ];
  for (const r of honest.filter((r) => r.postClaudeFlag || r.postCodexFlag)) {
    const who = [r.postClaudeFlag ? "claude" : "", r.postCodexFlag ? "codex" : ""].filter(Boolean).join("+");
    lines.push(`  [${who}] ${r.run}/${r.fixture}`);
  }
  const report = lines.join("\n");
  console.log(report);
  await writeFile(join(SP, "falsealarm_postfix_report.txt"), report);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
