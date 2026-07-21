/**
 * Sanity E2E: the whole v3 chain wired together with a fake auditor — a temp
 * repo → `queueJob` + `runQueue` running the REAL `runAudit` (src/run-audit.ts),
 * with `resolveAuditor` stubbed via `VS_AUDITOR=codex` + a PATH-shim fake `codex`
 * that echoes a canned verdict JSON (the same injection pattern
 * test/resolve-auditor.test.ts uses for its auth-probe candidates).
 *
 * Asserts: the queue drains cleanly (no dead job) and a telemetry audit event is
 * written with the auditor's verdict. The auditor is stateless per turn now — no
 * case law, no demands, no green marker (see SPEC.md "2026-07-20: case law removed").
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempRepo } from "./helpers.js";
import { queueJob, queueRoot, runQueue, type AuditJob } from "../src/audit-runner.js";
import { runAudit } from "../src/run-audit.js";
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

/** A fake `codex` on PATH: any args, always prints one canned verdict and exits 0. */
async function shimCodex(shimDir: string, replyJson: string): Promise<void> {
  const p = join(shimDir, "codex");
  await writeFile(p, `#!/bin/sh\ncat <<'JSON'\n${replyJson}\nJSON\n`, "utf8");
  await chmod(p, 0o755);
}

describe("integration — sync enqueue → real runAudit → telemetry (SPEC §2/§6.6)", () => {
  it("wires the whole chain: queue drains cleanly and a telemetry audit event is written", async () => {
    const dir = await repo();

    // A Claude Code-shaped transcript: a load-bearing, verification-needing claim.
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

      // 2. telemetry event written (SPEC §7) with the auditor's verdict.
      const firings: Firing[] = readFirings();
      const auditFirings = firings.filter((f) => f.event === "audit");
      expect(auditFirings.length).toBeGreaterThanOrEqual(1);
      const last = auditFirings[auditFirings.length - 1]!;
      expect(last.verdict).toBe("unsupported");

      // 3. nothing landed in the user's repo — the auditor is stateless per turn.
      expect(existsSync(join(dir, "veritaserum.law.yaml"))).toBe(false);
    } finally {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
