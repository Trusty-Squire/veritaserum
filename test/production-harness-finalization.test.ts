import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");

describe("production stress harness finalization", () => {
  it("materializes production-report.json when SIGTERM cuts the run short", async () => {
    const run = await execa(
      "timeout",
      ["-s", "TERM", "8s", "pnpm", "stress:production", "--", "--skip-live", "--keep-going"],
      {
        cwd: ROOT,
        reject: false,
        timeout: 120_000,
      },
    );

    expect(run.exitCode).toBe(124);
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

    expect(jsonLine).toBeDefined();
    expect(existsSync(jsonLine!.report)).toBe(true);
    expect(existsSync(join(jsonLine!.runRoot, "reports", "harness-findings.json"))).toBe(true);

    const report = JSON.parse(readFileSync(jsonLine!.report, "utf8")) as { terminalState?: string; terminationSignal?: string | null };
    expect(report.terminalState).toBe("terminated");
    expect(report.terminationSignal).toBe("SIGTERM");
  }, 30_000);
});
