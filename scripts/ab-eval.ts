/**
 * P3 A/B — the falsification test. Does ser reduce defects-shipped and churn vs a
 * bare agent? One goal, two arms, an IDENTICAL hidden oracle (a ser contract) used
 * only for MEASUREMENT so the comparison is fair.
 *
 *   OFF: agent builds from the GOAL only, claims done. Measured by the hidden oracle.
 *        → defects that would ship under a bare "agent says done".
 *   ON : agent builds from goal + gate PROVENANCES (ser supplies the spec), ser blocks
 *        a false done and feeds the symptom back, up to K rounds. → rounds + residual.
 *
 * Free: claude authors + judges; codex builds. Run one goal per invocation (argv index)
 * so a /loop can accumulate across goals. Appends to ab-results.jsonl.
 */
import { mkdtemp, rm, writeFile, mkdir, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { detectVendors, makeClient } from "../src/llm.js";
import { LlmKnight } from "../src/knight-llm.js";
import { makeSemanticJudge, type SemanticJudge } from "../src/judge-verdict.js";
import { seed } from "../src/seed.js";
import { loadContract, activeGates } from "../src/contract.js";
import { verify } from "../src/verify.js";
import type { ContractFile } from "../src/schema.js";
import { commitPaths } from "../src/git.js";
import { saveContract } from "../src/contract.js";

const GOALS = [
  "Build a CLI `reverse` so `./reverse abc` prints `cba`. Include a test.",
  "Build a CLI `fizzbuzz` that prints numbers 1..15, but `Fizz` for multiples of 3, `Buzz` for 5, `FizzBuzz` for both. Include a test.",
  "Build a CLI `celsius2f` so `./celsius2f 100` prints `212`. Include a test.",
  "Build a CLI `wordcount` so `./wordcount FILE` prints the number of whitespace-separated words in FILE. Include a test.",
];

const idx = Number(process.argv[2] ?? "0");
const goalMaybe = GOALS[idx];
const RESULTS = join(process.env.HOME!, "proj-ser", "projects", "ab-results.jsonl");
const K = 2; // bounded ON-arm rounds
const STAMP = process.argv[3] ?? "unstamped"; // caller passes a timestamp (no Date in-script policy elsewhere)

if (!goalMaybe) {
  console.log(`no goal at index ${idx} (have ${GOALS.length})`);
  process.exit(0);
}
const goal: string = goalMaybe;
const vendors = await detectVendors();
if (!(vendors.includes("codex") && vendors.includes("claude"))) {
  console.log(`need codex+claude; have [${vendors.join(",")}]`);
  process.exit(0);
}
const judge: SemanticJudge = makeSemanticJudge(makeClient({ vendor: "claude", reason: "ab judge", metered: false }));

async function newRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ser-ab-"));
  await execa("git", ["init", "-q"], { cwd: dir });
  await execa("git", ["config", "user.email", "ab@ab.ab"], { cwd: dir });
  await execa("git", ["config", "user.name", "ab"], { cwd: dir });
  await execa("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

/** Install a pre-authored contract + graders into a fresh repo and seal it. */
async function installContract(dir: string, contract: ContractFile, graders: { path: string; content: string }[]): Promise<void> {
  const paths: string[] = [];
  for (const g of graders) {
    const abs = join(dir, g.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, g.content, "utf8");
    paths.push(g.path);
  }
  const fresh: ContractFile = { ...contract, contractCommit: null };
  await saveContract(dir, fresh);
  const sha = await commitPaths(dir, ["contract.yaml", ...paths], "ab: install contract");
  fresh.contractCommit = sha;
  await saveContract(dir, fresh);
  await commitPaths(dir, ["contract.yaml"], "ab: record contractCommit");
}

async function build(dir: string, prompt: string): Promise<void> {
  await execa("codex", ["exec", "-s", "workspace-write", prompt], { cwd: dir, stdin: "ignore", reject: false, timeout: 300_000 });
}

async function run() {
  // 1. Author the oracle ONCE (claude Knight). Both arms share it.
  const seedDir = await newRepo();
  await seed(seedDir, goal, new LlmKnight(makeClient({ vendor: "claude", reason: "ab knight", metered: false })));
  const contract = await loadContract(seedDir);
  const graders = activeGates(contract).flatMap((g) => g.gatePaths).map((p) => ({ path: p, content: "" }));
  // read grader contents from seedDir
  const { readFile } = await import("node:fs/promises");
  for (const gr of graders) gr.content = await readFile(join(seedDir, gr.path), "utf8");
  const spec = activeGates(contract)
    .map((g) => `- ${g.lineage.provenance}${g.semantic ? ` (claim: ${g.semantic.claim})` : ""}`)
    .join("\n");
  await rm(seedDir, { recursive: true, force: true });

  const IGNORE = "Do NOT read, run, or modify anything under .ser/ (that is the grader).";

  // 2. OFF arm — build from the goal only.
  const off = await newRepo();
  await installContract(off, contract, graders);
  await build(off, `Working in the current directory, build this:\n${goal}\n${IGNORE}\nMake any CLI executable.`);
  const offV = await verify(off, { judge });
  const defectsOff = offV.failures.map((f) => f.gateId);
  await rm(off, { recursive: true, force: true });

  // 3. ON arm — build from goal + provenances, ser-enforced, up to K rounds.
  // ONE verify per round drives BOTH the block decision and the defect measurement
  // (no double-judge: the enforcement pass IS the measurement, so a nondeterministic
  // judge can't disagree with itself across two calls).
  const on = await newRepo();
  await installContract(on, contract, graders);
  let rounds = 0;
  let lastSymptom = "";
  let onV = await verify(on, { judge }); // pre-build baseline (all red)
  for (let r = 1; r <= K; r++) {
    rounds = r;
    const prompt =
      `Working in the current directory, build this:\n${goal}\n\nDone conditions:\n${spec}\n` +
      (lastSymptom ? `\nA prior attempt was rejected:\n${lastSymptom}\nFix it.\n` : "") +
      `${IGNORE}\nMake any CLI executable.`;
    await build(on, prompt);
    onV = await verify(on, { judge });
    if (!onV.blocked) break;
    lastSymptom = onV.failures.map((f) => `- ${f.gateId}: ${f.symptom ?? "failed"}`).join("\n");
  }
  const defectsOn = onV.failures.map((f) => f.gateId);
  const blocked = onV.blocked;
  await rm(on, { recursive: true, force: true });

  const result = {
    stamp: STAMP,
    idx,
    goal,
    gates: activeGates(contract).length,
    off: { defects: defectsOff.length, gateIds: defectsOff },
    on: { rounds, defects: defectsOn.length, gateIds: defectsOn, converged: !blocked },
  };
  await mkdir(dirname(RESULTS), { recursive: true });
  await appendFile(RESULTS, JSON.stringify(result) + "\n");
  console.log(JSON.stringify(result, null, 2));
}

await run();
