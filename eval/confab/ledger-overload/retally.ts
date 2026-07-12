/**
 * retally.ts — re-grade an ALREADY-COMPLETED ledger-overload run's scorecard.json
 * under the upgraded, claim-level grading (runner.ts's `flaggedClaimsFor` /
 * `crossCheckClaim`), without re-running the live goose/DeepSeek session.
 *
 * Usage: tsx eval/confab/ledger-overload/retally.ts <scorecardPath> <workDir>
 *
 * Ground truth for a turn's flagged claims: this scorecard.json's own per-turn
 * `groundTruth` field (the hidden suite's own output, recorded LIVE at that
 * point in the run — see runner.ts's `runHiddenSuite`) is used when present —
 * that is more accurate than judging every turn against only the run's FINAL
 * state, because a turn's claim must be judged against the state THAT TURN
 * actually left behind (e.g. a turn-2 regression the run went on to fix by
 * turn 4 must still count as a true catch at turn 2, not be washed out by a
 * later fix). A FRESH hidden-suite run against the given work dir (the run's
 * final state) is what's used as a FALLBACK for any turn missing its own
 * recorded groundTruth, and is always also run and printed for transparency —
 * satisfying the literal ask ("run the hidden suite on the work dir") and
 * giving an independent sanity check (it should match the last turn's own
 * recorded groundTruth when the run completed cleanly).
 */
import { readFile } from "node:fs/promises";
import { execa } from "execa";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { flaggedClaimsFor, type FlaggedClaimRecord } from "./runner.js";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));

interface ScorecardTurn {
  n: number;
  elicits?: string[];
  groundTruth?: Record<string, boolean>;
  allPass?: boolean;
  agentFinal?: string;
  claims: { claim: string; verdict: "supported" | "unsupported" | "contradicted" }[];
  flagged?: boolean;
}

interface RetalliedTurn {
  n: number;
  flaggedClaims: FlaggedClaimRecord[];
  usedGroundTruth: "recorded" | "final-work-dir-fallback";
}

async function runHiddenSuite(dir: string): Promise<Record<string, boolean>> {
  const hiddenSuitePath = join(SELF_DIR, "hidden-suite", "run.js");
  const r = await execa("node", [hiddenSuitePath, dir], { reject: false });
  try {
    return JSON.parse((r.stdout ?? "").trim() || "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const [scorecardPath, workDir] = process.argv.slice(2);
  if (!scorecardPath || !workDir) {
    console.error("usage: tsx eval/confab/ledger-overload/retally.ts <scorecardPath> <workDir>");
    process.exitCode = 2;
    return;
  }

  const raw = JSON.parse(await readFile(scorecardPath, "utf8")) as { turns: ScorecardTurn[] };
  const finalGroundTruth = await runHiddenSuite(workDir);

  const turns: RetalliedTurn[] = raw.turns.map((t) => {
    const usedGroundTruth = t.groundTruth ? "recorded" : "final-work-dir-fallback";
    const groundTruth = t.groundTruth ?? finalGroundTruth;
    return { n: t.n, flaggedClaims: flaggedClaimsFor(t.claims, groundTruth), usedGroundTruth };
  });

  const allFlaggedClaims = turns.flatMap((t) => t.flaggedClaims);
  const claimLevelConfabs = {
    flaggedTurns: turns.filter((t) => t.flaggedClaims.length > 0).length,
    flaggedClaimsTotal: allFlaggedClaims.length,
    trueCatches: allFlaggedClaims.filter((c) => c.crossCheck === "true-catch").length,
    possibleFalseFlags: allFlaggedClaims.filter((c) => c.crossCheck === "possible-false-flag").length,
    humanReview: allFlaggedClaims.filter((c) => c.crossCheck === "human-review").length,
  };

  console.log(
    JSON.stringify(
      {
        scorecardPath,
        workDir,
        finalGroundTruth,
        claimLevelConfabs,
        turns: turns.filter((t) => t.flaggedClaims.length > 0),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
