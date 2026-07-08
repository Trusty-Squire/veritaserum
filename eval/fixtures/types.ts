/**
 * Shared shape for the replay fixtures (SPEC §6.1) — used by both the hermetic
 * pipeline test (test/fixtures.test.ts, a scripted fake auditor) and the real
 * pinned-baseline harness (eval/run-fixtures.ts, the actually-resolved auditor).
 * Self-contained (no dependency on test/helpers.ts) so eval/ scripts can run
 * standalone outside the vitest harness.
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";

/** How the fixture's temp repo should look before the audit runs. */
export interface RepoSetup {
  /** Sequential commits — real committed work (git log/diff --stat will show these). */
  commits?: { message: string; files: Record<string, string> }[];
  /** Files written to the working tree but left uncommitted (a dirty tree, no commit). */
  uncommittedFiles?: Record<string, string>;
}

export type Verdict = "supported" | "unsupported" | "contradicted";

export interface FixtureExpected {
  /**
   * Expect at least one claim verdict in this set. A single string is sugar for a
   * one-element set. A set is the honest pin when more than one verdict is
   * defensible — e.g. a grand claim over an empty stub is legitimately EITHER
   * "unsupported" (no evidence) OR "contradicted" (the stub refutes "works well").
   */
  verdict?: Verdict | Verdict[];
  /** R9: expect verdict.unaccountable === true. */
  unaccountable?: boolean;
  /**
   * Expect a demand to have been appended. `rung` accepts any of a set of binding
   * rungs; `descriptionContains` accepts any-of a set of phrasings (a live auditor
   * expresses the same demand many ways — "fresh probe" / "re-run against current
   * state" — so pin the concept, not one wording).
   */
  demand?: { rung?: string | string[]; descriptionContains?: string | string[] };
  /** Expect some warning line to contain this substring. */
  warningContains?: string;
}

export interface Fixture {
  name: string;
  finalMessage: string;
  userRequest: string;
  receipts?: string;
  repoSetup?: RepoSetup;
  expected: FixtureExpected;
}

/** All eval/fixtures/*.json files, parsed, sorted by filename for a stable order. */
export function loadFixtures(fixturesDir: string = new URL(".", import.meta.url).pathname): Fixture[] {
  return readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(fixturesDir, f), "utf8")) as Fixture);
}

/** A throwaway git repo in the OS temp dir, with the fixture's repoSetup applied. */
export async function fixtureRepo(setup: RepoSetup | undefined): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "vs-fixture-"));
  await execa("git", ["init", "-q"], { cwd: dir });
  await execa("git", ["config", "user.email", "t@t.t"], { cwd: dir });
  await execa("git", ["config", "user.name", "t"], { cwd: dir });
  await execa("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });

  for (const c of setup?.commits ?? []) {
    for (const [path, content] of Object.entries(c.files)) await writeIn(dir, path, content);
    await execa("git", ["add", "-A"], { cwd: dir });
    await execa("git", ["commit", "-q", "-m", c.message], { cwd: dir });
  }
  for (const [path, content] of Object.entries(setup?.uncommittedFiles ?? {})) {
    await writeIn(dir, path, content);
  }

  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function writeIn(dir: string, path: string, content: string): Promise<void> {
  const abs = join(dir, path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}
