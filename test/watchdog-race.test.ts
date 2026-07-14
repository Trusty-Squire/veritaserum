import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");

function repoKey(repo: string): string {
  return createHash("sha256").update(resolve(repo)).digest("hex").slice(0, 16);
}

async function makeRepo(workspace: string): Promise<string> {
  const repo = join(workspace, "repo");
  mkdirSync(repo, { recursive: true });
  await execa("git", ["init", "-q"], { cwd: repo });
  await execa("git", ["config", "user.email", "watchdog-race@invalid"], { cwd: repo });
  await execa("git", ["config", "user.name", "watchdog race"], { cwd: repo });

  for (let dirIndex = 0; dirIndex < 25; dirIndex++) {
    const shard = join(repo, "src", `shard-${String(dirIndex).padStart(2, "0")}`);
    mkdirSync(shard, { recursive: true });
    for (let i = 0; i < 100; i++) {
      writeFileSync(join(shard, `file-${String(i).padStart(4, "0")}.txt`), `${"x".repeat(1024)}-${dirIndex}-${i}\n`);
    }
  }
  writeFileSync(
    join(repo, "veritaserum.law.yaml"),
    [
      "version: 1",
      "gates:",
      "  - id: race-watch",
      "    run: 'true'",
      "    gatePaths: []",
      "    lineage:",
      "      pattern: evaluator-demand",
      "      params: { rung: analytic, binding: true }",
      "      provenance: watchdog race fixture",
      "      source: evaluator-demand",
      "      retired: false",
      "repeats: []",
      "",
    ].join("\n"),
  );
  await execa("git", ["add", "-A"], { cwd: repo });
  await execa("git", ["commit", "-q", "-m", "watchdog race fixture"], { cwd: repo });
  chmodSync(join(repo, "src", "shard-24"), 0o000);
  return repo;
}

// chmod-based denial is a no-op for uid 0: the kernel ignores permission bits
// for root, so the staging failure cannot be provoked there.
const runningAsRoot = process.getuid?.() === 0;

describe("invariant watchdog demand staging", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) {
      const cleanup = cleanups.pop()!;
      try {
        cleanup();
      } catch {
        /* best-effort */
      }
    }
  });

  it.skipIf(runningAsRoot)("retries a real repo-copy failure, then escalates when demands were never inspected", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vs-watchdog-race-"));
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
    const repo = await makeRepo(workspace);
    const home = join(workspace, "home");
    const out = join(workspace, "out");
    const expected = join(workspace, "expected.jsonl");
    const baseline = join(workspace, "baseline.json");
    mkdirSync(home, { recursive: true });
    mkdirSync(out, { recursive: true });
    writeFileSync(expected, "");
    writeFileSync(baseline, JSON.stringify({ status: [] }) + "\n");

    const queueDir = join(home, ".veritaserum", "queue", repoKey(repo), "demands");
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(join(queueDir, "race-demand.cjs"), "process.exit(0);\n");

    const watchdog = await execa(
      "pnpm",
      [
        "exec",
        "tsx",
        "scripts/stress/invariant-watchdog.ts",
        "--repo",
        repo,
        "--home",
        home,
        "--out",
        out,
        "--expected",
        expected,
        "--baseline",
        baseline,
        "--once",
      ],
      { cwd: ROOT, timeout: 30_000 },
    );

    chmodSync(join(repo, "src", "shard-24"), 0o755);

    expect(watchdog.exitCode).toBe(0);
    const summary = JSON.parse(readFileSync(join(out, "watchdog-summary.json"), "utf8")) as {
      measurements: { demandStageRetries: number; demandStageFailures: number };
      invariants: { oracleInterpreterIntegrity: string };
    };
    expect(summary.measurements.demandStageRetries).toBeGreaterThan(0);
    expect(summary.measurements.demandStageFailures).toBe(1);
    // The failure is fail-open during sampling (retries + a note, exit 0) but
    // must not stay silent: demands that were queued yet never once inspected
    // surface as an oracle-integrity floor violation at finalize.
    expect(summary.invariants.oracleInterpreterIntegrity).toBe("fail");
    const violations = readFileSync(join(out, "violations.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { invariant: string; message: string });
    expect(violations.some((v) => v.invariant === "oracle-integrity" && v.message.includes("never inspected"))).toBe(true);
  }, 30_000);
});
