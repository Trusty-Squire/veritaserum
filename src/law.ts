/**
 * Case-law file lifecycle (SPEC.md §2 "Case law", §6.2/§6.4): `veritaserum.law.yaml`,
 * git-tracked, in-repo, reusing the v1 ContractGate schema. Lineage `evaluator-demand`
 * for auditor-authored entries; `user-word` survives for the optional human statute path.
 *
 * The auditor reads law from git HEAD, never the tree copy — the law file is the
 * auditor's OUTPUT, and "law commits are human moments" (R6): this module never runs
 * a git write. `appendDemand`/`retireLaw` only ever touch the working-tree copy; a
 * human (or the `veritaserum retire` CLI case) commits it into canon. Until committed,
 * `loadLaw` will (correctly) report the tree as drifted from HEAD — that is the same
 * signal used to catch executor-authored tampering, because the two cases are
 * indistinguishable from a file diff alone.
 *
 * Statute union (SPEC Appendix "optional statute path"): `contract_propose`/`contract_seal`
 * (propose.ts) still write `contract.yaml` — that machinery is untouched. `loadLaw` unions
 * contract.yaml's active gates (from HEAD, same drift rules as the law file) into the
 * returned law set so runnableChecks/the auditor see statute and precedent as one set.
 * Contract gates already carry their own lineage (typically `source: "user-word"`) from
 * propose.ts/seed.ts — they are not retagged, just folded in.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";

import { showFileAtCommit } from "./git.js";

import { CONTRACT_FILENAME, ContractFileSchema, activeGates, type ContractFile, type ContractGate, type Rung } from "./schema.js";

export const LAW_FILENAME = "veritaserum.law.yaml";

/** Only these rungs bind a runnable check (propose.ts's ladder); the rest are recorded, never enforced. */
const BINDING_RUNGS: ReadonlySet<Rung> = new Set(["analytic", "oracle", "held-out"]);

function lawPath(dir: string): string {
  return join(dir, LAW_FILENAME);
}

// --- load + drift classification ---------------------------------------------

export type LawDrift = "none" | "tree-modified" | "tree-deleted" | "pending-canon";

export interface LoadedLaw {
  /** law.yaml gates unioned with contract.yaml's active gates (the statute path). */
  law: ContractFile;
  /** veritaserum.law.yaml's own HEAD-vs-tree drift. */
  drift: LawDrift;
  /** contract.yaml's own HEAD-vs-tree drift — tracked separately since the two
   *  files are independent git-tracked artifacts that can drift independently. */
  contractDrift: LawDrift;
}

/**
 * Read one ContractFile-shaped YAML file from git HEAD and classify how the
 * working tree relates to it:
 *  - "none":           tree matches HEAD (or both are absent).
 *  - "tree-modified":  HEAD has the file, the tree copy differs — flagged as
 *                       drift for the auditor; HEAD is still what's returned/checked.
 *  - "tree-deleted":   HEAD has the file, the tree copy is gone.
 *  - "pending-canon":  HEAD has no file, the tree has one (uncommitted — a
 *                       human edit, or a fresh appendDemand awaiting commit).
 */
async function loadYamlFileWithDrift(dir: string, filename: string): Promise<{ file: ContractFile; drift: LawDrift }> {
  const headContent = await showFileAtCommit(dir, "HEAD", filename);
  const p = join(dir, filename);
  const treeContent = existsSync(p) ? await readFile(p, "utf8") : null;

  if (headContent === null) {
    if (treeContent !== null) {
      return { file: ContractFileSchema.parse(parseYaml(treeContent)), drift: "pending-canon" };
    }
    return { file: ContractFileSchema.parse({}), drift: "none" };
  }
  const file = ContractFileSchema.parse(parseYaml(headContent));
  if (treeContent === null) return { file, drift: "tree-deleted" };
  // execa (git.ts) strips exactly one trailing newline from `git show` stdout;
  // the tree file still has yaml.stringify's real trailing "\n". Normalize that
  // one byte away so it isn't mistaken for executor/human drift.
  const treeNormalized = treeContent.endsWith("\n") ? treeContent.slice(0, -1) : treeContent;
  return { file, drift: treeNormalized === headContent ? "none" : "tree-modified" };
}

/**
 * Load case law from git HEAD (the only canonical copy) and classify how the
 * working tree relates to it — then union in contract.yaml's active gates
 * (the optional statute path, SPEC Appendix), read with the same HEAD/drift
 * rules, so a sealed statute gate is exactly as visible to runnableChecks/the
 * auditor as an evaluator-demanded precedent.
 */
export async function loadLaw(dir: string): Promise<LoadedLaw> {
  const { file: law, drift } = await loadYamlFileWithDrift(dir, LAW_FILENAME);
  const { file: contract, drift: contractDrift } = await loadYamlFileWithDrift(dir, CONTRACT_FILENAME);
  const statuteGates = activeGates(contract);
  if (!statuteGates.length) return { law, drift, contractDrift };
  return { law: { ...law, gates: [...law.gates, ...statuteGates] }, drift, contractDrift };
}

