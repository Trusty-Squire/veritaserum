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
 * Provenance and a generic state-oracle locator are also written into the
 * git-tracked law register; the hidden executable bytes are not. First-green
 * review, distrust states, and a dedicated CI job remain deferred.
 */
import { createHash } from "node:crypto";
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

export type MaterializeAction = "added" | "duplicate" | "discarded_passing" | "discarded_invalid" | "unverifiable";

export interface MaterializeOutcome {
  action: MaterializeAction;
  /** Script path for added/duplicate. */
  path?: string;
  /** Stable key shared by the state-owned oracle and its law-file record. */
  slug?: string;
}

export interface DemandRunResult {
  slug: string;
  path: string;
  passed: boolean;
  exitCode: number;
  /** Parsed from the script header — used for the feedback line and `veritaserum demands`. */
  remedy?: string;
  accept?: string;
  originClaim?: string;
  gap?: string;
}

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Slugs are capped at 60 chars, but two distinct gap sentences can share their
 *  first 60 characters — a bare truncation silently drops the second demand as a
 *  "duplicate". A content hash suffix keeps truncated slugs stable AND distinct;
 *  short slugs keep their historical unhashed form. */
export function demandSlug(d: AuthoredDemand): string {
  const raw = slugify(d.gap) || slugify(d.origin_claim) || "demand";
  if (raw.length <= 60) return raw;
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  return `${raw.slice(0, 51).replace(/-+$/, "")}-${hash}`;
}

/** Header lines are the demand's whole provenance record (register deferred).
 *  Parsed back by parseHeader() — keep the field markers stable. */
/**
 * Node only tolerates a shebang on LINE 1. We prepend a provenance header, so an
 * authored script that opens with `#!/usr/bin/env node` — the natural thing to write when
 * you are asked for "a standalone node script" — lands its shebang mid-file and dies with
 * `SyntaxError: Invalid or unexpected token`. The demand then reports UNMET forever, no
 * matter what the executor does: an oracle that cannot pass discriminates nothing, and the
 * whole "a demand IS a failing test" mechanism silently rots. Strip it.
 */
