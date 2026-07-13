/**
 * Sanity E2E (Lane D1 task item 6): the whole v3 chain wired together with a
 * fake auditor — a temp repo → a committed law with one runnable check →
 * `queueJob` + `runQueue` running the REAL `runAudit` (src/run-audit.ts), with
 * `resolveAuditor` stubbed via `VS_AUDITOR=codex` + a PATH-shim fake `codex`
 * that echoes a canned verdict JSON (the same injection pattern
 * test/resolve-auditor.test.ts uses for its auth-probe candidates).
 *
 * Asserts: a telemetry event is written, the auditor's demand is appended to
 * the law tree copy, and the "last green" law-check marker is updated (the
 * seed runnable check passed mechanically).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { tempRepo, write } from "./helpers.js";
import { queueJob, queueRoot, runQueue, lawCheckMarkerPath, type AuditJob } from "../src/audit-runner.js";
import { runAudit } from "../src/run-audit.js";
import { appendDemand, readLawTreeSync } from "../src/law.js";
import { currentTreeHash } from "../src/git.js";
import { readFirings, type Firing } from "../src/telemetry.js";

const ENV_KEYS = ["PATH", "VS_QUEUE_ROOT", "VS_TELEMETRY_PATH", "VS_DOCTOR_CACHE_PATH", "VS_AUDITOR", "VS_EXECUTOR"] as const;

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
});

async function repo(): Promise<string> {
  const { dir, cleanup } = await tempRepo();
  cleanups.push(cleanup);
  return dir;
}

/** A fake `codex` on PATH: any args, always prints one canned verdict and exits 0 —
 *  enough for both resolveAuditor's 1-token doctor probe (VS_AUDITOR bypasses that
 *  probe entirely, but the shim would satisfy it too) and the real audit invocation. */
async function shimCodex(shimDir: string, replyJson: string): Promise<void> {
  const p = join(shimDir, "codex");
  await writeFile(p, `#!/bin/sh\ncat <<'JSON'\n${replyJson}\nJSON\n`, "utf8");
  await chmod(p, 0o755);
}

describe("integration — sync enqueue → real runAudit → case law + telemetry + green marker (SPEC §2/§6.6)", () => {
  it("wires the whole chain: telemetry written, demand appended to the law tree copy, green marker updated", async () => {
    const dir = await repo();

    // A law with one runnable check that always passes, committed to HEAD —
    // loadLaw (src/law.ts) reads case law from HEAD, never the tree (R6).
    await appendDemand(dir, { run: "true", rung: "oracle", originClaim: "seed: repo builds" });
    await execa("git", ["add", "-A"], { cwd: dir });
    await execa("git", ["commit", "-q", "-m", "seed law"], { cwd: dir });

    // A Claude Code-shaped transcript: a load-bearing, oracle-needing claim
    // (SPEC §6.1's "wrote an MCCFR solver, working well" fixture).
    const transcriptPath = join(dir, "transcript.jsonl");
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "build the MCCFR solver" } }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Done — wrote an MCCFR solver, it's working well." }] },
        }),
      ].join("\n") + "\n",
    );

    const shimDir = await mkdtemp(join(tmpdir(), "vs-int-shim-"));
    const telemetryDir = await mkdtemp(join(tmpdir(), "vs-int-tel-"));
    const cacheDir = await mkdtemp(join(tmpdir(), "vs-int-cache-"));
    const queueDir = await mkdtemp(join(tmpdir(), "vs-int-queue-"));
    cleanups.push(async () => {
      await rm(shimDir, { recursive: true, force: true });
      await rm(telemetryDir, { recursive: true, force: true });
      await rm(cacheDir, { recursive: true, force: true });
      await rm(queueDir, { recursive: true, force: true });
    });

    const CANNED_REPLY = JSON.stringify({
      claims: [{ claim: "wrote an MCCFR solver, it's working well", verdict: "unsupported", basis: "no Kuhn-anchor test found", evidence: "" }],
      demands: [
        {
          origin_claim: "wrote an MCCFR solver, it's working well",
          gap: "no Kuhn-poker anchor test exists for the MCCFR solver",
          remedy: "add a Kuhn-poker anchor test for the MCCFR solver",
          accept: "computed strategy within 1e-3 of the known Kuhn equilibrium values",
          test_file: "process.exit(1);\n",
          rung: "oracle",
        },
      ],
      unaccountable: false,
      note: "",
    });
    await shimCodex(shimDir, CANNED_REPLY);

    const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
    for (const k of ENV_KEYS) {
      const v = process.env[k];
      if (v !== undefined) saved[k] = v;
    }
    process.env.PATH = `${shimDir}:/usr/bin:/bin`;
    process.env.VS_QUEUE_ROOT = queueDir;
    process.env.VS_TELEMETRY_PATH = join(telemetryDir, "telemetry.jsonl");
    process.env.VS_DOCTOR_CACHE_PATH = join(cacheDir, "doctor.json");
    process.env.VS_AUDITOR = "codex"; // stub resolveAuditor — no probe, no real CLI
    process.env.VS_EXECUTOR = "unknown";

    try {
      const job: AuditJob = { dir, sessionId: "s-int", turnRef: "t-int", mode: "live", transcriptPath };
      queueJob(dir, job);

      await runQueue(dir, runAudit);

      // 1. queue drained cleanly — no dead job (runAudit didn't throw).
      const qdir = queueRoot(dir);
      expect(existsSync(join(qdir, "dead"))).toBe(true);
      expect(readdirSync(join(qdir, "dead")).filter((f) => f.endsWith(".json"))).toHaveLength(0);

      // 2. telemetry event written (SPEC §7).
      const firings: Firing[] = readFirings();
      const auditFirings = firings.filter((f) => f.event === "audit");
      expect(auditFirings.length).toBeGreaterThanOrEqual(1);
      const last = auditFirings[auditFirings.length - 1]!;
      expect(last.verdict).toBe("unsupported");
      expect((last.law_ids ?? []).length).toBeGreaterThanOrEqual(1); // the seed mechanical check ran

      // 3. the auditor's demand materialized as a failing test in the TREE
      //    (never auto-committed — the commit is the consent checkpoint).
      const demandPath = join(dir, "test/veritaserum", "no-kuhn-poker-anchor-test-exists-for-the-mccfr-solver.js");
      expect(existsSync(demandPath)).toBe(true);
      const demandContent = readFileSync(demandPath, "utf8");
      expect(demandContent).toContain("wrote an MCCFR solver, it's working well");
      expect(demandContent).toContain("within 1e-3");

      // 4. the green marker was updated — the seed "true" check passed mechanically.
      const markerPath = lawCheckMarkerPath(dir);
      expect(existsSync(markerPath)).toBe(true);
      expect(readFileSync(markerPath, "utf8").trim()).toBe(await currentTreeHash(dir));
    } finally {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
