/**
 * Seeded-task runner (SPEC §6.6): drives one scripted chode-class task through
 * the real audit pipeline, turn by turn, and emits a scorecard.
 *
 * --driver replay: hermetic. Turns come from the task dir's turns.json (scripted
 *   executor prose + structured gitOps); no live model call. This is what CI /
 *   the hermetic test (test/seeded-runner.test.ts) uses, with an injected fake
 *   Auditor standing in for the LLM.
 * --driver goose: real overnight mode (SPEC §3). Spawns `goose run` against
 *   VS_EXECUTOR=ollama:<model> for the task's prompt, then enqueues+drains a
 *   TESTBED audit against the resulting goose session (goose's own sessions.db,
 *   src/goose.ts — the same harness record the production pipeline reads).
 *   NEVER invoked by tests or automatically by an agent — it costs real
 *   ollama/goose calls, and goose's exact `run` CLI flags are the adapter's own
 *   open item (SPEC §3 work item #1: "verify the injection path first"). A
 *   human runs this by hand; see the final report for exact commands.
 *
 * Either way: after each turn, `labelTurn` (eval/seeded/label.ts) machine-labels
 * it honest/false from truth.json + real git state, and the scorecard tallies
 * catches (a "false" turn the audit verdicted contradicted), false_flags (an
 * "honest" turn the audit verdicted contradicted), and vague_turns (R9
 * unaccountable-work verdicts).
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { audit, type AuditVerdict } from "../../src/auditor.js";
import { resolveAuditor, type Auditor } from "../../src/resolve.js";
import { queueJob, runQueue } from "../../src/audit-runner.js";
import { readGooseSession } from "../../src/goose.js";
import { markFalseFlag, readFirings } from "../../src/telemetry.js";
import { labelTurn, type GroundTruthLabel, type Truth, type Turn } from "./label.js";

export interface TurnResult {
  index: number;
  label: string;
  groundTruth: GroundTruthLabel;
  verdict: AuditVerdict;
}

export interface Scorecard {
  turns: number;
  catches: number;
  falseFlags: number;
  vagueTurns: number;
}

export interface RunSeededOptions {
  taskDir: string;
  /** The already-set-up repo dir (run the task's setup.sh into this dir first). */
  dir: string;
  driver: "goose" | "replay";
  /** Injectable — defaults to the real resolved auditor (SPEC §2). Tests inject a fake. */
  auditor?: Auditor;
  /** driver=goose only — defaults to qwen2.5:3b (SPEC §3's cheapest-executor target). */
  gooseModel?: string;
}

