/**
 * `ser seed` (DESIGN §4). Goal -> contract.yaml via the Knight, grader files
 * written and git-sealed, contractCommit recorded so verify can read pristine
 * graders. Seeds a FRESH contract only; corrections go through ratchet/amend.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { contractExists, saveContract } from "./contract.js";
import { commitPaths, isRepo } from "./git.js";
import { MockKnight, type Knight } from "./judge.js";
import { ContractFileSchema, CONTRACT_FILENAME, type ContractFile } from "./schema.js";

export interface SeedOutcome {
  gates: number;
  files: string[];
  contractCommit: string;
}

export class SeedError extends Error {}

export async function seed(dir: string, goal: string, knight: Knight = new MockKnight()): Promise<SeedOutcome> {
  if (!(await isRepo(dir))) throw new SeedError("not a git repository — ser seed needs git for R2 grader integrity");
  if (contractExists(dir)) throw new SeedError("contract.yaml already exists — use `ser ratchet` / `ser amend`, not re-seed");

  const design = await knight.seed(goal);

  // 1. Write grader files.
  const graderPaths: string[] = [];
  for (const f of design.files) {
    const abs = join(dir, f.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, f.content, "utf8");
    graderPaths.push(f.path);
  }

  // 2. Assign ids and write contract.yaml (commit pointer filled after sealing).
  const contract: ContractFile = ContractFileSchema.parse({
    thesis: design.thesis,
    contractCommit: null,
    gates: design.gates.map((g, i) => ({
      id: `g${i + 1}-seed`,
      run: g.run,
      ...(g.checklist ? { checklist: g.checklist } : {}),
      gatePaths: g.gatePaths,
      lineage: g.lineage,
    })),
    repeats: [],
  });
  await saveContract(dir, contract);

  // 3. Seal graders + contract in one commit; that sha is the pristine source.
  const sealed = await commitPaths(dir, [CONTRACT_FILENAME, ...graderPaths], `ser: seal contract for "${goal}"`);

  // 4. Record the pointer and commit it (graders are byte-identical across both
  //    commits, so contractCommit -> sealed graders holds).
  contract.contractCommit = sealed;
  await saveContract(dir, contract);
  await commitPaths(dir, [CONTRACT_FILENAME], "ser: record contractCommit");

  return { gates: contract.gates.length, files: graderPaths, contractCommit: sealed };
}
