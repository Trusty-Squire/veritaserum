import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const RUNS = join(ROOT, ".stress", "runs");

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("production stress harness finalization", () => {
  it("materializes production-report.json when SIGTERM cuts the run short", async () => {
    const before = new Set(existsSync(RUNS) ? readdirSync(RUNS) : []);

    // GNU timeout returns 124 only when IT sends SIGTERM. If the inner process
    // exits first, timeout forwards that code — CI run 35391601643 saw 1 in
    // 7732ms (< 8s), so the 124 assertion is a race, not a finalization check.
    // Wait until main() has started (run-manifest.json), then SIGTERM the
    // process group — the same signal `timeout -s TERM` delivers — and pin
    // the reports with terminalState "terminated".
    const child = execa("pnpm", ["stress:production", "--", "--skip-live", "--keep-going"], {
      cwd: ROOT,
      reject: false,
      timeout: 120_000,
      detached: true,
      stdin: "ignore",
    });

    try {
      let runRoot = "";
      await waitFor(() => {
        const names = existsSync(RUNS) ? readdirSync(RUNS) : [];
        for (const name of names) {
          if (before.has(name)) continue;
          const candidate = join(RUNS, name);
          if (existsSync(join(candidate, "reports", "run-manifest.json"))) {
            runRoot = candidate;
            return true;
          }
        }
        return false;
      }, 20_000, "harness run-manifest.json (main started; SIGTERM handler registered)");

      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      } else {
        child.kill("SIGTERM");
      }

      const run = await child;

      const jsonLine = run.stdout
        .split("\n")
        .map((line) => {
          try {
            return JSON.parse(line) as { runRoot?: string; report?: string; terminalState?: string };
          } catch {
            return null;
          }
        })
        .find((value): value is { runRoot: string; report: string; terminalState?: string } => !!value && typeof value.runRoot === "string" && typeof value.report === "string");

      expect(runRoot).toBeTruthy();
      expect(jsonLine).toBeDefined();
      expect(existsSync(jsonLine!.report)).toBe(true);
      expect(existsSync(join(jsonLine!.runRoot, "reports", "harness-findings.json"))).toBe(true);

      const report = JSON.parse(readFileSync(jsonLine!.report, "utf8")) as { terminalState?: string; terminationSignal?: string | null };
      expect(report.terminalState).toBe("terminated");
      expect(report.terminationSignal).toBe("SIGTERM");
    } finally {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already exited */
        }
      }
    }
  }, 30_000);
});
