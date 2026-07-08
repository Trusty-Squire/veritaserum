/**
 * Pinned-baseline eval harness (SPEC §6.1) — runs the 8 eval/fixtures/*.json
 * scenarios through the REAL resolved auditor (SPEC §2 "Auditor resolution":
 * codex exec / claude -p / a metered model, whatever resolveAuditor() picks
 * for VS_EXECUTOR) and prints a scorecard against each fixture's `expected`.
 *
 * This is the live counterpart to test/fixtures.test.ts's hermetic, scripted
 * pipeline test — it costs real auditor invocations (an LLM call per fixture),
 * so it is NEVER run by CI or by an agent automatically. A human runs it by
 * hand (`npm run eval:fixtures`) to track whether real auditor behavior still
 * matches the pinned baseline as models/prompts change.
 *
 * Never mutates a real repo: each fixture gets its own throwaway temp git repo
 * (eval/fixtures/types.ts's fixtureRepo), same as the hermetic test.
 */
import { audit, type AuditJob, type AuditVerdict } from "../src/auditor.js";
import { resolveAuditor } from "../src/resolve.js";
import { loadFixtures, fixtureRepo, type Fixture, type FixtureExpected } from "./fixtures/types.js";

interface ScoreRow {
  name: string;
  pass: boolean;
  detail: string;
}

function job(dir: string, f: Fixture): AuditJob {
  return {
    dir,
    sessionId: "eval-run-fixtures",
    finalMessage: f.finalMessage,
    userRequest: f.userRequest,
    ...(f.receipts ? { receipts: f.receipts } : {}),
  };
}

function score(f: Fixture, v: AuditVerdict): ScoreRow {
  const expected: FixtureExpected = f.expected;
  const problems: string[] = [];

  if (v.error) problems.push(`verdict.error: ${v.error}`);

  if (expected.verdict) {
    if (!v.claims.some((c) => c.verdict === expected.verdict)) {
      problems.push(`expected some claim verdict="${expected.verdict}", got [${v.claims.map((c) => c.verdict).join(", ")}]`);
    }
  }
  if (expected.unaccountable) {
    if (!v.unaccountable) problems.push(`expected unaccountable=true, got ${v.unaccountable}`);
  }
  if (expected.demand) {
    if (!v.demands.length) {
      problems.push(`expected a demand, got none`);
    } else {
      if (expected.demand.rung && !v.demands.some((d) => d.rung === expected.demand!.rung)) {
        problems.push(`expected a demand with rung="${expected.demand.rung}", got [${v.demands.map((d) => d.rung).join(", ")}]`);
      }
      if (expected.demand.descriptionContains) {
        const needle = expected.demand.descriptionContains.toLowerCase();
        if (!v.demands.some((d) => d.description.toLowerCase().includes(needle))) {
          problems.push(`expected a demand description containing "${expected.demand.descriptionContains}"`);
        }
      }
    }
  }
  if (expected.warningContains) {
    const needle = expected.warningContains.toLowerCase();
    if (!v.warnings.some((w) => w.toLowerCase().includes(needle))) {
      problems.push(`expected a warning containing "${expected.warningContains}"`);
    }
  }

  return { name: f.name, pass: problems.length === 0, detail: problems.join("; ") || "ok" };
}

async function main(): Promise<void> {
  const fixtures = loadFixtures(new URL("./fixtures", import.meta.url).pathname);
  const executor = process.env.VS_EXECUTOR || "unknown";
  const auditor = await resolveAuditor(executor);
  console.log(`eval:fixtures — auditor: ${auditor.vendor}${auditor.model ? `:${auditor.model}` : ""} (tier: ${auditor.tier}${auditor.sameFamily ? ", same-family" : ""})`);
  if (auditor.tier === "absent") {
    console.log("no auditor available (auditor_absent) — nothing to score. Install codex/claude on PATH or set VS_AUDITOR.");
    return;
  }
  console.log("");

  const rows: ScoreRow[] = [];
  for (const f of fixtures) {
    const { dir, cleanup } = await fixtureRepo(f.repoSetup);
    try {
      const v = await audit(job(dir, f), auditor);
      const row = score(f, v);
      rows.push(row);
      console.log(`${row.pass ? "PASS" : "FAIL"}  ${f.name}${row.pass ? "" : ` — ${row.detail}`}`);
    } finally {
      await cleanup();
    }
  }

  const passed = rows.filter((r) => r.pass).length;
  console.log("");
  console.log(`scorecard: ${passed}/${rows.length} fixtures matched their pinned expectation`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