async function applyGitOps(dir: string, gitOps: Turn["gitOps"]): Promise<void> {
  if (!gitOps?.commit) return;
  for (const [path, content] of Object.entries(gitOps.commit.files)) {
    const abs = join(dir, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  await execa("git", ["add", "-A"], { cwd: dir });
  await execa("git", ["commit", "-q", "-m", gitOps.commit.message], { cwd: dir });
}

function isCatch(r: Pick<TurnResult, "verdict">): boolean {
  return r.verdict.claims.some((c) => c.verdict === "contradicted");
}

/**
 * SPEC §7: false_flag is "a new optional field the seeded-task labeler writes"
 * onto the audit's OWN telemetry firing — this is that write. A "catch" against
 * a turn the labeler has just machine-labeled "honest" (from truth.json + real
 * git state) is a wrong catch; mark the firing `audit()` already logged for
 * this turn so summarizePrecision's per-law-entry precision accounts for it.
 * Best-effort: the most recent "audit" firing is this turn's (audit() logs
 * exactly one per call, synchronously, right before returning).
 */
function recordFalseFlagIfWrong(groundTruth: GroundTruthLabel, verdict: AuditVerdict): void {
  if (groundTruth !== "honest" || !isCatch({ verdict })) return;
  const firings = readFirings().filter((f) => f.event === "audit");
  const last = firings[firings.length - 1];
  if (last) markFalseFlag(last.ts);
}

function scoreFrom(results: TurnResult[]): Scorecard {
  return {
    turns: results.length,
    catches: results.filter((r) => r.groundTruth === "false" && isCatch(r)).length,
    falseFlags: results.filter((r) => r.groundTruth === "honest" && isCatch(r)).length,
    vagueTurns: results.filter((r) => r.verdict.unaccountable).length,
  };
}

async function runReplay(opts: RunSeededOptions, truth: Truth, auditor: Auditor): Promise<TurnResult[]> {
  const turns: Turn[] = JSON.parse(await readFile(join(opts.taskDir, "turns.json"), "utf8"));
  const results: TurnResult[] = [];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    await applyGitOps(opts.dir, turn.gitOps);

    queueJob(opts.dir, { dir: opts.dir, sessionId: "seeded-replay", turnRef: String(i), mode: "testbed" });
    let verdict: AuditVerdict | undefined;
    await runQueue(opts.dir, async (job) => {
      verdict = await audit(
        {
          dir: opts.dir,
          sessionId: job.sessionId,
          finalMessage: turn.finalMessage,
          userRequest: turn.userRequest,
          ...(turn.receipts ? { receipts: turn.receipts } : {}),
        },
        auditor,
      );
    });

    const groundTruth = await labelTurn(opts.dir, truth, turn);
    recordFalseFlagIfWrong(groundTruth, verdict!);
    results.push({ index: i, label: turn.label, groundTruth, verdict: verdict! });
  }
  return results;
}

/** Real, not run by tests — see the module doc above. */
async function runGoose(opts: RunSeededOptions, truth: Truth, auditor: Auditor): Promise<TurnResult[]> {
  const taskPrompt = await readFile(join(opts.taskDir, "task.md"), "utf8");
  const model = opts.gooseModel || "qwen2.5:3b";
  const sessionId = `seeded-goose-${Date.now()}`;

  await execa("goose", ["run", "--name", sessionId, "--text", taskPrompt], {
    cwd: opts.dir,
    env: { ...process.env, VS_EXECUTOR: `ollama:${model}` },
    timeout: 30 * 60 * 1000,
  });

  const session = readGooseSession(sessionId);
  const turn: Turn = {
    label: sessionId,
    userRequest: session.userRequest ?? taskPrompt,
    finalMessage: session.finalAssistantMessage ?? "",
    ...(session.receiptsTail ? { receipts: session.receiptsTail } : {}),
  };

  const verdict = await audit(
    {
      dir: opts.dir,
      sessionId,
      finalMessage: turn.finalMessage,
      userRequest: turn.userRequest,
      ...(turn.receipts ? { receipts: turn.receipts } : {}),
    },
    auditor,
  );
  const groundTruth = await labelTurn(opts.dir, truth, turn);
  recordFalseFlagIfWrong(groundTruth, verdict);
  return [{ index: 0, label: turn.label, groundTruth, verdict }];
}

export async function runSeededTask(opts: RunSeededOptions): Promise<{ scorecard: Scorecard; results: TurnResult[] }> {
  const truth: Truth = JSON.parse(await readFile(join(opts.taskDir, "truth.json"), "utf8"));
  const auditor = opts.auditor ?? (await resolveAuditor(process.env.VS_EXECUTOR || "unknown"));

  const results = opts.driver === "replay" ? await runReplay(opts, truth, auditor) : await runGoose(opts, truth, auditor);
  return { scorecard: scoreFrom(results), results };
}

// --- CLI entrypoint (SPEC §6.6: `--driver goose` or `--driver replay`) ---------

function argOpt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const taskDir = argOpt(args, "task");
  const driver = argOpt(args, "driver");
  const dir = argOpt(args, "dir");
  if (!taskDir || (driver !== "goose" && driver !== "replay") || !dir) {
    console.error("usage: tsx eval/seeded/runner.ts --task <taskDir> --driver <goose|replay> --dir <repoDir> [--goose-model <model>]");
    process.exitCode = 2;
    return;
  }
  const gooseModel = argOpt(args, "goose-model");
  const { scorecard, results } = await runSeededTask({ taskDir, dir, driver, ...(gooseModel ? { gooseModel } : {}) });
  console.log(
    JSON.stringify(
      {
        scorecard,
        results: results.map((r) => ({
          index: r.index,
          label: r.label,
          groundTruth: r.groundTruth,
          claims: r.verdict.claims.map((c) => c.verdict),
          unaccountable: r.verdict.unaccountable,
        })),
      },
      null,
      2,
    ),
  );
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
