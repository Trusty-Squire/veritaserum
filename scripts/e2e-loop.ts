/**
 * FULL LOOP, real agent, free (local subscriptions):
 *   1. real Knight (claude) authors the contract from a goal
 *   2. Round 1 — empty repo, agent "claims done" → ser BLOCKS (command gate red)
 *   3. real agent (codex exec, workspace-write) builds to the spec (gate provenances,
 *      NOT the hidden graders — info-flow law)
 *   4. Round 2 — agent claims done → ser verifies: command gate + semantic gate judged
 *      cross-vendor (claude, executor=codex) → pass or an honest block
 *
 * No metered spend. Builder=codex, judge=claude (cross-vendor per policy).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { detectVendors, makeClient } from "../src/llm.js";
import { LlmKnight } from "../src/knight-llm.js";
import { makeSemanticJudge } from "../src/judge-verdict.js";
import { seed } from "../src/seed.js";
import { loadContract, activeGates } from "../src/contract.js";
import { hookStop } from "../src/hook.js";

const goal = "Build a CLI `reverse` so `./reverse abc` prints `cba`. Include a test.";

const vendors = await detectVendors();
if (!(vendors.includes("codex") && vendors.includes("claude"))) {
  console.log(`need both codex+claude subscriptions; have [${vendors.join(",")}]. skipping.`);
  process.exit(0);
}
const judge = makeSemanticJudge(makeClient({ vendor: "claude", reason: "cross-vendor judge (executor=codex)", metered: false }));

const dir = await mkdtemp(join(tmpdir(), "ser-e2e-"));
await execa("git", ["init", "-q"], { cwd: dir });
await execa("git", ["config", "user.email", "e@e.e"], { cwd: dir });
await execa("git", ["config", "user.name", "e"], { cwd: dir });
await execa("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });

function log(s: string) {
  console.log(s);
}

try {
  // 1. seed
  log(`\n=== 1. Knight seeds the contract (claude) ===`);
  await seed(dir, goal, new LlmKnight(makeClient({ vendor: "claude", reason: "knight", metered: false })));
  const c = await loadContract(dir);
  const spec = activeGates(c)
    .map((g) => `- ${g.lineage.provenance}${g.semantic ? ` (claim: ${g.semantic.claim})` : ""}`)
    .join("\n");
  log(`done conditions (spec the agent sees — NOT the graders):\n${spec}`);

  // 2. false done on empty repo
  log(`\n=== 2. Agent claims done on an EMPTY repo → expect BLOCK ===`);
  const d1 = await hookStop(dir, "Done — I implemented reverse and the test passes.", { judge });
  log(`block=${d1.block}`);
  if (d1.reason) log(`reason:\n${d1.reason}`);

  // 3. real agent builds
  log(`\n=== 3. Real agent (codex exec) builds to the spec ===`);
  const buildPrompt =
    `You are working in the current directory. Build this:\n${goal}\n\n` +
    `Done conditions:\n${spec}\n\n` +
    `Create an executable ./reverse (reads its first arg, prints the reversal to stdout) ` +
    `and a test. Do NOT read, run, or modify anything under .veritaserum/ (that is the grader). ` +
    `Make ./reverse executable.`;
  const b = await execa("codex", ["exec", "-s", "workspace-write", buildPrompt], {
    cwd: dir,
    stdin: "ignore",
    reject: false,
    timeout: 300_000,
  });
  log(`codex build exit=${b.exitCode} (${(b.stdout ?? "").length} bytes stdout)`);
  await execa("bash", ["-lc", "ls -la; echo '--- reverse ---'; cat reverse 2>/dev/null | head"], { cwd: dir, reject: false }).then((r) =>
    log(r.stdout),
  );

  // 4. claim done after build
  log(`\n=== 4. Agent claims done after building → ser verifies (real judge) ===`);
  const { verify } = await import("../src/verify.js");
  const vr = await verify(dir, { judge });
  for (const g of activeGates(await loadContract(dir))) {
    const kind = g.run ? "command" : g.semantic ? "semantic" : "checklist";
    const fail = vr.failures.find((f) => f.gateId === g.id);
    const abst = vr.abstentions.find((f) => f.gateId === g.id);
    const status = fail ? `FAIL (${fail.symptom})` : abst ? `ABSTAIN→human (${abst.symptom})` : "PASS";
    log(`  [${kind}] ${g.id}: ${status}`);
  }
  const d2 = await hookStop(dir, "Done — implemented ./reverse and a test; abc reverses to cba.", { judge });
  log(`\nhook decision: block=${d2.block}`);
  if (d2.reason) log(`reason:\n${d2.reason}`);
  else log(`OK — the loop let the agent finish (no gate contradicts the claim).`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
