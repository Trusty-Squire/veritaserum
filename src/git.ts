/**
 * Git helpers for R2 pristine-git integrity. All read-only except `commitPaths`.
 * execa, never string-concatenated commands.
 */
import { execa } from "execa";

export class GitError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const r = await execa("git", args, { cwd, reject: false });
  return { stdout: r.stdout, exitCode: r.exitCode ?? 1 };
}

export async function isRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.exitCode === 0 && r.stdout.trim() === "true";
}

export async function currentCommit(cwd: string): Promise<string> {
  const r = await git(cwd, ["rev-parse", "HEAD"]);
  if (r.exitCode !== 0) throw new GitError("no HEAD commit (empty repo?)");
  return r.stdout.trim();
}

/**
 * The committed content of a path at a commit, or null if the path did not
 * exist there. Null is a meaningful R2 signal: a gatePath absent from the
 * sealed commit is an unsanctioned grader file (the "new bypass file" attack).
 */
export async function showFileAtCommit(cwd: string, commit: string, path: string): Promise<string | null> {
  const r = await git(cwd, ["show", `${commit}:${path}`]);
  if (r.exitCode !== 0) return null;
  return r.stdout;
}

/** True if the working-tree version of `path` differs from its committed blob. */
export async function workingDiffersFromCommit(cwd: string, commit: string, path: string): Promise<boolean> {
  // --quiet exits 1 when there is a diff, 0 when identical.
  const r = await git(cwd, ["diff", "--quiet", commit, "--", path]);
  return r.exitCode !== 0;
}

/** Stage + commit the given paths; returns the new commit sha. */
export async function commitPaths(cwd: string, paths: string[], message: string): Promise<string> {
  const add = await git(cwd, ["add", "--", ...paths]);
  if (add.exitCode !== 0) throw new GitError("git add failed", add.stdout);
  // Allow an empty commit so `ser seed` always yields a sealed commit even if
  // nothing textually changed (idempotent re-seed).
  const commit = await git(cwd, ["commit", "--allow-empty", "-m", message]);
  if (commit.exitCode !== 0) throw new GitError("git commit failed", commit.stdout);
  return currentCommit(cwd);
}