// --- mechanical rechecks -------------------------------------------------------

/** Active, binding, runnable law entries — the mechanical recheck path (no LLM). */
export function runnableChecks(law: ContractFile): ContractGate[] {
  return law.gates.filter((g) => {
    if (g.lineage.retired) return false;
    if (!g.run || g.run.trim() === "") return false;
    return g.lineage.params?.binding !== false;
  });
}

// --- demand lifecycle -----------------------------------------------------------

export interface DemandInput {
  /** Executable check (shell, exit 0 = pass) — a "runnable check" demand. */
  run?: string;
  /** Named-expectation text — a checklist-only demand (no run command). */
  checklist?: string;
  gatePaths?: string[];
  /** The auditor's claimed rung for this demand (analytic > oracle > held-out bind). */
  rung: Rung;
  /** The claim text that produced this demand — becomes lineage.provenance. */
  originClaim: string;
}

export interface AppendOutcome {
  action: "added" | "duplicate";
  lawId?: string;
  duplicateOf?: string;
}

function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, " ");
}
function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Dedupe key: runnable checks by normalized command, named expectations by slug. */
function dedupeKey(g: { run?: string | null; checklist?: string }): string | null {
  if (g.run && g.run.trim()) return `run:${normalizeCommand(g.run)}`;
  if (g.checklist && g.checklist.trim()) return `named:${slugify(g.checklist)}`;
  return null;
}

let idCounter = 0;
function nextLawId(law: ContractFile): string {
  idCounter += 1;
  return `law${law.gates.length + 1}-${idCounter}`;
}

// Serialize read-modify-write cycles within this process. tmp+rename makes each
// individual write crash-safe, but concurrent callers (e.g. Promise.all appends
// from overlapping audit jobs) still need in-process mutual exclusion or the
// dedupe-then-append read can race and lose an update.
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Atomic write: tmp file + rename — never a half-written law file on crash. */
function writeLawAtomic(dir: string, law: ContractFile): void {
  const p = lawPath(dir);
  const tmp = `${p}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, toYaml(law), "utf8");
  renameSync(tmp, p);
}

/**
 * Append an evaluator demand to the tree copy of the law file, deduping first
 * (SPEC §2/§6.2). Only rungs analytic|oracle|held-out are binding; lower rungs
 * are recorded with `lineage.params.binding=false` (R6). Never commits — law
 * commits are human moments (R6); this only writes the working tree.
 */
export async function appendDemand(dir: string, demand: DemandInput): Promise<AppendOutcome> {
  if (!demand.run && !demand.checklist) {
    throw new Error("appendDemand: demand needs a run command or checklist text");
  }
  return serialize(async () => {
    const p = lawPath(dir);
    const current: ContractFile = existsSync(p)
      ? ContractFileSchema.parse(parseYaml(await readFile(p, "utf8")))
      : ContractFileSchema.parse({});

    const key = dedupeKey(demand);
    const twin = key === null ? undefined : current.gates.find((g) => !g.lineage.retired && dedupeKey(g) === key);
    if (twin) return { action: "duplicate", duplicateOf: twin.id };

    const binding = BINDING_RUNGS.has(demand.rung);
    const gate: ContractGate = {
      id: nextLawId(current),
      run: demand.run ?? null,
      ...(demand.run ? {} : { checklist: demand.checklist! }),
      gatePaths: demand.gatePaths ?? [],
      lineage: {
        pattern: "evaluator-demand",
        params: { rung: demand.rung, binding },
        provenance: demand.originClaim,
        source: "evaluator-demand",
        retired: false,
      },
    };
    current.gates.push(gate);
    writeLawAtomic(dir, current);
    return { action: "added", lawId: gate.id };
  });
}

/**
 * Explicit retirement (R6): marks lineage.retired + retiredBy — recorded, never
 * deleted (mirrors ratchet.ts's retireByProvenance semantics, keyed by law id
 * rather than a provenance substring match). Returns false if the id doesn't
 * exist or is already retired. Never commits — the CLI `retire` case commits.
 */
export async function retireLaw(dir: string, lawId: string, reason: string): Promise<boolean> {
  return serialize(async () => {
    const p = lawPath(dir);
    if (!existsSync(p)) return false;
    const law = ContractFileSchema.parse(parseYaml(await readFile(p, "utf8")));
    const gate = law.gates.find((g) => g.id === lawId);
    if (!gate || gate.lineage.retired) return false;
    gate.lineage.retired = true;
    gate.retiredBy = reason;
    writeLawAtomic(dir, law);
    return true;
  });
}

// Exposed for tests that want to read the raw tree file without going through
// git HEAD (e.g. asserting atomic-append output is valid YAML with no dupes).
export function readLawTreeSync(dir: string): ContractFile | null {
  const p = lawPath(dir);
  if (!existsSync(p)) return null;
  return ContractFileSchema.parse(parseYaml(readFileSync(p, "utf8")));
}