function stripShebang(src: string): string {
  return src.replace(/^\s*#![^\n]*\n?/, "");
}

/** A demand that runs the demand runner necessarily invokes itself. Reject the
 * real shapes auditors have authored before executing even one child. */
function selfInvokesDemandRunner(source: string): boolean {
  return (
    /\b(?:veritaserum|ser)\s+demands\b/i.test(source) ||
    /\b(?:spawnSync|spawn|execFileSync|execFile)\s*\([\s\S]{0,1200}?["'`]demands["'`]/i.test(source)
  );
}

/**
 * A demand executes outside the user's package graph, but its file still sits beneath
 * veritaserum's ESM package boundary. Real auditors overwhelmingly author either
 * CommonJS (`require`) or ESM (`import`) scripts. Give each dialect an unambiguous Node
 * extension instead of saving both as `.js` and inheriting the nearest package.json.
 */
function scriptExtension(source: string): ".cjs" | ".mjs" {
  const body = stripShebang(source);
  const usesEsm =
    /(^|\n)\s*(?:import\s+(?:["'{*]|[\w$]+\s+from\s+)|export\s+)/m.test(body) || /\bimport\.meta\b/.test(body);
  return usesEsm ? ".mjs" : ".cjs";
}

const SCRIPT_EXTENSIONS = [".cjs", ".mjs", ".js"] as const;

function demandPathForSlug(dir: string, slug: string, retired = false): string | undefined {
  const root = retired ? retiredDir(dir) : demandsDir(dir);
  return SCRIPT_EXTENSIONS.map((extension) => join(root, `${slug}${extension}`)).find(existsSync);
}

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

function parseHeader(content: string): { remedy?: string; accept?: string; originClaim?: string; gap?: string } {
  const grab = (k: string) => content.match(new RegExp(`^// ${k}: (.*)$`, "m"))?.[1];
  const remedy = grab("remedy");
  const accept = grab("accept");
  const originClaim = grab("origin-claim");
  const gap = grab("gap");
  return {
    ...(remedy ? { remedy } : {}),
    ...(accept ? { accept } : {}),
    ...(originClaim ? { originClaim } : {}),
    ...(gap ? { gap } : {}),
  };
}

async function runScript(
  dir: string,
  scriptPath: string,
): Promise<{ passed: boolean; exitCode: number; interpreterCrash: boolean; timedOut: boolean }> {
  // Execute the state-owned source on stdin. For ESM, Node then assigns
  // `import.meta.url` to <repo>/[eval1]; for CommonJS, `__dirname` is `.`. That
  // makes the documented cwd contract true even when an authored script derives
  // its repository root from module location — a common real-auditor shape.
  const source = readFileSync(scriptPath, "utf8");
  if (selfInvokesDemandRunner(source)) {
    return { passed: false, exitCode: 1, interpreterCrash: true, timedOut: false };
  }
  const inputType = scriptPath.endsWith(".mjs") ? "module" : "commonjs";
  const recursionSentinel = `${scriptPath}.recursion-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const r = await execa("node", [`--input-type=${inputType}`], {
    cwd: dir,
    env: {
      ...process.env,
      VS_DEMAND_PATH: scriptPath,
      VS_REPO_DIR: dir,
      VS_DEMAND_EVALUATION_SENTINEL: recursionSentinel,
    },
    input: source,
    reject: false,
    timeout: 30_000,
  });
  const stderr = r.stderr || "";
  const recursed = existsSync(recursionSentinel);
  rmSync(recursionSentinel, { force: true });
  const interpreterCrash = recursed ||
    /SyntaxError:|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find module|bad interpreter|ReferenceError: require is not defined/i.test(
      stderr,
    );
  const timedOut = r.timedOut ?? false;
  return { passed: r.exitCode === 0 && !timedOut, exitCode: r.exitCode ?? 1, interpreterCrash, timedOut };
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
  if (selfInvokesDemandRunner(d.test_file)) return { action: "discarded_invalid", slug: demandSlug(d) };

  const slug = demandSlug(d);
  const existing = demandPathForSlug(dir, slug) ?? demandPathForSlug(dir, slug, true);
  if (existing) return { action: "duplicate", path: existing, slug };

  const path = join(demandsDir(dir), `${slug}${scriptExtension(d.test_file)}`);

  mkdirSync(demandsDir(dir), { recursive: true });
  writeFileSync(path, header(d, new Date()) + stripShebang(d.test_file), "utf8");

  const probe = await runScript(dir, path);
  if (probe.interpreterCrash || probe.timedOut) {
    // A hung oracle is as useless as a crashing one — and once law-registered it
    // would cost the full gate timeout on every subsequent audit.
    rmSync(path, { force: true });
    return { action: "discarded_invalid", path, slug };
  }
  if (probe.passed) {
    rmSync(path, { force: true }); // passes against the current repo — discriminates nothing
    return { action: "discarded_passing", path, slug };
  }
  return { action: "added", path, slug };
}

/**
 * Portable law-file locator for a state-owned demand. It embeds only the slug
 * and generic state lookup/runner — never the hidden oracle bytes. If state is
 * absent on another machine the check fails closed as unmet instead of silently
 * passing or copying a test into the user's repository.
 */
export function demandLawCommand(slug: string): string {
  // Mirrors runScript's guards — pre-execution self-invocation screening, a
  // recursion sentinel, a 30s timeout, and the VS_DEMAND_* env contract — since
  // once a demand is law-registered this embedded runner is its ONLY execution
  // path. Must stay free of literal single quotes (the whole runner is
  // single-quoted for the shell): a unicode escape stands in inside the regex.
  const runner = [
    'const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto"),cp=require("node:child_process");',
    'const cwd=process.cwd(),key=crypto.createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0,16);',
    'const root=process.env.VS_QUEUE_ROOT||path.join(os.homedir(),".veritaserum","queue");',
    'const base=path.join(root,key,"demands"),slug=process.argv[1];',
    'const file=[".cjs",".mjs",".js"].map(x=>path.join(base,slug+x)).find(fs.existsSync);',
    'if(!file)process.exit(1);',
    'const src=fs.readFileSync(file,"utf8");',
    'if(/\\b(?:veritaserum|ser)\\s+demands\\b/i.test(src)||/\\b(?:spawnSync|spawn|execFileSync|execFile)\\s*\\([\\s\\S]{0,1200}?["\\u0027`]demands["\\u0027`]/i.test(src))process.exit(1);',
    'const type=file.endsWith(".mjs")?"module":"commonjs";',
    'const sentinel=file+".recursion-"+process.pid+"-"+Date.now();',
    'const r=cp.spawnSync(process.execPath,["--input-type="+type],{cwd,input:src,stdio:["pipe","inherit","inherit"],timeout:30000,env:{...process.env,VS_DEMAND_PATH:file,VS_REPO_DIR:cwd,VS_DEMAND_EVALUATION_SENTINEL:sentinel}});',
    'const recursed=fs.existsSync(sentinel);',
    'try{fs.rmSync(sentinel,{force:true})}catch{}',
    'if(recursed)process.exit(1);',
    'process.exit(r.status??1);',
  ].join("");
  return `node -e '${runner}' '${slug}'`;
}

/** Run every active demand script against the repo (cwd = repo; the oracle
 *  lives outside it, so nothing the executor does to the tree can alter the
 *  script — only genuinely meeting `accept` turns it green). */
export async function runDemands(dir: string): Promise<DemandRunResult[]> {
  const ddir = demandsDir(dir);
  if (!existsSync(ddir)) return [];
  const results: DemandRunResult[] = [];
  for (const f of readdirSync(ddir).filter((f) => /\.(?:cjs|mjs|js)$/.test(f)).sort()) {
    const path = join(ddir, f);
    const r = await runScript(dir, path);
    results.push({
      slug: f.replace(/\.(?:cjs|mjs|js)$/, ""),
      path,
      passed: r.passed,
      exitCode: r.exitCode,
      ...parseHeader(readFileSync(path, "utf8")),
    });
  }
  return results;
}

/** R6 veto: retire a demand by slug — moved to retired/, recorded, never deleted. */
export function retireDemand(dir: string, slug: string): boolean {
  const from = demandPathForSlug(dir, slug);
  if (!from) return false;
  mkdirSync(retiredDir(dir), { recursive: true });
  renameSync(from, join(retiredDir(dir), from.slice(from.lastIndexOf("/") + 1)));
  return true;
}
