/**
 * Contract file mechanics: load / save / activeGates.
 * Pure I/O + filtering; no LLM, no git. Ported from proj-cs contract-file.ts.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { ContractFileSchema, CONTRACT_FILENAME, type ContractFile, type ContractGate } from "./schema.js";

export function contractPath(dir: string): string {
  return join(dir, CONTRACT_FILENAME);
}

export async function loadContract(dir: string): Promise<ContractFile> {
  const p = contractPath(dir);
  if (!existsSync(p)) return ContractFileSchema.parse({});
  return ContractFileSchema.parse(parseYaml(await readFile(p, "utf8")));
}

export function contractExists(dir: string): boolean {
  return existsSync(contractPath(dir));
}

export async function saveContract(dir: string, c: ContractFile): Promise<void> {
  await writeFile(contractPath(dir), toYaml(c), "utf8");
}

/** Active = binding now. Retired gates are history, never deleted. */
export function activeGates(c: ContractFile): ContractGate[] {
  return c.gates.filter((g) => !g.lineage.retired);
}

/** All grader files across active gates (deduped) — the R2 protection set. */
export function activeGatePaths(c: ContractFile): string[] {
  const set = new Set<string>();
  for (const g of activeGates(c)) for (const p of g.gatePaths) set.add(p);
  return [...set];
}

let idCounter = 0;
export function nextGateId(c: ContractFile): string {
  idCounter += 1;
  return `g${c.gates.length + 1}-${idCounter}`;
}

/** The product metric: repeats against the active contract. Target 0. */
export function repeatRate(c: ContractFile): number {
  return c.repeats.length;
}
