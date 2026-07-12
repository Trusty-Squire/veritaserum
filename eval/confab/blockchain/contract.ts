/** Contract-first test: does the Knight, authoring gates from the GOAL alone
 *  (no artifact to charitably narrow against), encode the domain standards the
 *  reactive hook missed — peg, finality, determinism, real-TPS? */
import { readFile } from "node:fs/promises";
import { resolveKnight } from "../../../src/resolve.js";

const BASE = "/tmp/claude-1000/-home-lunchbox-proj-veritas/73f33ecf-4ad7-449f-b6ed-087ba59f56ff/scratchpad/blockchain";

async function main() {
  const goal = (await readFile(`${BASE}/spec.txt`, "utf8")).trim();
  const knight = await resolveKnight();
  console.error("Knight authoring gates from the goal (no artifact shown)...");
  const seed = await knight.seed(goal);

  console.log("THESIS:\n  " + seed.thesis + "\n");
  console.log(`GATES AUTHORED: ${seed.gates.length}\n`);
  for (const g of seed.gates) {
    console.log(JSON.stringify(g, null, 2));
    console.log("");
  }
  console.log(`GRADER FILES: ${seed.files.length}`);
  for (const f of seed.files) {
    console.log(`\n----- ${f.path} -----`);
    console.log(f.content.slice(0, 1000));
  }
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
