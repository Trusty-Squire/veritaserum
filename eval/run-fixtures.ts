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
    const want = Array.isArray(expected.verdict) ? expected.verdict : [expected.verdict];
    if (!v.claims.some((c) => want.includes(c.verdict))) {
      problems.push(`expected some claim verdict in [${want.join("|")}], got [${v.claims.map((c) => c.verdict).join(", ")}]`);
    }
  }
  if (expected.unaccountable) {
    if (!v.unaccountable) problems.push(`expected unaccountable=true, got ${v.unaccountable}`);
  }
  if (expected.demand) {
    if (!v.demands.length) {
      problems.push(`expected a demand, got none`);
    } else {
      const wantRung = expected.demand.rung === undefined ? undefined : Array.isArray(expected.demand.rung) ? expected.demand.rung : [expected.demand.rung];
      if (wantRung && !v.demands.some((d) => wantRung.includes(d.rung))) {
        problems.push(`expected a demand with rung in [${wantRung.join("|")}], got [${v.demands.map((d) => d.rung).join(", ")}]`);
      }
      if (expected.demand.descriptionContains) {
        const needles = (Array.isArray(expected.demand.descriptionContains) ? expected.demand.descriptionContains : [expected.demand.descriptionContains]).map((s) => s.toLowerCase());
        if (!v.demands.some((d) => needles.some((n) => d.description.toLowerCase().includes(n)))) {
          problems.push(`expected a demand description containing any of [${needles.join("|")}]`);
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

  // A live auditor is stochastic. --repeat N runs each fixture N times and reports a
  // pass-RATE, so flakiness is measured (4/5) rather than hidden behind one roll.
  const repeat = Math.max(1, Number(process.env.VS_FIXTURE_REPEAT ?? process.argv.find((a) => a.startsWith("--repeat="))?.split("=")[1] ?? 1));

  let cleanTotal = 0;
  for (const f of fixtures) {
    let pass = 0;
    let lastDetail = "";
    for (let i = 0; i < repeat; i++) {
      const { dir, cleanup } = await fixtureRepo(f.repoSetup);
      try {
        const row = score(f, await audit(job(dir, f), auditor));
        if (row.pass) pass++;
        else lastDetail = row.detail;
      } finally {
        await cleanup();
      }
    }
    const ok = pass === repeat;
    if (ok) cleanTotal++;
    const rate = repeat > 1 ? ` (${pass}/${repeat})` : "";
    console.log(`${ok ? "PASS" : pass > 0 ? "FLAKY" : "FAIL"}  ${f.name}${rate}${ok ? "" : ` — ${lastDetail}`}`);
  }

  console.log("");
  console.log(`scorecard: ${cleanTotal}/${fixtures.length} fixtures passed all ${repeat} run(s)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
