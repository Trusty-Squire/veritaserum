/**
 * R2 — pristine-git grader integrity (DESIGN §14).
 *
 * The attack (Berkeley RDI, field #1 failure): the executor edits the file that
 * grades it — a `conftest.py` that rewrites results to "passed", a test file
 * softened to always pass, or a NEW bypass grader it commits. As a plug-in we do
 * NOT own the executor's writes, so we cannot prevent the edit. Instead we make it
 * INERT and DETECTED:
 *
 *  - run each gate with its grader files restored to their COMMITTED version
 *    (`contractCommit`), against the WORKING-TREE source under test;
 *  - flag any working-tree divergence on a grader path as a tamper signal
 *    (an executor editing its own grader is itself high-signal gaming).
 *
 * Mechanism: back up the working-tree grader files, overwrite them with their
 * pristine committed blobs (or remove unsanctioned ones), run, then restore in a
 * `finally`. Source files are never touched — only the graders swap. No world-copy.
 *
 * One documented risk: a hard crash between overwrite and restore leaves graders
 * at their committed version on disk (recoverable with `git checkout`).
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { showFileAtCommit, workingDiffersFromCommit } from "./git.js";

export interface TamperFlag {
  path: string;
  kind: "edited" | "unsanctioned" | "deleted";
  detail: string;
}

interface Backup {
  path: string;
  existedBefore: boolean;
  before: string | null;
}

async function readIfExists(abs: string): Promise<string | null> {
  return existsSync(abs) ? readFile(abs, "utf8") : null;
}

/**
 * Detect tamper on the grader paths and run `fn` with pristine graders in place.
 * Returns fn's result plus the tamper flags. Always restores the working tree.
 */
export async function withPristineGraders<T>(
  dir: string,
  commit: string,
  gatePaths: string[],
  fn: () => Promise<T>,
): Promise<{ result: T; tamper: TamperFlag[] }> {
  const tamper: TamperFlag[] = [];
  const backups: Backup[] = [];

  try {
    for (const path of gatePaths) {
      const abs = join(dir, path);
      const before = await readIfExists(abs);
      backups.push({ path, existedBefore: before !== null, before });

      const pristine = await showFileAtCommit(dir, commit, path);

      if (pristine === null) {
        // Not sealed in the contract commit. If it exists in the working tree it
        // is an unsanctioned grader file (the "new bypass file" attack) — remove
        // it for the run so it cannot influence the verdict.
        if (before !== null) {
          tamper.push({ path, kind: "unsanctioned", detail: "grader file not present in the sealed contract commit" });
          await rm(abs, { force: true });
        }
        continue;
      }

      // Sealed grader: flag any working-tree divergence, then restore pristine.
      if (await workingDiffersFromCommit(dir, commit, path)) {
        tamper.push({
          path,
          kind: before === null ? "deleted" : "edited",
          detail: before === null ? "grader file deleted in working tree" : "grader file edited in working tree",
        });
      }
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, pristine, "utf8");
    }

    const result = await fn();
    return { result, tamper };
  } finally {
    // Restore working-tree grader files exactly as they were.
    for (const b of backups) {
      const abs = join(dir, b.path);
      if (b.existedBefore) {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, b.before ?? "", "utf8");
      } else if (existsSync(abs)) {
        await rm(abs, { force: true });
      }
    }
  }
}
