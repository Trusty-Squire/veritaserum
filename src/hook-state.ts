import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { queueRoot } from "./audit-runner.js";

export interface HookLawState {
  runnableCount: number;
}

export function hookLawStatePath(dir: string): string {
  return join(queueRoot(dir), "state", "law.json");
}

export function readHookLawState(dir: string): HookLawState | null {
  try {
    const value = JSON.parse(readFileSync(hookLawStatePath(dir), "utf8")) as Partial<HookLawState>;
    return typeof value.runnableCount === "number" && value.runnableCount >= 0
      ? { runnableCount: value.runnableCount }
      : null;
  } catch {
    return null;
  }
}

export function writeHookLawState(dir: string, state: HookLawState): void {
  try {
    const path = hookLawStatePath(dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state), "utf8");
  } catch {
    // State-line caching is advisory. Audit dispatch must survive its failure.
  }
}
