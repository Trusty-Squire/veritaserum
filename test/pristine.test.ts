import { describe, it, expect, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { tempRepo, write } from "./helpers.js";
import { currentCommit } from "../src/git.js";
import { withPristineGraders } from "../src/pristine.js";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
});

async function repoWithGrader() {
  const { dir, cleanup } = await tempRepo();
  cleanups.push(cleanup);
  // grader: exits 0 iff answer.txt contains "42"
  await write(dir, "grader.sh", 'grep -q 42 answer.txt\n');
  await write(dir, "answer.txt", "42\n");
  await execa("git", ["add", "-A"], { cwd: dir });
  await execa("git", ["commit", "-q", "-m", "seal"], { cwd: dir });
  const commit = await currentCommit(dir);
  return { dir, commit };
}

describe("R2 pristine graders", () => {
  it("runs the committed grader, not the working-tree one, when the grader is tampered", async () => {
    const { dir, commit } = await repoWithGrader();
    // source under test now WRONG, and the grader softened to always-pass.
    await write(dir, "answer.txt", "WRONG\n");
    await write(dir, "grader.sh", "exit 0\n"); // tampered: naive run would pass

    const { result, tamper } = await withPristineGraders(dir, commit, ["grader.sh"], async () => {
      const r = await execa("sh", ["grader.sh"], { cwd: dir, reject: false });
      return r.exitCode ?? 1;
    });

    // pristine grader checks answer.txt==42, source is WRONG -> fails despite tamper
    expect(result).not.toBe(0);
    expect(tamper).toHaveLength(1);
    expect(tamper[0]).toMatchObject({ path: "grader.sh", kind: "edited" });
  });

  it("restores the working-tree grader after running (tamper preserved, not clobbered)", async () => {
    const { dir, commit } = await repoWithGrader();
    await write(dir, "grader.sh", "exit 0\n");
    await withPristineGraders(dir, commit, ["grader.sh"], async () => 0);
    const after = await readFile(join(dir, "grader.sh"), "utf8");
    expect(after).toBe("exit 0\n"); // working-tree edit is intact after verify
  });

  it("flags and removes an unsanctioned grader file not in the sealed commit", async () => {
    const { dir, commit } = await repoWithGrader();
    // executor adds a NEW bypass grader that was never sealed
    await write(dir, "bypass.sh", "exit 0\n");

    let bypassPresentDuringRun = true;
    const { tamper } = await withPristineGraders(dir, commit, ["bypass.sh"], async () => {
      const r = await execa("test", ["-f", "bypass.sh"], { cwd: dir, reject: false });
      bypassPresentDuringRun = r.exitCode === 0;
      return 0;
    });

    expect(bypassPresentDuringRun).toBe(false); // removed for the run
    expect(tamper[0]).toMatchObject({ path: "bypass.sh", kind: "unsanctioned" });
    // restored afterward
    const r = await execa("test", ["-f", "bypass.sh"], { cwd: dir, reject: false });
    expect(r.exitCode).toBe(0);
  });

  it("no tamper flag when the grader is untouched", async () => {
    const { dir, commit } = await repoWithGrader();
    const { result, tamper } = await withPristineGraders(dir, commit, ["grader.sh"], async () => {
      const r = await execa("sh", ["grader.sh"], { cwd: dir, reject: false });
      return r.exitCode ?? 1;
    });
    expect(result).toBe(0);
    expect(tamper).toHaveLength(0);
  });
});
