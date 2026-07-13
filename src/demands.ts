/**
 * Demands, phase 1 (docs/DEMANDS.md): a demand IS a failing test.
 *
 * The auditor authors `{origin_claim, gap, remedy, accept, test_file, rung}`;
 * this module materializes `test_file` as a standalone exit-code script under
 * test/veritaserum/ (written to the working tree, uncommitted — the commit is
 * the consent checkpoint), and runs committed demand scripts FROM GIT HEAD so
 * a working-tree edit or deletion can never alter the enforcement run. The
 * subject under test is the working tree (the script runs with cwd = repo);
 * only the ORACLE comes from HEAD.
 *
 * Deliberately absent (deferred until the testbed earns them — owner decision
 * 2026-07-12): the debt register, first-green review, distrust states, CI job.
 */
import { existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import type { Rung } from "./propose.js";

export const DEMAND_DIR = "test/veritaserum";

/** One authored demand, as the auditor emits it (auditor.ts `Demand`). */
export interface AuthoredDemand {
  origin_claim: string;
  gap: string;
  remedy: string;
  accept: string;
  /** Standalone exit-code script content (node). Absent → unverifiable. */
  test_file?: string;
  rung: Rung;
}

export type MaterializeAction = "added" | "duplicate" | "discarded_passing" | "unverifiable";

export interface MaterializeOutcome {
  action: MaterializeAction;
  /** Repo-relative script path for added/duplicate. */
  path?: string;
}

export interface HeadDemandResult {
  /** Repo-relative path of the demand script in HEAD. */
  path: string;
  slug: string;
  passed: boolean;
  exitCode: number;
  /** Parsed from the script header — used for the feedback line. */
  remedy?: string;
  accept?: string;
}

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function demandSlug(d: AuthoredDemand): string {
  return slugify(d.gap) || slugify(d.origin_claim) || "demand";
}

/** Header lines are the demand's provenance (docs/DEMANDS.md §2.0: register
 *  deferred, so the script header is the whole record). Parsed back by
 *  parseHeader() for the feedback line — keep the field markers stable. */
function header(d: AuthoredDemand, now: Date): string {
  const line = (k: string, v: string) => `// ${k}: ${v.replace(/\n/g, " ")}`;
  return [
    "// veritaserum demand — a failing test IS the demand. It passes only when",
    "// the acceptance condition below is genuinely met. Deleting or editing this",
    "// file does not change enforcement: the committed (HEAD) version runs.",
    line("origin-claim", d.origin_claim),
    line("gap", d.gap),
    line("remedy", d.remedy),
    line("accept", d.accept),
    line("rung", d.rung),
    line("authored", now.toISOString()),
    "",
  ].join("\n");
}

function parseHeader(content: string): { remedy?: string; accept?: string } {
  const grab = (k: string) => content.match(new RegExp(`^// ${k}: (.*)$`, "m"))?.[1];
  const remedy = grab("remedy");
  const accept = grab("accept");
  return { ...(remedy ? { remedy } : {}), ...(accept ? { accept } : {}) };
}

async function inHead(dir: string, relPath: string): Promise<boolean> {
  const r = await execa("git", ["cat-file", "-e", `HEAD:${relPath}`], { cwd: dir, reject: false });
  return r.exitCode === 0;
}

async function runScript(dir: string, scriptPath: string): Promise<{ passed: boolean; exitCode: number }> {
  const r = await execa("node", [scriptPath], { cwd: dir, reject: false, timeout: 30_000, stdio: "ignore" });
  return { passed: r.exitCode === 0, exitCode: r.exitCode ?? 1 };
}

/**
 * Write one authored demand as a failing script under test/veritaserum/.
 * - no test_file or no accept → "unverifiable": recorded nowhere binding.
 * - slug already on disk or in HEAD → "duplicate" (never overwrite).
 * - the script is run ONCE at authoring time and MUST fail — an
 *   already-passing "demand" discriminates nothing and is discarded
 *   ("discarded_passing"): the one pre-commit execution is of the auditor's
 *   own output, before the executor ever touches it.
 */
export async function materializeDemand(dir: string, d: AuthoredDemand): Promise<MaterializeOutcome> {
  if (!d.test_file?.trim() || !d.accept?.trim()) return { action: "unverifiable" };

  const slug = demandSlug(d);
  const rel = `${DEMAND_DIR}/${slug}.js`;
  const abs = join(dir, rel);
  if (existsSync(abs) || (await inHead(dir, rel))) return { action: "duplicate", path: rel };

  mkdirSync(join(dir, DEMAND_DIR), { recursive: true });
  writeFileSync(abs, header(d, new Date()) + d.test_file, "utf8");

  const probe = await runScript(dir, abs);
  if (probe.passed) {
    rmSync(abs, { force: true }); // passes against the current tree — discriminates nothing
    return { action: "discarded_passing", path: rel };
  }
  return { action: "added", path: rel };
}

/**
 * Run every committed demand script FROM HEAD (git show → temp copy → node,
 * cwd = repo so the working tree is the subject under test). Working-tree
 * edits or deletions of the script are invisible here by construction.
 */
export async function runHeadDemands(dir: string): Promise<HeadDemandResult[]> {
  const ls = await execa("git", ["ls-tree", "--name-only", "HEAD", `${DEMAND_DIR}/`], { cwd: dir, reject: false });
  if (ls.exitCode !== 0 || !ls.stdout.trim()) return [];

  const results: HeadDemandResult[] = [];
  const tmp = mkdtempSync(join(tmpdir(), "vs-demand-"));
  try {
    for (const rel of ls.stdout.split("\n").filter((p) => p.endsWith(".js"))) {
      const show = await execa("git", ["show", `HEAD:${rel}`], { cwd: dir, reject: false });
      if (show.exitCode !== 0) continue;
      const slug = rel.slice(DEMAND_DIR.length + 1, -3);
      const copy = join(tmp, `${slug}.js`);
      writeFileSync(copy, show.stdout, "utf8");
      const r = await runScript(dir, copy);
      results.push({ path: rel, slug, passed: r.passed, exitCode: r.exitCode, ...parseHeader(show.stdout) });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return results;
}
