/**
 * Demands, phase 1 (docs/DEMANDS.md): a demand IS a failing test — stored in
 * veritaserum's OWN state dir, never in the user's repo.
 *
 * The auditor authors `{origin_claim, gap, remedy, accept, test_file, rung}`;
 * this module materializes `test_file` as a standalone exit-code script under
 * <state>/<repoKey>/demands/ and runs it at audit time with cwd = the repo
 * (the repo is the subject under test; the oracle lives outside it). Two
 * properties fall out of the location for free:
 *   - invisible: no vendor directory, no diff noise, nothing to adopt-object to;
 *   - tamper-irrelevant: the script isn't in the executor's tree, so there is
 *     no HEAD-vs-tree dance, no pristine swap, no consent-by-commit ceremony.
 * Veto is a command, not a commit: `veritaserum retire <slug>` (R6) moves the
 * script to retired/ — recorded, never deleted.
 *
 * Deliberately absent (deferred until the testbed earns them — owner decision
 * 2026-07-12): the debt register, first-green review, distrust states, CI job.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { queueRoot } from "./audit-runner.js";
import type { Rung } from "./schema.js";

/** Per-repo demand store, sibling of the queue's state/warnings/feedback dirs. */
export function demandsDir(dir: string): string {
  return join(queueRoot(dir), "demands");
}
function retiredDir(dir: string): string {
  return join(demandsDir(dir), "retired");
}

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
  /** Script path for added/duplicate. */
  path?: string;
}

export interface DemandRunResult {
  slug: string;
  path: string;
  passed: boolean;
  exitCode: number;
  /** Parsed from the script header — used for the feedback line and `veritaserum demands`. */
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

/** Header lines are the demand's whole provenance record (register deferred).
 *  Parsed back by parseHeader() — keep the field markers stable. */
function header(d: AuthoredDemand, now: Date): string {
  const line = (k: string, v: string) => `// ${k}: ${v.replace(/\n/g, " ")}`;
  return [
    "// veritaserum demand — a failing test IS the demand. It passes only when",
    "// the acceptance condition below is genuinely met.",
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

async function runScript(dir: string, scriptPath: string): Promise<{ passed: boolean; exitCode: number }> {
  const r = await execa("node", [scriptPath], { cwd: dir, reject: false, timeout: 30_000, stdio: "ignore" });
  return { passed: r.exitCode === 0, exitCode: r.exitCode ?? 1 };
}

/**
 * Write one authored demand as a failing script into the state dir.
 * - no test_file or no accept → "unverifiable": recorded nowhere binding.
 * - slug already present (active or retired) → "duplicate" (never overwrite,
 *   never resurrect a retired demand).
 * - the script is run ONCE at authoring time and MUST fail — an
 *   already-passing "demand" discriminates nothing and is discarded.
 */
export async function materializeDemand(dir: string, d: AuthoredDemand): Promise<MaterializeOutcome> {
  if (!d.test_file?.trim() || !d.accept?.trim()) return { action: "unverifiable" };

  const slug = demandSlug(d);
  const path = join(demandsDir(dir), `${slug}.js`);
  if (existsSync(path) || existsSync(join(retiredDir(dir), `${slug}.js`))) return { action: "duplicate", path };

  mkdirSync(demandsDir(dir), { recursive: true });
  writeFileSync(path, header(d, new Date()) + d.test_file, "utf8");

  const probe = await runScript(dir, path);
  if (probe.passed) {
    rmSync(path, { force: true }); // passes against the current repo — discriminates nothing
    return { action: "discarded_passing", path };
  }
  return { action: "added", path };
}

/** Run every active demand script against the repo (cwd = repo; the oracle
 *  lives outside it, so nothing the executor does to the tree can alter the
 *  script — only genuinely meeting `accept` turns it green). */
export async function runDemands(dir: string): Promise<DemandRunResult[]> {
  const ddir = demandsDir(dir);
  if (!existsSync(ddir)) return [];
  const results: DemandRunResult[] = [];
  for (const f of readdirSync(ddir).filter((f) => f.endsWith(".js")).sort()) {
    const path = join(ddir, f);
    const r = await runScript(dir, path);
    results.push({ slug: f.slice(0, -3), path, passed: r.passed, exitCode: r.exitCode, ...parseHeader(readFileSync(path, "utf8")) });
  }
  return results;
}

/** R6 veto: retire a demand by slug — moved to retired/, recorded, never deleted. */
export function retireDemand(dir: string, slug: string): boolean {
  const from = join(demandsDir(dir), `${slug}.js`);
  if (!existsSync(from)) return false;
  mkdirSync(retiredDir(dir), { recursive: true });
  renameSync(from, join(retiredDir(dir), `${slug}.js`));
  return true;
}
