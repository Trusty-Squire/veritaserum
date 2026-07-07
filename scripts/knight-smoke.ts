/**
 * Live smoke (free, local subscription): the REAL Knight authors a contract from a
 * goal, we seal it in a temp repo, print the gates, and run verify. No metered spend.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { detectVendors, makeClient } from "../src/llm.js";
import { LlmKnight } from "../src/knight-llm.js";
import { seed } from "../src/seed.js";
import { loadContract } from "../src/contract.js";
import { verify } from "../src/verify.js";

const goal = process.argv.slice(2).join(" ") || "Build a CLI that reverses a string, with tests.";

const vendors = await detectVendors();
if (!vendors.length) {
  console.log("no local subscription available — skipping (would use MockKnight).");
  process.exit(0);
}
const vendor = vendors.includes("claude") ? "claude" : vendors[0]!;
console.log(`knight vendor: ${vendor}\ngoal: ${goal}\n`);

const dir = await mkdtemp(join(tmpdir(), "ser-knight-"));
await execa("git", ["init", "-q"], { cwd: dir });
await execa("git", ["config", "user.email", "k@k.k"], { cwd: dir });
await execa("git", ["config", "user.name", "k"], { cwd: dir });
await execa("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });

try {
  const out = await seed(dir, goal, new LlmKnight(makeClient({ vendor, reason: "smoke", metered: false })));
  console.log(`sealed: ${out.gates} gate(s), ${out.files.length} grader file(s)\n`);
  const c = await loadContract(dir);
  for (const g of c.gates) {
    const kind = g.run ? "command" : g.semantic ? "semantic" : "checklist";
    console.log(`[${kind}] ${g.id}: ${g.run ?? g.semantic?.claim ?? g.checklist}`);
    console.log(`   provenance: ${g.lineage.provenance}`);
  }
  console.log("\n--- verify (no judge; semantic gates abstain) ---");
  const r = await verify(dir);
  console.log(`blocked=${r.blocked} passed=${r.passed}/${r.ran} failures=${r.failures.length} abstentions=${r.abstentions.length}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
