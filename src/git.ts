/**
 * Git helpers for R2 pristine-git integrity. All read-only except `commitPaths`.
 * execa, never string-concatenated commands.
 */
import { createHash } from "node:crypto";
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

/** Make `cwd` a git repo if it isn't already — R2 grader integrity needs git, and a
 *  fresh task work dir often isn't a repo yet. Idempotent; a no-op inside an existing repo. */
export async function ensureRepo(cwd: string): Promise<boolean> {
  if (await isRepo(cwd)) return false;
  if ((await git(cwd, ["init", "-q"])).exitCode !== 0) throw new GitError("git init failed", cwd);
  await git(cwd, ["config", "user.email", "veritaserum@local"]);
  await git(cwd, ["config", "user.name", "veritaserum"]);
  await git(cwd, ["commit", "-q", "--allow-empty", "-m", "ser: init for contract integrity"]);
  return true;
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

/**
 * Combined hash of `git status --porcelain` + `git diff HEAD` — a cheap proxy
 * (two git calls, <50ms budget) for "has anything in the tree changed since
 * we last looked," tracked or not. `git diff HEAD` alone is blind to untracked
 * files, which is exactly the shape of a "wrote a new module" turn — the
 * porcelain status closes that gap.
 */
export async function currentTreeHash(cwd: string): Promise<string> {
  const status = await git(cwd, ["status", "--porcelain"]);
  const diff = await git(cwd, ["diff", "HEAD"]);
  return createHash("sha256").update(status.stdout).update("\0").update(diff.stdout).digest("hex");
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
